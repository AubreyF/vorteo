import { useCallback, useMemo } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useMutation } from "@tanstack/react-query";
import { useStoreWithEqualityFn } from "zustand/traditional";
import equal from "fast-deep-equal";
import { Button } from "@/components/ui/button";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { getHostRuntimeStore, useHosts } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { settingsStyles } from "@/styles/settings";
import { isConnectionError, toErrorMessage } from "@/utils/error-messages";
import { useReportActionError } from "@/hooks/use-action-error";
import { useVortonTouch } from "@/vorton-touch";
import { SYSTEM_PROJECT_TITLE } from "@/workspace/lifecycle/system-workspace";
import {
  buildSystemHostSummaries,
  SYSTEM_SOURCE_TITLE,
  type SystemHostSummary,
  type SystemWorkspaceLink,
} from "./system-project-model";

/** Lists each host's System project workspaces from descriptors already in the store. */
export function SystemProjectCard() {
  const hosts = useHosts();
  const hostLabels = useMemo(
    () => hosts.map((host) => ({ serverId: host.serverId, label: host.label })),
    [hosts],
  );
  const summaries = useStoreWithEqualityFn(
    useSessionStore,
    (state) => buildSystemHostSummaries({ hosts: hostLabels, sessions: state.sessions }),
    equal,
  );
  if (summaries.length === 0) return null;
  return (
    <SettingsSection title={SYSTEM_PROJECT_TITLE} testID="system-project-card">
      <View style={settingsStyles.card}>
        {summaries.map((summary, index) => (
          <SystemHostRow
            key={summary.serverId}
            summary={summary}
            labelled={summaries.length > 1}
            bordered={index > 0}
          />
        ))}
      </View>
    </SettingsSection>
  );
}

function SystemHostRow({
  summary,
  labelled,
  bordered,
}: {
  summary: SystemHostSummary;
  labelled: boolean;
  bordered: boolean;
}) {
  const touch = useVortonTouch();
  const { serverId } = summary;
  const reportActionError = useReportActionError();
  const setup = useMutation({
    mutationKey: ["system-source-setup", serverId],
    mutationFn: async () => {
      const client = getHostRuntimeStore().getClient(serverId);
      if (!client) throw new Error("Host disconnected. Reconnect and try again.");
      return client.setupSystemSource();
    },
    onSuccess: ({ workspaceId }) => {
      if (workspaceId) navigateToWorkspace({ serverId, workspaceId });
    },
    onError: (error) => {
      if (isConnectionError(error)) reportActionError(error);
    },
  });
  const isSetupRejected = setup.isError && !isConnectionError(setup.error);
  const { mutate } = setup;
  const startSetup = useCallback(() => mutate(), [mutate]);
  const rowStyle = useMemo(
    () => [settingsStyles.row, bordered && settingsStyles.rowBorder],
    [bordered],
  );
  return (
    <View style={rowStyle} testID={`system-project-host-${serverId}`}>
      <View style={settingsStyles.rowContent}>
        {labelled ? <Text style={settingsStyles.rowTitle}>{summary.label}</Text> : null}
        {summary.managed.length === 0 ? (
          <Text style={settingsStyles.rowHint}>No system workspaces yet.</Text>
        ) : (
          summary.managed.map((link) => (
            <WorkspaceLink key={link.workspaceId} serverId={serverId} link={link} touch={touch} />
          ))
        )}
        {summary.source ? (
          <WorkspaceLink serverId={serverId} link={summary.source} touch={touch} />
        ) : null}
        {summary.canSetUpSource ? (
          <View>
            <Button
              variant="secondary"
              size={touch ? "md" : "sm"}
              loading={setup.isPending}
              disabled={setup.isPending}
              style={styles.link}
              onPress={startSetup}
              testID={`system-source-setup-${serverId}`}
            >
              {`Set up ${SYSTEM_SOURCE_TITLE}`}
            </Button>
            {setup.isPending ? (
              <Text style={settingsStyles.rowHint}>Cloning can take a few minutes.</Text>
            ) : null}
            {isSetupRejected ? (
              <Text
                accessibilityRole="alert"
                style={settingsStyles.rowError}
                testID={`system-source-setup-error-${serverId}`}
              >
                {toErrorMessage(setup.error)}
              </Text>
            ) : null}
          </View>
        ) : null}
      </View>
    </View>
  );
}

function WorkspaceLink({
  serverId,
  link,
  touch,
}: {
  serverId: string;
  link: SystemWorkspaceLink;
  touch: boolean;
}) {
  const open = useCallback(
    () => navigateToWorkspace({ serverId, workspaceId: link.workspaceId }),
    [serverId, link.workspaceId],
  );
  return (
    <Button
      variant="ghost"
      size={touch ? "md" : "sm"}
      onPress={open}
      style={styles.link}
      accessibilityLabel={`Open ${link.title}`}
      testID={`system-project-workspace-${serverId}-${link.workspaceId}`}
    >
      {link.title}
    </Button>
  );
}

const styles = StyleSheet.create((theme) => ({
  link: { alignSelf: "flex-start", marginTop: theme.spacing[1] },
}));
