import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { sharedProjectDirectory } from "@/projects/projects-root";

type DirectoryClient = Pick<DaemonClient, "browseProjectDirectories" | "getLastServerInfoMessage">;

interface DirectoryResolution {
  source: DirectoryClient;
  destination: DirectoryClient;
  directory: string;
}

/**
 * The exact source folder in the destination, including worktree suffixes. Inside a shared
 * Projects folder the path is identical; legacy daemons map it through a shared host path.
 */
export async function resolveTaskDirectory(input: DirectoryResolution): Promise<string | null> {
  const shared = sharedProjectDirectory({
    source: input.source.getLastServerInfoMessage(),
    destination: input.destination.getLastServerInfoMessage(),
    directory: input.directory,
  });
  if (shared) return shared;
  // COMPAT(projectsRoot): added 2026-10-22; daemons without a shared Projects folder map
  // folders through browse roots. Remove after 2027-04-22 with the projectsRoot gate.
  const browse = await input.source.browseProjectDirectories({});
  if (browse.error) throw new Error(browse.error);
  const roots = browse.roots.filter((root) => {
    const prefix = root.containerPath.replace(/\/$/, "");
    return (
      root.hostPath && (input.directory === prefix || input.directory.startsWith(`${prefix}/`))
    );
  });
  roots.sort((a, b) => b.containerPath.length - a.containerPath.length);
  const root = roots[0];
  if (!root?.hostPath) return null;
  const relative = input.directory.slice(root.containerPath.replace(/\/$/, "").length);
  const target = await input.destination.browseProjectDirectories({
    hostPath: root.hostPath.replace(/\/$/, "") + relative,
  });
  if (target.error) return null;
  return target.directory?.containerPath ?? null;
}

interface ProjectPlacementDirectory {
  source: DirectoryClient;
  directory: string;
}

/**
 * The destination folder for a project placed only in other environments, when every
 * reachable placement agrees on it. Null means the owner has to choose the folder.
 */
export async function resolveProjectDirectory(input: {
  placements: readonly ProjectPlacementDirectory[];
  destination: DirectoryClient;
}): Promise<string | null> {
  const matches = new Set<string>();
  for (const placement of input.placements) {
    try {
      const mapped = await resolveTaskDirectory({ ...placement, destination: input.destination });
      if (mapped) matches.add(mapped);
    } catch {
      // An unavailable source cannot establish a mapping. Let the owner choose
      // the destination folder rather than guessing from another environment.
    }
  }
  return matches.size === 1 ? [...matches][0]! : null;
}
