import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { WorkspaceProjectDescriptorPayload } from "@getpaseo/protocol/messages";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeIsConnected, useHosts } from "@/runtime/host-runtime";
import { useHostFeature } from "@/runtime/host-features";
import { useVortonMode } from "@/vorton-mode";
import { AddProjectFlow } from "@/components/add-project-flow";
import { SelectField } from "@/components/ui/select-field";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Button } from "@/components/ui/button";
import { readDestinationWorkspaces } from "./internal/destination-workspaces";
import {
  newDestinationSelection,
  selectDestinationProject,
  type DestinationSelection,
} from "./internal/destination-selection";

interface Props {
  serverId: string;
  selection: DestinationSelection;
  onChange: (selection: DestinationSelection) => void;
  disabled: boolean;
}

const destinationOptions = [
  { value: "new", label: "New workspace", testID: "preset-destination-new" },
  { value: "existing", label: "Existing workspace", testID: "preset-destination-existing" },
];
const checkoutOptions = [
  { value: "directory", label: "Local directory" },
  { value: "worktree", label: "New worktree" },
];

function useDestinationCatalog(serverId: string) {
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  const hosts = useHosts();
  const environment = useMemo(
    () => hosts.find((host) => host.serverId === serverId)?.label ?? serverId,
    [hosts, serverId],
  );
  const multiplicity = useHostFeature(serverId, "workspaceMultiplicity");
  const receipts = useHostFeature(serverId, "workspaceRequestReceipts");
  const canAdd = useHostFeature(serverId, "projectAdd");
  const vorton = useVortonMode();
  const canCreate = multiplicity && receipts && vorton;
  const destinations = useFetchQuery({
    dataShape: "value",
    staleTimeMs: 0,
    queryKey: ["profile-destinations", serverId],
    enabled: Boolean(client && connected),
    queryFn: async () => {
      if (!client) throw new Error("Reconnect to the destination environment");
      const [workspaces, projects] = await Promise.all([
        readDestinationWorkspaces(client),
        client.listProjects(),
      ]);
      return { workspaces, projects: projects.projects };
    },
  });
  return { environment, connected, canAdd, canCreate, vorton, destinations };
}

export function DestinationPicker({ serverId, selection, onChange, disabled }: Props) {
  const { environment, connected, canAdd, canCreate, vorton, destinations } =
    useDestinationCatalog(serverId);
  const [addingProject, setAddingProject] = useState(false);
  const request = useMemo(() => ({ id: 0, preferredHostId: serverId }), [serverId]);
  const projectOptions = useMemo(
    () =>
      (destinations.data?.projects ?? []).map((project) => ({
        id: project.projectId,
        value: project.projectId,
        label: project.projectCustomName ?? project.projectDisplayName,
        description: project.projectRootPath,
      })),
    [destinations.data],
  );
  const workspaceOptions = useMemo(
    () =>
      (destinations.data?.workspaces ?? []).map((workspace) => ({
        id: workspace.id,
        value: workspace.id,
        label: `${workspace.projectDisplayName} / ${workspace.name}`,
        description: workspace.workspaceDirectory ?? workspace.projectRootPath,
      })),
    [destinations.data],
  );
  const selectMode = useCallback(
    (mode: string) => {
      onChange(
        mode === "new" ? newDestinationSelection(null) : { kind: "existing", workspace: null },
      );
    },
    [onChange],
  );
  const selectProject = useCallback(
    (id: string) => {
      const project = destinations.data?.projects.find((entry) => entry.projectId === id);
      if (project) onChange(selectDestinationProject(selection, project));
    },
    [destinations.data, onChange, selection],
  );
  const selectWorkspace = useCallback(
    (id: string) => {
      const workspace = destinations.data?.workspaces.find((entry) => entry.id === id);
      if (workspace) onChange({ kind: "existing", workspace });
    },
    [destinations.data, onChange],
  );
  const { refetch } = destinations;
  const added = useCallback(
    (project: WorkspaceProjectDescriptorPayload) => {
      onChange(selectDestinationProject(selection, project));
      void refetch();
    },
    [onChange, refetch, selection],
  );
  const closeAdd = useCallback(() => setAddingProject(false), []);
  const openAdd = useCallback(() => setAddingProject(true), []);
  const setTitle = useCallback(
    (title: string) => {
      if (selection.kind === "new") onChange({ ...selection, title });
    },
    [selection, onChange],
  );
  const setCheckout = useCallback(
    (checkout: string) => {
      if (selection.kind === "new" && (checkout === "directory" || checkout === "worktree"))
        onChange({ ...selection, checkout });
    },
    [selection, onChange],
  );
  const unavailable = disabled || !connected;
  const modeOptions = useMemo(
    () =>
      destinationOptions.map((option) =>
        Object.assign({}, option, {
          disabled: unavailable || (option.value === "new" && !canCreate),
        }),
      ),
    [unavailable, canCreate],
  );
  const isolationOptions = useMemo(
    () => checkoutOptions.map((option) => Object.assign({}, option, { disabled: unavailable })),
    [unavailable],
  );
  const error = connected
    ? destinations.error?.message
    : "Reconnect to the destination environment";
  const project = selection.kind === "new" ? selection.project : null;
  const workspace = selection.kind === "existing" ? selection.workspace : null;
  const projectDisplay = useMemo(
    () =>
      project
        ? {
            label: project.projectCustomName ?? project.projectDisplayName,
            description: project.projectRootPath,
          }
        : null,
    [project],
  );
  const workspaceDisplay = useMemo(
    () =>
      workspace
        ? {
            label: `${workspace.projectDisplayName} / ${workspace.name}`,
            description: workspace.workspaceDirectory ?? workspace.projectRootPath,
          }
        : null,
    [workspace],
  );
  return (
    <View style={styles.fields}>
      <Text style={styles.environment}>{environment}</Text>
      {vorton ? (
        <SegmentedControl options={modeOptions} value={selection.kind} onValueChange={selectMode} />
      ) : null}
      {selection.kind === "new" ? (
        <>
          <SelectField
            label="Project"
            value={project?.projectId ?? ""}
            selectedDisplay={projectDisplay}
            options={projectOptions}
            onChange={selectProject}
            searchable
            size="md"
            placeholder="Select project"
            emptyText="No projects in this environment"
            disabled={unavailable || destinations.isPending}
            error={error}
            triggerTestID="preset-destination-project"
          />
          {canAdd ? (
            <Button
              variant="outline"
              onPress={openAdd}
              disabled={unavailable}
              testID="preset-destination-add-project"
            >
              Add project in this environment
            </Button>
          ) : null}
          <Field label="Workspace name">
            <FormTextInput
              initialValue={selection.title}
              onChangeText={setTitle}
              editable={!unavailable}
              placeholder="New workspace"
              testID="preset-destination-name"
            />
          </Field>
          {project?.projectKind === "git" ? (
            <Field label="Checkout">
              <SegmentedControl
                options={isolationOptions}
                value={selection.checkout}
                onValueChange={setCheckout}
              />
            </Field>
          ) : null}
        </>
      ) : (
        <SelectField
          label="Destination workspace"
          value={workspace?.id ?? ""}
          selectedDisplay={workspaceDisplay}
          options={workspaceOptions}
          onChange={selectWorkspace}
          searchable
          size="md"
          placeholder="Select workspace"
          emptyText="No available workspaces"
          disabled={unavailable || destinations.isPending}
          error={error}
          triggerTestID="preset-destination-workspace"
        />
      )}
      {addingProject ? (
        <AddProjectFlow
          request={request}
          destinationServerId={serverId}
          onAdded={added}
          onClose={closeAdd}
        />
      ) : null}
    </View>
  );
}
const styles = StyleSheet.create((theme) => ({
  fields: { gap: theme.spacing[3] },
  environment: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));
