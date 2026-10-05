import { useCallback, useMemo, useEffect, useState, useSyncExternalStore } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveModalSheet, AdaptiveTextInput } from "@/components/adaptive-modal-sheet";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { settingsStyles } from "@/styles/settings";
import { StatusBadge } from "@/components/ui/status-badge";
import { Button } from "@/components/ui/button";
import { confirmDialog } from "@/utils/confirm-dialog";
import { getHostRuntimeStore, useHostRegistryLoaded } from "@/runtime/host-runtime";
import { useVortonMode } from "@/vorton-mode";
import { readExecutionInstallation } from "./policy";
import { InstallationClient, requestInstallationOwner, hasInstallationConnections } from "./client";
import { InstallationPanelModel } from "./panel-model";
import type { ProfileSharingStatus, RestartJob } from "@getpaseo/protocol/execution-installation";

let panelModel: InstallationPanelModel | null = null;
function getInstallationPanel(registryLoaded: boolean): InstallationPanelModel | null {
  const installation = readExecutionInstallation();
  if (!installation) return null;
  const runtime = getHostRuntimeStore();
  if (!registryLoaded) return null;
  if (!panelModel)
    panelModel = new InstallationPanelModel(
      new InstallationClient(installation, {
        request: requestInstallationOwner,
        register: runtime,
      }),
      {
        connectionsRegistered: hasInstallationConnections(installation, runtime.getHosts()),
        openRequested:
          typeof window !== "undefined" &&
          new URL(window.location.href).searchParams.get("installation") === "1",
      },
    );
  return panelModel;
}

export function InstallationControlsButton() {
  const vortonMode = useVortonMode();
  const registryLoaded = useHostRegistryLoaded();
  const model = getInstallationPanel(registryLoaded);
  const open = useCallback(() => model?.open(), [model]);
  if (!vortonMode || !model) return null;
  return (
    <SettingsSection title="Installation">
      <View style={settingsStyles.card}>
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>Host and container</Text>
            <Text style={settingsStyles.rowHint}>
              Review restart requests and shared workflows with owner access
            </Text>
          </View>
          <Button variant="outline" size="md" testID="installation-controls-open" onPress={open}>
            Manage
          </Button>
        </View>
      </View>
    </SettingsSection>
  );
}

export function InstallationPanelHost() {
  const registryLoaded = useHostRegistryLoaded();
  const model = getInstallationPanel(registryLoaded);
  return model ? <InstallationPanel model={model} /> : null;
}

function InstallationPanel({ model }: { model: InstallationPanelModel }) {
  const state = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  const [historyVisible, setHistoryVisible] = useState(false);
  const toggleHistory = useCallback(() => setHistoryVisible((visible) => !visible), []);
  const pendingIds = new Set(state.pendingJobs.map((job) => job.id));
  const history = state.jobs.filter((job) => !pendingIds.has(job.id)).toReversed();
  useEffect(() => {
    void model.initialize();
    const timer = setInterval(() => {
      void model.refresh();
    }, 5000);
    return () => clearInterval(timer);
  }, [model]);

  const header = useMemo(() => {
    let subtitle = "Owner approval for host and container operations";
    if (state.unlocked) {
      subtitle = "Owner access unlocked for this page";
      if (state.sessionsSupported) subtitle = "Owner access unlocked in this browser";
    }
    return {
      title: "Installation controls",
      subtitle: <Text style={styles.text}>{subtitle}</Text>,
    };
  }, [state.unlocked, state.sessionsSupported]);
  const close = useCallback(() => model.close(), [model]);
  const setPassword = useCallback((value: string) => model.setPassword(value), [model]);
  const lock = useCallback(() => {
    void model.lock();
  }, [model]);
  const unlock = useCallback(() => {
    void model.unlock();
  }, [model]);

  return (
    <AdaptiveModalSheet
      header={header}
      visible={state.visible}
      onClose={close}
      testID="installation-panel"
    >
      <View style={styles.body}>
        {!state.unlocked ? (
          <SettingsSection title="Owner access" flush>
            <View style={settingsStyles.card}>
              <View style={styles.cardBody}>
                <Text style={settingsStyles.rowTitle}>Unlock installation controls</Text>
                <Text style={styles.text}>
                  Your host and container connections are separate from owner access. Unlocking lets
                  you review and approve restarts and resolve shared workflow conflicts.
                </Text>
                <Text style={styles.label}>Owner password</Text>
                <AdaptiveTextInput
                  secureTextEntry
                  autoCapitalize="none"
                  autoCorrect={false}
                  initialValue=""
                  onChangeText={setPassword}
                  accessibilityLabel="Owner password"
                  placeholder="Enter the installation owner password"
                  testID="installation-password"
                  style={styles.input}
                />
                <View style={styles.actions}>
                  <Button
                    disabled={state.busy || !state.password.trim()}
                    onPress={unlock}
                    testID="installation-unlock"
                  >
                    {state.busy ? "Unlocking..." : "Unlock controls"}
                  </Button>
                </View>
              </View>
              <View style={[styles.cardBody, settingsStyles.rowBorder]}>
                <Text style={settingsStyles.rowTitle}>Where did this password come from?</Text>
                <Text style={styles.text}>
                  The host installer generates this password during setup. You did not choose it.
                  Find it in the owner-password file on your host:
                </Text>
                {state.passwordFile ? (
                  <Text selectable style={styles.text} testID="installation-password-file">
                    {state.passwordFile}
                  </Text>
                ) : null}
                <Text style={styles.text}>
                  This separates owner approval from daemon and container credentials. An agent with
                  full host access can read this file, so it is not a barrier against that agent.
                </Text>
                <Text style={styles.text}>
                  Owner access is remembered in this browser for seven days. Lock controls to end it
                  sooner. Each restart still needs your explicit approval.
                </Text>
              </View>
            </View>
          </SettingsSection>
        ) : (
          <>
            <View style={settingsStyles.card}>
              <View style={styles.cardBody}>
                <Text style={settingsStyles.rowTitle}>Owner access is unlocked</Text>
                <Button
                  variant="outline"
                  disabled={state.busy}
                  testID="installation-lock"
                  onPress={lock}
                >
                  Lock controls
                </Button>
                <Text style={styles.text}>
                  Review each request before approving it. Restarting can interrupt active tasks and
                  terminals. Scoped agent credentials can request a restart, but cannot approve one.
                </Text>
              </View>
            </View>
            <ProfileSharingStatusView
              status={state.profileSharing}
              model={model}
              busy={state.busy}
            />
            <SettingsSection title="Pending restart requests" flush>
              {state.pendingJobs.length === 0 ? (
                <View style={settingsStyles.card}>
                  <View style={styles.cardBody}>
                    <Text style={settingsStyles.rowTitle}>No pending restart requests</Text>
                    <Text style={styles.text}>
                      Requests appear here when maintenance needs a restart
                    </Text>
                  </View>
                </View>
              ) : null}
              {state.pendingJobs.map((job) => (
                <RestartRequest key={job.id} job={job} model={model} busy={state.busy} />
              ))}
              {state.notice ? (
                <Text accessibilityLiveRegion="polite" style={styles.text}>
                  {state.notice}
                </Text>
              ) : null}
              {history.length > 0 ? (
                <Button variant="ghost" onPress={toggleHistory} testID="restart-history-toggle">
                  {historyVisible ? "Hide restart history" : "Show restart history"}
                </Button>
              ) : null}
            </SettingsSection>
            {historyVisible && history.length > 0 ? (
              <SettingsSection title="Restart history" flush>
                {history.slice(0, 20).map((job) => (
                  <RestartRequest
                    key={job.id}
                    job={job}
                    model={model}
                    busy={state.busy}
                    historical
                  />
                ))}
              </SettingsSection>
            ) : null}
          </>
        )}
        {state.error ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {state.error}
          </Text>
        ) : null}
      </View>
    </AdaptiveModalSheet>
  );
}

function ProfileSharingStatusView({
  status,
  model,
  busy,
}: {
  status: ProfileSharingStatus | null;
  model: InstallationPanelModel;
  busy: boolean;
}) {
  if (!status)
    return (
      <SettingsSection title="Shared workflows" flush>
        <View style={settingsStyles.card}>
          <View style={styles.cardBody}>
            <Text style={settingsStyles.rowTitle}>Waiting for compatible environments</Text>
            <Text style={styles.text}>
              Profile sharing starts when every environment is connected and supports shared
              workflows
            </Text>
          </View>
        </View>
      </SettingsSection>
    );
  return (
    <SettingsSection title="Shared workflows" flush>
      <View style={settingsStyles.card}>
        <View style={styles.cardBody}>
          <Text style={styles.text}>
            Workflows, model choices and provider defaults synchronize across environments. Account
            credentials and available providers stay local.
          </Text>
        </View>
        {Object.entries(status.sources).map(([serverId, source]) => (
          <ProfileSharingEnvironment
            key={serverId}
            serverId={serverId}
            source={source}
            model={model}
            busy={busy}
          />
        ))}
      </View>
    </SettingsSection>
  );
}

function ProfileSharingEnvironment({
  serverId,
  source,
  model,
  busy,
}: {
  serverId: string;
  source: ProfileSharingStatus["sources"][string];
  model: InstallationPanelModel;
  busy: boolean;
}) {
  const installation = readExecutionInstallation();
  const label =
    installation?.environments.find((environment) => environment.serverId === serverId)?.kind ===
    "host"
      ? "Host"
      : "Dev container";
  const useShared = useCallback(() => {
    void model.resolveProfileConflict(serverId, "shared");
  }, [model, serverId]);
  const useEnvironment = useCallback(() => {
    void model.resolveProfileConflict(serverId, "environment");
  }, [model, serverId]);
  return (
    <View style={[styles.cardBody, settingsStyles.rowBorder]}>
      <View style={styles.requestHeader}>
        <Text style={settingsStyles.rowTitle}>{label}</Text>
        <StatusBadge
          label={source.error ? "Needs attention" : "Synchronized"}
          variant={source.error ? "warning" : "success"}
        />
      </View>
      {source.error ? <Text style={styles.text}>{source.error}</Text> : null}
      {source.conflicts.length ? (
        <>
          <Text style={styles.text}>
            Conflicting fields: {source.conflicts.join(", ")}. Independent edits are preserved.
          </Text>
          {source.conflictValues.map((value) => (
            <Text key={value.field} style={styles.text}>
              {value.field}
              {"\n"}Shared: {value.sharedValue}
              {"\n"}
              {label}: {value.environmentValue}
            </Text>
          ))}
          <Button variant="outline" disabled={busy} onPress={useShared}>
            Use shared values
          </Button>
          <Button variant="outline" disabled={busy} onPress={useEnvironment}>
            Use {label} values
          </Button>
        </>
      ) : null}
    </View>
  );
}

function RestartRequest({
  job,
  model,
  busy,
  historical = false,
}: {
  job: RestartJob;
  model: InstallationPanelModel;
  busy: boolean;
  historical?: boolean;
}) {
  const expired = job.status === "pending" && Date.parse(job.expiresAt) <= Date.now();
  let status: string = job.status;
  if (expired) status = "expired";
  else if (historical && job.status === "pending") status = "superseded";
  const canDecide = !historical && job.status === "pending" && !expired;
  const approve = useCallback(async () => {
    const target = job.target === "host" ? "native host daemon" : "dev-container daemon";
    const confirmed = await confirmDialog({
      title: `Restart ${target}?`,
      message: `Running agents and terminals on this daemon may be interrupted. This approves only this restart request.\n\nReason: ${job.reason}`,
      confirmLabel: "Approve restart",
      destructive: true,
    });
    if (confirmed) await model.decide(job, "approve");
  }, [job, model]);
  const reject = useCallback(() => {
    void model.decide(job, "reject");
  }, [job, model]);
  return (
    <View style={settingsStyles.card} testID={`restart-request-${job.id}`}>
      <View style={styles.cardBody}>
        <View style={styles.requestHeader}>
          <Text style={settingsStyles.rowTitle}>
            {job.target === "host" ? "Host: full account access" : "Dev container"}
          </Text>
          <StatusBadge label={status} />
        </View>
        <Text style={styles.text}>{job.reason}</Text>
        <Text style={styles.text}>
          {job.requestedBy} · {job.detail}
        </Text>
        {canDecide ? (
          <View style={styles.actions}>
            <Button
              variant="outline"
              disabled={busy}
              onPress={approve}
              testID={`restart-approve-${job.id}`}
            >
              Review restart
            </Button>
            <Button variant="ghost" disabled={busy} onPress={reject}>
              Reject
            </Button>
          </View>
        ) : null}
        {expired ? (
          <Text style={styles.text}>
            This request expired. A new request is needed before restarting.
          </Text>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: { gap: theme.spacing[6] },
  cardBody: { padding: theme.spacing[4], gap: theme.spacing[3] },
  requestHeader: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  label: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  input: {
    minHeight: 44,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: theme.spacing[3],
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    backgroundColor: theme.colors.surface0,
  },
  text: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.base },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.base },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[2] },
}));
