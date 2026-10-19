import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";

interface DirectoryResolution {
  source: Pick<DaemonClient, "browseProjectDirectories">;
  destination: Pick<DaemonClient, "browseProjectDirectories">;
  directory: string;
}

/** Map the exact source folder through a shared host path, including worktree suffixes. */
export async function resolveTaskDirectory(input: DirectoryResolution): Promise<string | null> {
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
