import { readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import type {
  ProjectDirectoryBrowseRequest,
  ProjectDirectoryBrowsePayload,
} from "@getpaseo/protocol/messages";
import { isPathInsideRoot } from "../utils/path.js";
import {
  hasGitMarker,
  logicalProjectsPath,
  PROJECTS_FOLDER_STATE_DIRECTORY,
} from "./projects-folder.js";

const HostFilesystemSchema = z.object({
  version: z.literal(1),
  hostHome: z.string(),
  shares: z.array(z.object({ id: z.string(), hostPath: z.string(), containerPath: z.string() })),
});
type HostFilesystem = z.infer<typeof HostFilesystemSchema>;
interface DirectoryEnvironment {
  home: string;
  container: boolean;
  config: HostFilesystem | null;
  mountPaths: Set<string>;
  /** The installation's Projects folder. When set it is the only browsable root. */
  projectsRoot?: string | null;
  /** Registered project roots by path, so Projects folder listings can mark them. */
  projectIdsByPath?: ReadonlyMap<string, string>;
}

export const PROJECTS_ROOT_ID = "projects";

class DirectoryBrowseError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function projectDirectoryEnvironment(
  projects: Pick<DirectoryEnvironment, "projectsRoot" | "projectIdsByPath"> = {},
): Promise<DirectoryEnvironment> {
  const raw = process.env.PASEO_HOST_FILESYSTEM;
  const config = raw ? HostFilesystemSchema.parse(JSON.parse(raw)) : null;
  const container =
    process.env.PASEO_CONTAINER === "true" ||
    (await stat("/.dockerenv").then(
      () => true,
      () => false,
    ));
  const mountPaths = new Set<string>();
  if (container) {
    const mounts = await readFile("/proc/self/mountinfo", "utf8");
    for (const line of mounts.split("\n")) {
      const target = line.split(" ")[4];
      if (target)
        mountPaths.add(
          target.replace(/\\([0-7]{3})/g, (_, digits: string) =>
            String.fromCharCode(parseInt(digits, 8)),
          ),
        );
    }
  }
  return { home: homedir(), container, config, mountPaths, ...projects };
}

export async function browseProjectDirectories(
  request: ProjectDirectoryBrowseRequest,
  environment: DirectoryEnvironment,
): Promise<ProjectDirectoryBrowsePayload> {
  const projectsRoot = environment.projectsRoot ?? null;
  const roots = projectsRoot ? projectsFolderRoots(projectsRoot) : legacyRoots(environment);
  const base = {
    roots,
    directory: null,
    error: null,
    errorCode: null,
    requestId: request.requestId,
  };
  try {
    const { rootId, relativePath } = resolveBrowseLocation(request, environment, roots);
    if (!rootId) return base;
    const root = roots.find((candidate) => candidate.id === rootId);
    if (!root)
      throw new DirectoryBrowseError(
        "unknown_root",
        "This shared folder is no longer configured. Refresh the folder list.",
      );
    assertSharedRootMounted(root, environment);
    const rootPath = await realpath(root.containerPath);
    const requested = path.resolve(root.containerPath, relativePath);
    if (!isPathInsideRoot(root.containerPath, requested))
      throw new DirectoryBrowseError(
        "outside_root",
        "Choose a directory inside this shared folder.",
      );
    const canonical = await realpath(requested);
    if (!isPathInsideRoot(rootPath, canonical))
      throw new DirectoryBrowseError(
        "outside_root",
        "This symlink leaves the shared folder. Share its target separately on the host.",
      );
    if (!(await stat(canonical)).isDirectory())
      throw new DirectoryBrowseError("not_directory", "This path is not a directory.");
    const visibleRelative = path.relative(root.containerPath, requested) || ".";
    const entries = await listBrowsableChildren({
      requested,
      rootPath,
      visibleRelative,
      showHidden: request.showHidden === true,
      // Paseo-owned worktrees live in the Projects folder's state directory; never offer it.
      hiddenNames: projectsRoot && visibleRelative === "." ? [PROJECTS_FOLDER_STATE_DIRECTORY] : [],
      projectIdsByPath: projectsRoot ? environment.projectIdsByPath : undefined,
    });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    const offset = request.offset ?? 0;
    const nextOffset = offset + 100 < entries.length ? offset + 100 : null;
    return {
      ...base,
      directory: {
        rootId,
        path: visibleRelative,
        parent: visibleRelative === "." ? null : path.dirname(visibleRelative),
        containerPath: requested,
        hostPath: root.hostPath ? path.resolve(root.hostPath, visibleRelative) : null,
        entries: entries.slice(offset, offset + 100),
        nextOffset,
      },
    };
  } catch (error) {
    return { ...base, ...browseError(error) };
  }
}

// Shared folders are their own mounts; the Projects folder may sit inside a larger one.
function assertSharedRootMounted(
  root: ProjectDirectoryBrowsePayload["roots"][number],
  environment: DirectoryEnvironment,
): void {
  if (environment.projectsRoot || !environment.container || !root.hostPath) return;
  if (environment.mountPaths.has(root.containerPath)) return;
  throw new DirectoryBrowseError(
    "mount_unavailable",
    "The shared folder is not mounted. Apply the pending shared-folder configuration on the host.",
  );
}

function projectsFolderRoots(projectsRoot: string): ProjectDirectoryBrowsePayload["roots"] {
  // The Projects folder has the same path on the Host and in the Dev container.
  return [
    {
      id: PROJECTS_ROOT_ID,
      label: "Projects",
      containerPath: projectsRoot,
      hostPath: projectsRoot,
    },
  ];
}

function legacyRoots(environment: DirectoryEnvironment): ProjectDirectoryBrowsePayload["roots"] {
  const { home, container, config } = environment;
  const roots: ProjectDirectoryBrowsePayload["roots"] = (config?.shares ?? []).map((share) => ({
    id: share.id,
    label: path.basename(share.hostPath),
    containerPath: share.containerPath,
    hostPath: share.hostPath,
  }));
  roots.push({
    id: "home",
    label: container ? "Container home" : "Home",
    containerPath: home,
    hostPath: container ? null : home,
  });
  if (container)
    roots.push({
      id: "workspace",
      label: "Container workspace",
      containerPath: "/workspace",
      hostPath: null,
    });
  return roots;
}

function resolveBrowseLocation(
  request: ProjectDirectoryBrowseRequest,
  environment: DirectoryEnvironment,
  roots: ProjectDirectoryBrowsePayload["roots"],
) {
  // With a Projects folder there is nothing above it to list.
  let rootId = request.rootId ?? (environment.projectsRoot ? PROJECTS_ROOT_ID : undefined);
  const { config, container, home } = environment;
  let relativePath = request.path ?? ".";
  if (request.hostPath !== undefined) {
    let hostPath = request.hostPath.trim();
    const hostHome = config?.hostHome ?? (container ? null : home);
    if (hostPath === "~" || hostPath.startsWith("~/")) {
      if (!hostHome)
        throw new DirectoryBrowseError(
          "not_shared",
          "Host folders are not configured. Run share-folder.sh on the host to share this folder, then apply the change when active tasks can be interrupted.",
        );
      hostPath = path.resolve(hostHome, hostPath.slice(2));
    }
    if (!path.isAbsolute(hostPath))
      throw new DirectoryBrowseError(
        "invalid_path",
        "Enter an absolute host path or a path starting with ~/.",
      );
    // A path through a Projects folder alias browses the same folder.
    hostPath = logicalProjectsPath(path.normalize(hostPath));
    const root = roots
      .filter((candidate) => candidate.hostPath && isPathInsideRoot(candidate.hostPath, hostPath))
      .sort((a, b) => (b.hostPath?.length ?? 0) - (a.hostPath?.length ?? 0))[0];
    if (!root?.hostPath)
      throw new DirectoryBrowseError(
        "not_shared",
        environment.projectsRoot
          ? `Choose a folder inside the Projects folder (${environment.projectsRoot}).`
          : "This host folder is not shared with this instance. Run share-folder.sh on the host, then apply the change when active tasks can be interrupted.",
      );
    rootId = root.id;
    relativePath = path.relative(root.hostPath, hostPath);
  }
  return { rootId, relativePath };
}

interface ChildListingInput {
  requested: string;
  rootPath: string;
  visibleRelative: string;
  showHidden: boolean;
  hiddenNames: string[];
  /** When set, entries are marked as git checkouts and registered projects. */
  projectIdsByPath: ReadonlyMap<string, string> | undefined;
}

async function listBrowsableChildren(input: ChildListingInput) {
  const entries: NonNullable<ProjectDirectoryBrowsePayload["directory"]>["entries"] = [];
  const children = await readdir(input.requested, { withFileTypes: true });
  for (const child of children) {
    if (!input.showHidden && child.name.startsWith(".")) continue;
    if (input.hiddenNames.includes(child.name)) continue;
    const childPath = path.join(input.requested, child.name);
    const isDirectory =
      child.isDirectory() ||
      (child.isSymbolicLink() && (await isBrowsableSymlink(childPath, input.rootPath)));
    if (!isDirectory) continue;
    const entry: (typeof entries)[number] = {
      name: child.name,
      path: path.join(input.visibleRelative, child.name),
    };
    if (input.projectIdsByPath) {
      entry.git = await hasGitMarker(childPath);
      const projectId = input.projectIdsByPath.get(childPath);
      if (projectId) entry.projectId = projectId;
    }
    entries.push(entry);
  }
  return entries;
}

async function isBrowsableSymlink(candidate: string, rootPath: string): Promise<boolean> {
  try {
    const target = await realpath(candidate);
    return isPathInsideRoot(rootPath, target) && (await stat(target)).isDirectory();
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      ["ENOENT", "EACCES", "EPERM", "ELOOP"].includes(String(error.code))
    )
      return false;
    throw error;
  }
}

function browseError(error: unknown): Pick<ProjectDirectoryBrowsePayload, "error" | "errorCode"> {
  if (error instanceof DirectoryBrowseError) return { error: error.message, errorCode: error.code };
  const code = error instanceof Error && "code" in error ? error.code : null;
  if (code === "ENOENT")
    return {
      error: "Directory not found in this shared folder. Check the spelling and capitalization.",
      errorCode: "not_found",
    };
  if (code === "EACCES" || code === "EPERM")
    return {
      error:
        "The container user cannot read this directory. Check host sharing and directory permissions.",
      errorCode: "permission_denied",
    };
  return { error: "Unable to read this directory.", errorCode: "filesystem_error" };
}
