import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { EditingTextInput } from "@/components/ui/text-input";
import { usePathname, useRouter } from "expo-router";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { settingsStyles } from "@/styles/settings";
import { StatusBadge, type StatusBadgeVariant } from "@/components/ui/status-badge";
import { Button } from "@/components/ui/button";

import { getHostRuntimeStore, useHostRegistryLoaded, useHosts } from "@/runtime/host-runtime";
import { useVortonMode } from "@/vorton-mode";
import { useVortonTouch } from "@/vorton-touch";
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

export function InstallationControls() {
  const vortonMode = useVortonMode();
  const registryLoaded = useHostRegistryLoaded();
  const model = getInstallationPanel(registryLoaded);
  const hosts = useHosts();
  const installation = readExecutionInstallation();
  const needsSetup = installation && !hasInstallationConnections(installation, hosts);
  if (!model || (!vortonMode && !needsSetup)) return null;
  return <InstallationPanel model={model} />;
}

// Session restoration stays app-wide. Setup routes to the inline controls once;
// incoming restart requests never interrupt another screen or open a dialog.
export function InstallationSessionHost() {
  const registryLoaded = useHostRegistryLoaded();
  const model = getInstallationPanel(registryLoaded);
  return model ? <InstallationSession model={model} /> : null;
}

function InstallationSession({ model }: { model: InstallationPanelModel }) {
  const state = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  const router = useRouter();
  const pathname = usePathname();
  useEffect(() => {
    void model.initialize();
    const timer = setInterval(() => {
      void model.refresh();
    }, 5000);
    return () => clearInterval(timer);
  }, [model]);
  useEffect(() => {
    if (!state.initialized || state.busy || !state.visible) return;
    model.close();
    if (pathname !== "/settings/general") router.replace("/settings/general");
  }, [model, pathname, router, state.busy, state.initialized, state.visible]);
  return null;
}

function restartStatus(job: RestartJob, historical = false) {
  if (job.status === "pending") {
    if (Date.parse(job.expiresAt) <= Date.now())
      return { label: "Expired", variant: "muted" as const };
    if (historical) return { label: "Superseded", variant: "muted" as const };
    return { label: "Approval needed", variant: "warning" as const };
  }
  const labels = {
    approved: "Approved, queued",
    running: "Restarting",
    succeeded: "Restarted",
    failed: "Failed",
    rejected: "Rejected",
  };
  let variant: StatusBadgeVariant = "muted";
  if (job.status === "succeeded") variant = "success";
  if (job.status === "failed") variant = "error";
  return { label: labels[job.status], variant };
}

function InstallationPanel({ model }: { model: InstallationPanelModel }) {
  const controlSize = useVortonTouch() ? "md" : "sm";
  const state = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  const [historyVisible, setHistoryVisible] = useState(false);
  const [sharingVisible, setSharingVisible] = useState(false);
  const pendingIds = new Set(state.pendingJobs.map((job) => job.id));
  const active = state.jobs
    .filter(
      (job) => pendingIds.has(job.id) || job.status === "approved" || job.status === "running",
    )
    .toReversed();
  const activeIds = new Set(active.map((job) => job.id));
  const history = state.jobs.filter((job) => !activeIds.has(job.id)).toReversed();
  const conflicts = Object.values(state.profileSharing?.sources ?? {}).some(
    (source) => source.error || source.conflicts.length,
  );
  const toggleHistory = useCallback(() => setHistoryVisible((value) => !value), []);
  const toggleSharing = useCallback(() => setSharingVisible((value) => !value), []);
  let sharingLabel = state.profileSharing ? "Synchronized" : "Unavailable";
  let sharingVariant: StatusBadgeVariant = state.profileSharing ? "success" : "muted";
  if (conflicts) {
    sharingLabel = "Needs attention";
    sharingVariant = "warning";
  }
  return (
    <SettingsSection title="Installation" testID="installation-panel">
      <View style={settingsStyles.card}>
        <InstallationOwnerAccess model={model} state={state} />
        {state.unlocked
          ? (["host", "container-daemon"] as const).map((target) => {
              const job =
                active.find((candidate) => candidate.target === target) ??
                history.find((candidate) => candidate.target === target);
              const badge = job
                ? restartStatus(job, !activeIds.has(job.id))
                : {
                    label: state.lastUpdatedAt ? "No requests" : "Loading",
                    variant: "muted" as const,
                  };
              return (
                <View
                  key={target}
                  style={[styles.cardBody, settingsStyles.rowBorder]}
                  testID={`installation-status-${target}`}
                >
                  <View style={styles.requestHeader}>
                    <Text style={settingsStyles.rowTitle}>
                      {target === "host" ? "Host" : "Dev container"}
                    </Text>
                    <StatusBadge {...badge} />
                  </View>
                  {job ? (
                    <Text style={styles.text}>
                      {job.status === "failed"
                        ? job.detail
                        : `Latest request: ${new Date(job.createdAt).toLocaleString()}`}
                    </Text>
                  ) : null}
                </View>
              );
            })
          : null}
      </View>
      {state.error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {state.error}
        </Text>
      ) : null}
      {state.unlocked ? (
        <>
          {active.map((job) => (
            <RestartRequest
              key={`${job.id}:${job.revision}`}
              job={job}
              model={model}
              busy={state.busy}
            />
          ))}
          {state.lastUpdatedAt && active.length === 0 ? (
            <Text style={styles.text}>No pending restart requests</Text>
          ) : null}
          {state.notice ? (
            <Text accessibilityLiveRegion="polite" style={styles.text}>
              {state.notice}
            </Text>
          ) : null}
          <View style={styles.requestHeader}>
            <Button
              variant="ghost"
              size={controlSize}
              onPress={toggleHistory}
              testID="restart-history-toggle"
              disabled={!history.length}
            >
              {historyVisible ? "Hide restart history" : `Restart history (${history.length})`}
            </Button>
            <View style={styles.actions}>
              <StatusBadge label={sharingLabel} variant={sharingVariant} />
              <Button
                variant="ghost"
                size={controlSize}
                onPress={toggleSharing}
                testID="installation-sharing-toggle"
              >
                {sharingVisible ? "Hide shared workflows" : "Shared workflows"}
              </Button>
            </View>
          </View>
          {historyVisible
            ? history
                .slice(0, 20)
                .map((job) => (
                  <RestartRequest
                    key={`${job.id}:${job.revision}`}
                    job={job}
                    model={model}
                    busy={state.busy}
                    historical
                  />
                ))
            : null}
          {sharingVisible ? (
            <ProfileSharingStatusView
              status={state.profileSharing}
              model={model}
              busy={state.busy}
            />
          ) : null}
        </>
      ) : null}
    </SettingsSection>
  );
}

function InstallationOwnerAccess({
  model,
  state,
}: {
  model: InstallationPanelModel;
  state: ReturnType<InstallationPanelModel["getState"]>;
}) {
  const controlSize = useVortonTouch() ? "md" : "sm";
  const [helpVisible, setHelpVisible] = useState(false);
  const toggleHelp = useCallback(() => setHelpVisible((value) => !value), []);
  const ownerLabel = state.unlocked ? "Owner unlocked" : "Owner locked";
  const setPassword = useCallback((value: string) => model.setPassword(value), [model]);
  const lock = useCallback(() => {
    void model.lock();
  }, [model]);
  const unlock = useCallback(() => {
    setHelpVisible(false);
    void model.unlock();
  }, [model]);
  return (
    <View style={styles.cardBody}>
      <View style={styles.requestHeader}>
        <Text style={settingsStyles.rowTitle}>Host and container</Text>
        <View style={styles.actions}>
          <StatusBadge
            label={state.initialized ? ownerLabel : "Checking access"}
            variant={state.unlocked ? "success" : "muted"}
          />
          {state.unlocked ? (
            <Button
              variant="ghost"
              size={controlSize}
              disabled={state.busy}
              testID="installation-lock"
              onPress={lock}
            >
              Lock
            </Button>
          ) : null}
        </View>
      </View>
      {!state.initialized ? <Text style={styles.text}>Checking owner access...</Text> : null}
      {state.initialized && !state.unlocked ? (
        <>
          <Text style={styles.text}>
            Unlock to view approval status and manage restarts. Your daemon connections stay
            available.
          </Text>
          <View style={styles.unlockRow}>
            <EditingTextInput
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              initialValue=""
              onChangeText={setPassword}
              onSubmitEditing={unlock}
              accessibilityLabel="Owner password"
              placeholder="Owner password"
              testID="installation-password"
              style={[styles.input, styles.passwordInput]}
            />
            <Button
              variant="outline"
              disabled={state.busy || !state.password.trim()}
              onPress={unlock}
              testID="installation-unlock"
            >
              {state.busy ? "Unlocking..." : "Unlock controls"}
            </Button>
          </View>
          <Button
            variant="ghost"
            size={controlSize}
            onPress={toggleHelp}
            testID="installation-password-help"
          >
            {helpVisible ? "Hide password help" : "Find owner password"}
          </Button>
          {helpVisible ? (
            <View style={styles.details}>
              <Text style={styles.text}>
                The host installer generates this password. Find it in the owner-password file on
                your host:
              </Text>
              {state.passwordFile ? (
                <Text selectable style={styles.text} testID="installation-password-file">
                  {state.passwordFile}
                </Text>
              ) : null}
              <Text style={styles.text}>
                Owner access is remembered in this browser for seven days. Lock ends it sooner. Each
                restart requires a separate approval.
              </Text>
            </View>
          ) : null}
        </>
      ) : null}
      {state.unlocked ? (
        <Text style={styles.text}>
          {state.lastUpdatedAt
            ? `Updated ${new Date(state.lastUpdatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}. Each restart requires your approval.`
            : "Loading restart status..."}
        </Text>
      ) : null}
    </View>
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
          label={source.error || source.conflicts.length ? "Needs attention" : "Synchronized"}
          variant={source.error || source.conflicts.length ? "warning" : "success"}
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
  const controlSize = useVortonTouch() ? "md" : "sm";
  const expired = job.status === "pending" && Date.parse(job.expiresAt) <= Date.now();
  const status = restartStatus(job, historical);
  const canDecide = !historical && job.status === "pending" && !expired;
  const [reviewing, setReviewing] = useState(false);
  const [detailsVisible, setDetailsVisible] = useState(false);
  const toggleDetails = useCallback(() => setDetailsVisible((value) => !value), []);
  const review = useCallback(() => setReviewing(true), []);
  const cancel = useCallback(() => setReviewing(false), []);
  const approve = useCallback(() => {
    void model.decide(job, "approve");
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
          <StatusBadge {...status} />
        </View>
        <Text style={styles.text} numberOfLines={reviewing || detailsVisible ? undefined : 2}>
          {job.reason}
        </Text>
        <Text style={styles.text}>{job.detail}</Text>
        {reviewing || detailsVisible ? (
          <Text selectable style={styles.text}>
            Request {job.id}
            {"\n"}Requested {new Date(job.createdAt).toLocaleString()} by {job.requestedBy}
            {"\n"}Approval expires {new Date(job.expiresAt).toLocaleString()}
          </Text>
        ) : null}
        {!reviewing ? (
          <Button size={controlSize} variant="ghost" onPress={toggleDetails}>
            {detailsVisible ? "Hide details" : "Details"}
          </Button>
        ) : null}
        {canDecide && reviewing ? (
          <View style={styles.details} testID={`restart-confirmation-${job.id}`}>
            <Text style={settingsStyles.rowTitle}>
              Restart {job.target === "host" ? "host" : "dev container"} daemon?
            </Text>
            <Text style={styles.text}>
              Running agents and terminals may be interrupted. This approves only the request shown
              above.
            </Text>
            <View style={styles.actions}>
              <Button
                variant="destructive"
                disabled={busy}
                onPress={approve}
                testID={`restart-confirm-${job.id}`}
              >
                Approve restart
              </Button>
              <Button variant="ghost" disabled={busy} onPress={cancel}>
                Cancel
              </Button>
            </View>
          </View>
        ) : null}
        {canDecide && !reviewing ? (
          <View style={styles.actions}>
            <Button
              variant="outline"
              disabled={busy}
              onPress={review}
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
  details: { gap: theme.spacing[2] },
  unlockRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  passwordInput: { flexGrow: 1, flexBasis: 200 },
  cardBody: { padding: theme.spacing[4], gap: theme.spacing[2] },
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
  text: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.base },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[2] },
}));
