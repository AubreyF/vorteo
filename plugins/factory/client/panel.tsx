import { useQuery } from "@tanstack/react-query";
import {
  useRpc,
  useWorkspace,
  type PluginWorkspacePanelProps,
  type PluginScreenProps,
  type PluginSurfaceProps,
} from "@getpaseo/plugin/client";
import { Pressable, Text, ScrollView, StyleSheet } from "react-native";
import { factorySnapshot } from "../shared/contracts.js";
import { factorySetup, factoryInstall } from "../shared/operations.js";
import { useMemo, useCallback, useRef, useSyncExternalStore, useEffect } from "react";
import { FactoryOverview } from "./overview.js";
import { resolveFactoryObservation, resolveFactorySetupObservation } from "./observation.js";
import { FactorySetupStatus } from "./setup.js";
import { FactoryOwnerControls } from "./owner-controls.js";
import {
  getFactoryInstallation,
  createFactoryOperationId,
  type FactoryInstallationState,
} from "./installation.js";

const idleInstallation: FactoryInstallationState = { kind: "idle" };
function readIdleInstallation() {
  return idleInstallation;
}
function subscribeIdleInstallation() {
  return () => {};
}

export function FactoryPanel(props: PluginWorkspacePanelProps) {
  const projectId = useWorkspace(props.workspaceId, (workspace) => workspace.projectId);
  return <FactoryObservation {...props} projectId={projectId} />;
}

export function FactoryScreen(props: PluginScreenProps) {
  return <FactoryObservation {...props} projectId={props.params.projectId ?? null} />;
}

function FactoryObservation(props: PluginSurfaceProps & { projectId: string | null }) {
  const { projectId } = props;
  const readSnapshot = useRpc(factorySnapshot);
  const readSetup = useRpc(factorySetup);
  const installFactory = useRpc(factoryInstall);
  const scope = useRef({ hostId: props.host.id, projectId });
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  scope.current = { hostId: props.host.id, projectId };
  const installation = useMemo(
    () => (projectId === null ? null : getFactoryInstallation(props.host.id, projectId)),
    [props.host.id, projectId],
  );
  const installationState = useSyncExternalStore(
    installation?.subscribe ?? subscribeIdleInstallation,
    installation?.getSnapshot ?? readIdleInstallation,
    installation?.getSnapshot ?? readIdleInstallation,
  );
  const query = useQuery({
    queryKey: ["factory.snapshot", props.host.id, projectId],
    queryFn: () => {
      if (projectId === null) throw new Error("Workspace project identity unavailable");
      return readSnapshot({ projectId });
    },
    enabled: projectId !== null,
    refetchInterval: 15000,
  });
  const setupQuery = useQuery({
    queryKey: ["factory.setup", props.host.id, projectId],
    queryFn: () => {
      if (projectId === null) throw new Error("Workspace project identity unavailable");
      return readSetup({ projectId });
    },
    enabled: projectId !== null,
    retry: false,
    refetchInterval: 15000,
  });
  const ownerControls = useMemo(
    () =>
      projectId === null ? null : (
        <FactoryOwnerControls
          key={`${props.host.id}:${projectId}`}
          hostId={props.host.id}
          projectId={projectId}
        />
      ),
    [props.host.id, projectId],
  );
  const colors = props.theme.colors;
  const styles = useMemo(
    () =>
      StyleSheet.create({
        scroll: { flex: 1, backgroundColor: colors.surface0 },
        root: { padding: 24, gap: 16 },
        muted: { color: colors.foregroundMuted },
        text: { color: colors.foreground },
        error: { color: colors.statusDanger },
        link: { color: colors.accent },
        retry: { minHeight: 44, justifyContent: "center" },
      }),
    [colors],
  );
  const observation = resolveFactoryObservation({
    hostId: props.host.id,
    projectId,
    snapshot: query.data,
    pending: query.isPending,
    failed: query.isError,
    paused: query.fetchStatus === "paused",
  });
  const { refetch } = query;
  const { refetch: refetchSetup } = setupQuery;
  const retry = useCallback(() => {
    void refetch();
  }, [refetch]);
  const retrySetup = useCallback(() => {
    void refetchSetup();
  }, [refetchSetup]);
  const setupState = resolveFactorySetupObservation({
    hostId: props.host.id,
    projectId,
    setup: setupQuery.data,
    pending: setupQuery.isPending,
    failed: setupQuery.isError,
    paused: setupQuery.fetchStatus === "paused",
  });
  const install = useCallback(async () => {
    if (
      !installation ||
      projectId === null ||
      setupState.kind !== "observed" ||
      setupState.retained
    )
      return;
    const hostId = props.host.id;
    await installation.run(setupState.setup, createFactoryOperationId(), {
      readSetup: () => readSetup({ projectId }),
      install: installFactory,
      isCurrent: () =>
        mounted.current && scope.current.hostId === hostId && scope.current.projectId === projectId,
    });
    if (scope.current.hostId === hostId && scope.current.projectId === projectId) {
      void refetch();
      void refetchSetup();
    }
  }, [
    installation,
    projectId,
    setupState,
    props.host.id,
    readSetup,
    installFactory,
    refetch,
    refetchSetup,
  ]);
  const setupView = (
    <FactorySetupStatus
      state={setupState}
      theme={props.theme}
      onRetry={retrySetup}
      pending={setupQuery.isFetching}
      installation={installationState}
      onInstall={install}
    />
  );
  const openAgent = props.navigation?.openAgent;
  const openWorkspace = props.navigation?.openWorkspace;
  const hostId = props.host.id;
  const navigateAgent = useCallback(
    (agentId: string) => {
      if (openAgent) openAgent({ agentId, serverId: hostId });
    },
    [openAgent, hostId],
  );
  const navigateWorkspace = useCallback(
    (workspaceId: string) => {
      if (openWorkspace) openWorkspace({ workspaceId, serverId: hostId });
    },
    [openWorkspace, hostId],
  );
  if (observation.kind === "identity_unavailable")
    return (
      <ScrollView style={styles.scroll} contentContainerStyle={styles.root}>
        <Text style={styles.muted}>
          Workspace identity unavailable. Waiting for the workspace record from the selected host.
        </Text>
      </ScrollView>
    );
  if (observation.kind === "loading")
    return (
      <ScrollView style={styles.scroll} contentContainerStyle={styles.root}>
        {setupView}
        <Text style={styles.muted}>Reading Factory state...</Text>
      </ScrollView>
    );
  if (observation.kind === "unavailable")
    return (
      <ScrollView style={styles.scroll} contentContainerStyle={styles.root}>
        {setupView}
        <Text style={styles.text}>Factory state unavailable</Text>
        <Text style={styles.muted}>
          The runtime could not provide a snapshot. Previously recorded work may still exist.
        </Text>
        <Pressable accessibilityRole="button" onPress={retry} style={styles.retry}>
          <Text style={styles.link}>Retry observation</Text>
        </Pressable>
      </ScrollView>
    );
  if (observation.kind === "identity_mismatch")
    return (
      <ScrollView style={styles.scroll} contentContainerStyle={styles.root}>
        {setupView}
        <Text style={styles.error}>
          Snapshot identity does not match the selected host and project.
        </Text>
      </ScrollView>
    );
  return (
    <FactoryOverview
      {...props}
      source={observation.source}
      onOpenAgent={openAgent ? navigateAgent : undefined}
      onOpenWorkspace={openWorkspace ? navigateWorkspace : undefined}
      onRetryObservation={retry}
      observationPending={query.isFetching}
      setupState={setupState}
      onRetrySetup={retrySetup}
      setupPending={setupQuery.isFetching}
      installation={installationState}
      onInstall={install}
      ownerControls={ownerControls}
    />
  );
}
