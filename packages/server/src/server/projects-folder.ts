// The installation's Projects folder: one directory that holds every newly added,
// created or cloned project, at the same absolute path on the Host and in the Dev
// container. Installers write `$PASEO_HOME/projects-folder.json`; `PASEO_PROJECTS_ROOT`
// overrides its root (container installs set it in Compose). See
// docs/execution-installation.md#projects-folder.
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
    /** Earlier absolute paths of the same folder; registry paths under them are rewritten once. */
    migrateFrom: z.array(z.string().min(1)).optional(),
    /** Folders outside the root that may still hold new projects, such as installation worktrees. */
    allowOutside: z.array(z.string().min(1)).optional(),
  })
  .passthrough();

export interface ProjectsFolderConfig {
  /** Canonical absolute path of the Projects folder. */
  root: string;
  migrateFrom: string[];
  allowOutside: string[];
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
  return {
    root: canonicalPathSync(root),
    migrateFrom: absoluteList(settings.migrateFrom),
    allowOutside: absoluteList(settings.allowOutside).map(canonicalPathSync),
  };
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
    root: canonicalPathSync(input.root),
    allowOutside: input.allowOutside.map(canonicalPathSync),
  };
  const allowed = (canonical: string) =>
    isStrictlyWithin(config.root, canonical) ||
    config.allowOutside.some((root) => isWithin(root, canonical));

  return {
    config,
    async assertNewProjectDirectory(directory, known) {
      const lexical = path.resolve(expandTilde(directory));
      const canonical = await canonicalizeExistingPrefix(lexical);
      for (const knownPath of known.paths) {
        const resolved = path.resolve(knownPath);
        if (resolved === lexical || resolved === canonical) return;
      }
      if (canonical === config.root || lexical === config.root) {
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
      if (isWithin(config.root, canonical) || allowed(canonical)) return;
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
