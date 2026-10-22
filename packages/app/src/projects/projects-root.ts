/**
 * The installation Projects folder. When two daemons advertise it at the same absolute path,
 * a project path inside it names the same folder in both environments, so no folder mapping,
 * prompt or path translation is needed.
 */
export interface ProjectsRootAdvertisement {
  projectsRoot?: string;
  features?: { projectsRoot?: boolean } | null;
}

export function advertisedProjectsRoot(
  serverInfo: ProjectsRootAdvertisement | null | undefined,
): string | null {
  if (serverInfo?.features?.projectsRoot !== true || !serverInfo.projectsRoot) return null;
  return trimTrailingSeparators(serverInfo.projectsRoot);
}

/** The Projects folder both daemons share at the identical path, or null for legacy daemons. */
export function sharedProjectsRoot(
  left: ProjectsRootAdvertisement | null | undefined,
  right: ProjectsRootAdvertisement | null | undefined,
): string | null {
  const leftRoot = advertisedProjectsRoot(left);
  return leftRoot !== null && leftRoot === advertisedProjectsRoot(right) ? leftRoot : null;
}

export function isInsideProjectsRoot(path: string, root: string): boolean {
  return trimTrailingSeparators(path).startsWith(`${root}/`);
}

/** The same path in the destination when both daemons share the Projects folder holding it. */
export function sharedProjectDirectory(input: {
  source: ProjectsRootAdvertisement | null | undefined;
  destination: ProjectsRootAdvertisement | null | undefined;
  directory: string;
}): string | null {
  const root = sharedProjectsRoot(input.source, input.destination);
  if (root === null || !isInsideProjectsRoot(input.directory, root)) return null;
  return trimTrailingSeparators(input.directory);
}

function trimTrailingSeparators(path: string): string {
  const trimmed = path.replace(/\/+$/u, "");
  return trimmed || "/";
}
