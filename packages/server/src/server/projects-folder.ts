// The installation's Projects folder: one directory that holds every newly added,
// created or cloned project, at the same absolute path on the Host and in the Dev
// container. Installers write `$PASEO_HOME/projects-folder.json`; `PASEO_PROJECTS_ROOT`
// overrides its root (container installs set it in Compose). See
// docs/execution-installation.md#projects-folder.
//
// The root is the folder's logical path. A Dev container may reach it through a symlink
// to its older mount, so realpath and getcwd there return the physical alias instead.
// Every path the daemon records or compares goes through `logicalProjectsPath` first.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { expandTilde, isPathInsideRoot } from "../utils/path.js";

export const PROJECTS_FOLDER_SETTINGS_FILE = "projects-folder.json";
/** Paseo-owned worktrees for user projects live here, hidden from the folder browser. */
export const PROJECTS_FOLDER_STATE_DIRECTORY = ".vorteo";

/** Unknown keys are ignored so a newer file never stops an older daemon. */
const ProjectsFolderSettingsSchema = z
  .object({
    root: z.string().min(1).optional(),
    /** Earlier absolute paths of the same folder. Treated as aliases. */
    migrateFrom: z.array(z.string().min(1)).optional(),
    /** Other absolute paths that reach the same folder, such as its physical mount. */
    aliases: z.array(z.string().min(1)).optional(),
    /** Folders outside the root that may still hold new projects, such as installation worktrees. */
    allowOutside: z.array(z.string().min(1)).optional(),
    /**
     * Exact recorded paths left as they are, such as a project root that an older Factory
     * binding compares by string. Paths below them still map.
     */
    keepPaths: z.array(z.string().min(1)).optional(),
  })
  .passthrough();

export interface ProjectsFolderConfig {
  /** Logical absolute path of the Projects folder, identical on the Host and in Dev. */
  root: string;
  /**
   * Other absolute paths of the same folder: configured aliases, earlier locations and the
   * root's real path when a symlink leads to it. Paths under them map to `root`.
   */
  aliases: string[];
  allowOutside: string[];
  /** Exact recorded paths that are never rewritten to the logical root. */
  keepPaths?: string[];
}

export type ProjectsFolderRejection = "outside_projects_folder" | "projects_folder_root";

export class ProjectsFolderError extends Error {
  constructor(
    readonly code: ProjectsFolderRejection,
    message: string,
  ) {
    super(message);
    this.name = "ProjectsFolderError";
  }
}

interface ResolveProjectsFolderInput {
  paseoHome: string;
  env: NodeJS.ProcessEnv;
  warn?: (message: string) => void;
}

/** Reads the configured Projects folder, or null when this daemon has none. */
export function resolveProjectsFolderConfig(
  input: ResolveProjectsFolderInput,
): ProjectsFolderConfig | null {
  const settings = readSettings(input);
  const configuredRoot = input.env.PASEO_PROJECTS_ROOT?.trim() || settings.root?.trim();
  if (!configuredRoot) return null;
  const root = absolutePath(configuredRoot);
  if (!root) {
    input.warn?.(`Ignoring the Projects folder "${configuredRoot}": use an absolute path`);
    return null;
  }
  const absoluteList = (values: string[] | undefined) =>
    (values ?? []).flatMap((value) => {
      const resolved = absolutePath(value);
      return resolved && resolved !== root ? [resolved] : [];
    });
  const physicalRoot = canonicalPathSync(root);
  const aliases = [
    ...absoluteList(settings.aliases),
    ...absoluteList(settings.migrateFrom),
    ...(physicalRoot === root ? [] : [physicalRoot]),
  ];
  const keepPaths = absoluteList(settings.keepPaths);
  return {
    root,
    aliases: [...new Set(aliases)],
    allowOutside: absoluteList(settings.allowOutside).map(canonicalPathSync),
    ...(keepPaths.length > 0 ? { keepPaths } : {}),
  };
}

/**
 * Maps a path equal to or under one of the folder's aliases to the same place under its
 * logical root. Other paths, and exact matches of `keepPaths`, are returned unchanged.
 * Purely lexical: callers that need the real location resolve symlinks before mapping.
 */
export function toLogicalProjectsPath(
  config: Pick<ProjectsFolderConfig, "root" | "aliases" | "keepPaths">,
  value: string,
): string {
  if (config.keepPaths?.includes(value)) return value;
  for (const alias of aliasesLongestFirst(config.aliases)) {
    if (value === alias) return config.root;
    if (value.startsWith(`${alias}/`))
      return path.posix.join(config.root, value.slice(alias.length));
  }
  return value;
}

function aliasesLongestFirst(aliases: readonly string[]): string[] {
  return aliases
    .map((alias) => alias.replace(/\/+$/u, ""))
    .filter((alias) => alias.length > 0)
    .toSorted((left, right) => right.length - left.length);
}

/** Rewrites the path inside a local project key (`host:<serverId>:<path>` or a bare path). */
export function toLogicalProjectKey(
  config: Pick<ProjectsFolderConfig, "root" | "aliases" | "keepPaths">,
  key: string,
): string {
  const match = /^(host:[^:]+:)?(\/.*)$/u.exec(key);
  if (!match?.[2]) return key;
  return `${match[1] ?? ""}${toLogicalProjectsPath(config, match[2])}`;
}

// One daemon serves one installation, and paths reach it through many modules (registries,
// git discovery, worktree creation), so the daemon's folder is held here once at startup.
let activeProjectsFolder: ProjectsFolderConfig | null = null;

/** Called once at daemon startup, before any registry loads. Undefined clears it. */
export function setActiveProjectsFolder(config: ProjectsFolderConfig | undefined): void {
  activeProjectsFolder = config ?? null;
}

/** This daemon's Projects folder, or null when it has none. */
export function activeProjectsFolderConfig(): ProjectsFolderConfig | null {
  return activeProjectsFolder;
}

/** The logical form of `value` under this daemon's Projects folder, or `value` itself. */
export function logicalProjectsPath(value: string): string {
  return activeProjectsFolder ? toLogicalProjectsPath(activeProjectsFolder, value) : value;
}

/** Like `logicalProjectsPath`, for nullable values. */
export function logicalProjectsPathOrNull(value: string | null): string | null {
  return value === null ? null : logicalProjectsPath(value);
}

/** The logical form of a local project key under this daemon's Projects folder. */
export function logicalProjectKey(key: string | null): string | null {
  return key && activeProjectsFolder ? toLogicalProjectKey(activeProjectsFolder, key) : key;
}

function readSettings(
  input: ResolveProjectsFolderInput,
): z.infer<typeof ProjectsFolderSettingsSchema> {
  const file = path.join(input.paseoHome, PROJECTS_FOLDER_SETTINGS_FILE);
  if (!existsSync(file)) return {};
  try {
    const parsed = ProjectsFolderSettingsSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    if (parsed.success) return parsed.data;
    input.warn?.(`Ignoring invalid Projects folder settings in ${file}`);
  } catch (error) {
    input.warn?.(
      `Could not read Projects folder settings in ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return {};
}

function absolutePath(value: string): string | null {
  const expanded = expandTilde(value.trim());
  return path.isAbsolute(expanded) ? path.resolve(expanded) : null;
}

function canonicalPathSync(value: string): string {
  try {
    return realpathSync(value);
  } catch {
    return value;
  }
}

/** Where Paseo-owned worktrees go when the installation has a Projects folder. */
export function projectsFolderWorktreesRoot(config: ProjectsFolderConfig): string {
  return path.join(config.root, PROJECTS_FOLDER_STATE_DIRECTORY, "worktrees");
}

/** True when the canonical candidate is the root itself or inside it. */
function isWithin(root: string, candidate: string): boolean {
  return isPathInsideRoot(root, candidate);
}

function isStrictlyWithin(root: string, candidate: string): boolean {
  return isWithin(root, candidate) && path.relative(root, candidate) !== "";
}

/** Resolves symlinks in the deepest existing ancestor, so a missing child cannot hide an escape. */
async function canonicalizeExistingPrefix(candidate: string): Promise<string> {
  const missing: string[] = [];
  let current = candidate;
  for (;;) {
    try {
      const resolved = await realpath(current);
      return missing.length ? path.join(resolved, ...missing.toReversed()) : resolved;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      const parent = path.dirname(current);
      if (parent === current) return candidate;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

function outsideMessage(root: string): string {
  return `Choose a folder inside the Projects folder (${root}).`;
}

export interface ProjectsFolderPolicy {
  readonly config: ProjectsFolderConfig;
  /**
   * Rejects a directory that would become a new project unless its real path is strictly
   * inside the Projects folder. Existing registrations stay usable wherever they are.
   */
  assertNewProjectDirectory(directory: string, known: KnownProjectPaths): Promise<void>;
  /** Rejects a parent folder for a new folder or clone unless it is inside the Projects folder. */
  assertParentDirectory(directory: string): Promise<void>;
}

export interface KnownProjectPaths {
  /** Project roots and workspace directories already registered on this daemon. */
  paths: Iterable<string>;
}

/** The policy for an optional Projects folder; null when the daemon has none. */
export function projectsFolderPolicyFor(
  config: ProjectsFolderConfig | undefined,
): ProjectsFolderPolicy | null {
  return config ? createProjectsFolderPolicy(config) : null;
}

export function createProjectsFolderPolicy(input: ProjectsFolderConfig): ProjectsFolderPolicy {
  const config: ProjectsFolderConfig = {
    ...input,
    allowOutside: input.allowOutside.map(canonicalPathSync),
  };
  // Containment compares real paths, so a symlink out of the folder or its aliases is caught.
  const physicalRoot = canonicalPathSync(config.root);
  const allowed = (canonical: string) =>
    isStrictlyWithin(physicalRoot, canonical) ||
    config.allowOutside.some((root) => isWithin(root, canonical));

  return {
    config,
    async assertNewProjectDirectory(directory, known) {
      const requested = path.resolve(expandTilde(directory));
      const canonical = await canonicalizeExistingPrefix(requested);
      const lexical = toLogicalProjectsPath(config, requested);
      const logical = toLogicalProjectsPath(config, canonical);
      for (const knownPath of known.paths) {
        const resolved = toLogicalProjectsPath(config, path.resolve(knownPath));
        if (resolved === lexical || resolved === logical) return;
      }
      if (logical === config.root || lexical === config.root) {
        throw new ProjectsFolderError(
          "projects_folder_root",
          "The Projects folder itself cannot be a project. Choose or create a folder inside it.",
        );
      }
      if (!allowed(canonical))
        throw new ProjectsFolderError("outside_projects_folder", outsideMessage(config.root));
    },
    async assertParentDirectory(directory) {
      const canonical = await canonicalizeExistingPrefix(path.resolve(expandTilde(directory)));
      if (isWithin(physicalRoot, canonical) || allowed(canonical)) return;
      throw new ProjectsFolderError("outside_projects_folder", outsideMessage(config.root));
    },
  };
}

/** True when `directory` holds a git checkout marker. */
export async function hasGitMarker(directory: string): Promise<boolean> {
  return stat(path.join(directory, ".git")).then(
    () => true,
    () => false,
  );
}
