import { useCallback, useMemo, useState } from "react";
import { View } from "react-native";
import { useMutation } from "@tanstack/react-query";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/select-field";
import { useHostProjects } from "@/projects/host-projects";
import { useWorkspaceDirectoryServerIds } from "@/stores/session-store-hooks";
import { useHostRuntimeClient, useHosts } from "@/runtime/host-runtime";
import { useHostFeature } from "@/runtime/host-features";
import { useProjectMoveRequest } from "./request";

export function ProjectMoveModalHost() {
  const request = useProjectMoveRequest((state) => state.request);
  return request ? (
    <ProjectMoveModal key={`${request.serverId}:${request.workspaceId}`} {...request} />
  ) : null;
}

function ProjectMoveModal({
  serverId,
  workspaceId,
  projectKey,
}: {
  serverId: string;
  workspaceId: string;
  projectKey?: string;
}) {
  const hosts = useHosts();
  const hostIds = useMemo(() => hosts.map((host) => host.serverId), [hosts]);
  const serverIds = useWorkspaceDirectoryServerIds(hostIds);
  const projects = useHostProjects(serverIds);
  const [selected, setSelected] = useState(
    () => projects.find((project) => project.viewKey === projectKey) ?? null,
  );
  const client = useHostRuntimeClient(serverId);
  const supported = useHostFeature(serverId, "workspaceProjectMembership");
  const close = useProjectMoveRequest((state) => state.close);
  const { mutate, reset, isPending, error } = useMutation({
    mutationFn: async () => {
      if (!client) throw new Error("Reconnect to move this workspace.");
      if (!selected) throw new Error("Select a project.");
      await client.setWorkspaceProject({
        workspaceId,
        membership: { key: selected.viewKey, name: selected.projectName },
      });
    },
    onSuccess: close,
  });
  const options = useMemo(
    () =>
      projects.map((project) => ({
        id: project.viewKey,
        value: project.viewKey,
        label: project.projectName,
      })),
    [projects],
  );
  const select = useCallback(
    (key: string) => {
      setSelected(projects.find((project) => project.viewKey === key) ?? null);
      reset();
    },
    [projects, reset],
  );
  const dismiss = useCallback(() => {
    if (!isPending) close();
  }, [isPending, close]);
  const header = useMemo(() => ({ title: "Move to project" }), []);
  const submit = useCallback(() => mutate(), [mutate]);
  const selectedDisplay = useMemo(
    () => (selected ? { label: selected.projectName } : null),
    [selected],
  );
  const footer = useMemo(
    () => (
      <View style={styles.actions}>
        <Button variant="ghost" onPress={dismiss} disabled={isPending}>
          Cancel
        </Button>
        <Button
          onPress={submit}
          disabled={!supported || !selected || isPending}
          testID="project-move-confirm"
        >
          {isPending ? "Moving..." : "Move workspace"}
        </Button>
      </View>
    ),
    [dismiss, isPending, submit, supported, selected],
  );
  return (
    <AdaptiveModalSheet
      visible
      header={header}
      footer={footer}
      onClose={dismiss}
      testID="project-move-modal"
    >
      <View style={styles.body}>
        <SelectField
          label="Project"
          value={selected?.viewKey ?? ""}
          selectedDisplay={selectedDisplay}
          options={options}
          onChange={select}
          searchable
          size="md"
          placeholder="Select project"
          emptyText="No projects available"
          disabled={isPending}
          triggerTestID="project-move-project"
        />
        {!supported ? (
          <Alert variant="warning" title="Update this environment to move workspaces." />
        ) : null}
        {error ? <Alert variant="error" title={error.message} /> : null}
      </View>
    </AdaptiveModalSheet>
  );
}
const styles = StyleSheet.create((theme) => ({
  body: { padding: theme.spacing[4], gap: theme.spacing[3] },
  actions: { flexDirection: "row", justifyContent: "flex-end", gap: theme.spacing[2] },
}));
