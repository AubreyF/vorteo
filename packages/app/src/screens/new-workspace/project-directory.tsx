import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { ProjectDirectoryBrowser } from "@/components/project-directory-browser";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { resolveProjectDirectory } from "@/task-environments/directory";
import type { HostProjectListItem } from "@/projects/host-project-model";

// A logical project without a placement in this environment uses the identical path when both
// daemons share the Projects folder; the destination then adds the project on demand.
// COMPAT(projectsRoot): added 2026-10-22. Daemons without a shared Projects folder fall back to
// path mapping and, failing that, the folder browser. Remove after 2027-04-22.
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
    const placements = project.hosts.flatMap((placement) => {
      const source = getHostRuntimeStore().getClient(placement.serverId);
      return source ? [{ source, directory: placement.iconWorkingDir }] : [];
    });
    const mapped = await resolveProjectDirectory({ placements, destination: client });
    if (mapped) return mapped;
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
