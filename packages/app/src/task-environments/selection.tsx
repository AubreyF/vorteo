import { useCallback, useMemo, useState } from "react";
import { View, Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useHosts, useHostRuntimeClient } from "@/runtime/host-runtime";
import { readExecutionInstallation } from "@/execution-installation/policy";
import { SelectField } from "@/components/ui/select-field";
import { Button } from "@/components/ui/button";
import { ProjectDirectoryBrowser } from "@/components/project-directory-browser";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import type { TaskEnvironmentModel, TaskEnvironmentState } from "./model";

export function TaskEnvironmentSelection({
  model,
  state,
  disabled,
  canChooseFolder,
}: {
  model: TaskEnvironmentModel;
  state: TaskEnvironmentState;
  disabled: boolean;
  canChooseFolder: boolean;
}) {
  const hosts = useHosts();
  const installation = readExecutionInstallation();
  const [browsing, setBrowsing] = useState(false);
  const client = useHostRuntimeClient(state.serverId);
  const options = useMemo(
    () =>
      hosts.map((host) => {
        const environment = installation?.environments.find(
          (item) => item.serverId === host.serverId,
        );
        let label = host.label;
        if (environment) label = environment.kind === "host" ? "Host" : "Dev container";
        return { id: host.serverId, value: host.serverId, label };
      }),
    [hosts, installation],
  );
  const label = options.find((option) => option.value === state.serverId)?.label ?? "Environment";
  const select = useCallback(
    (serverId: string) => {
      void model.select(serverId);
    },
    [model],
  );
  const choose = useCallback(
    (directory: string) => {
      model.chooseDirectory(directory);
      setBrowsing(false);
    },
    [model],
  );
  const display = useMemo(() => ({ label }), [label]);
  const header = useMemo(() => ({ title: `Choose folder in ${label}` }), [label]);
  const retry = useCallback(() => {
    void model.select(state.serverId);
  }, [model, state.serverId]);
  const open = useCallback(() => setBrowsing(true), []);
  const close = useCallback(() => setBrowsing(false), []);
  return (
    <View style={styles.row}>
      <SelectField
        label="Environment"
        value={state.serverId}
        selectedDisplay={display}
        options={options}
        onChange={select}
        placeholder="Choose environment"
        emptyText="No environments"
        testID="task-environment"
        disabled={disabled}
        loading={state.status === "resolving"}
        error={state.error}
      />
      {state.status === "folder" ? (
        <Text style={styles.text}>{`Choose this workspace's folder in ${label}.`}</Text>
      ) : null}
      {state.directory ? (
        <Text style={styles.text} numberOfLines={1}>
          {state.directory}
        </Text>
      ) : null}
      {state.status === "error" ? (
        <Button variant="ghost" onPress={retry}>
          Retry
        </Button>
      ) : null}
      {canChooseFolder && !state.workspaceId && (
        <Button
          variant="ghost"
          disabled={disabled || !client}
          onPress={open}
          testID="task-environment-folder"
        >
          Choose folder
        </Button>
      )}
      {browsing && client ? (
        <AdaptiveModalSheet visible header={header} onClose={close}>
          <ProjectDirectoryBrowser client={client} onSelect={choose} />
        </AdaptiveModalSheet>
      ) : null}
    </View>
  );
}
const styles = StyleSheet.create((theme) => ({
  row: { gap: theme.spacing[2] },
  text: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));
