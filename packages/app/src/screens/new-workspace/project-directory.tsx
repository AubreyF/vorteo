import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { ProjectDirectoryBrowser } from "@/components/project-directory-browser";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { resolveTaskDirectory } from "@/task-environments/directory";
import type { HostProjectListItem } from "@/projects/host-project-model";

// Reuse the folder browser when a logical project has no placement in this environment.
// Selection alone never creates a project, workspace or agent.
export function useNewWorkspaceProjectDirectory() {
  const [request, setRequest] = useState<{ client: DaemonClient; name: string } | null>(null);
  const pending = useRef<((directory: string | null) => void) | null>(null);
  const choose = useCallback((directory: string | null) => {
    pending.current?.(directory);
    pending.current = null;
    setRequest(null);
  }, []);
  const cancel = useCallback(() => choose(null), [choose]);
  useEffect(() => () => pending.current?.(null), []);
  const resolve = useCallback(async (project: HostProjectListItem, client: DaemonClient) => {
    const matches = new Set<string>();
    for (const placement of project.hosts) {
      const source = getHostRuntimeStore().getClient(placement.serverId);
      if (!source) continue;
      try {
        const mapped = await resolveTaskDirectory({
          source,
          destination: client,
          directory: placement.iconWorkingDir,
        });
        if (mapped) matches.add(mapped);
      } catch {
        // An unavailable source cannot establish a mapping. Let the owner choose
        // the destination folder rather than guessing from another environment.
      }
    }
    if (matches.size === 1) return [...matches][0]!;
    const directory = await new Promise<string | null>((resolveChoice) => {
      pending.current = resolveChoice;
      setRequest({ client, name: project.projectName });
    });
    if (!directory) throw new Error("Folder selection cancelled. Your draft is preserved.");
    return directory;
  }, []);
  const header = useMemo(
    () => ({ title: `Choose folder for ${request?.name ?? "project"}` }),
    [request?.name],
  );
  return {
    resolve,
    sheet: request ? (
      <AdaptiveModalSheet visible header={header} onClose={cancel}>
        <ProjectDirectoryBrowser client={request.client} onSelect={choose} />
      </AdaptiveModalSheet>
    ) : null,
  };
}
