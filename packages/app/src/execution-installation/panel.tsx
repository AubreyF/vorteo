import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { ScrollView, Text, View } from "react-native";
import { ChevronDown, ChevronUp } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { isWeb } from "@/constants/platform";
import { EditingTextInput } from "@/components/ui/text-input";
import { usePathname, useRouter } from "expo-router";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { settingsStyles } from "@/styles/settings";
import { StatusBadge, type StatusBadgeVariant } from "@/components/ui/status-badge";
import { SidebarCallout } from "@/components/sidebar-callout";
import { confirmDialog } from "@/utils/confirm-dialog";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import type { Theme } from "@/styles/theme";

import { getHostRuntimeStore, useHostRegistryLoaded } from "@/runtime/host-runtime";
import { useVortonTouch } from "@/vorton-touch";
import { readExecutionInstallation } from "./policy";
import { InstallationClient, requestInstallationOwner, hasInstallationConnections } from "./client";
import {
  InstallationPanelModel,
  restartExplanation,
  restartBannerTitle,
  restartBlockingReason,
} from "./panel-model";
import type { ProfileSharingStatus, RestartJob } from "@getpaseo/protocol/execution-installation";

const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const spinnerColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

const expandedDisclosure = { leftIcon: ChevronUp, accessibilityState: { expanded: true } };
const collapsedDisclosure = { leftIcon: ChevronDown, accessibilityState: { expanded: false } };
function disclosureProps(expanded: boolean) {
  return expanded ? expandedDisclosure : collapsedDisclosure;
}

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

export function InstallationControls({ requestId = null }: { requestId?: string | null }) {
  const registryLoaded = useHostRegistryLoaded();
  const model = getInstallationPanel(registryLoaded);
  if (!model) return null;
  return <InstallationPanel model={model} requestId={requestId} />;
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
    const inSettings = pathname === "/settings" || pathname.startsWith("/settings/");
    if (!inSettings) router.replace("/settings/general");
  }, [model, pathname, router, state.busy, state.initialized, state.visible]);
  return null;
}

function restartStatus(job: RestartJob, historical = false) {
  if (job.status === "pending") {
    if (historical) return { label: "Superseded", variant: "muted" as const };
    const batchStatus = job.sourceBatch?.status;
    if (batchStatus && batchStatus !== "ready") {
      const labels = {
        preparing: "Combining source",
        waiting: "Next batch",
        conflict: "Needs correction",
      };
      return { label: labels[batchStatus], variant: "warning" as const };
    }
    return { label: "Approval needed", variant: "warning" as const };
  }
  let approvedLabel = "Approved";
  if (job.whenIdle) approvedLabel = "Queued until idle";
  if (job.finishCurrentTurns) approvedLabel = "Finishing current turns";
  const labels = {
    approved: approvedLabel,
    running: job.update || job.sourceBatch ? "Updating" : "Restarting",
    succeeded: job.update || job.sourceBatch ? "Updated" : "Restarted",
    failed: "Failed",
    rejected: "Rejected",
  };
  let variant: StatusBadgeVariant = "muted";
  if (job.status === "succeeded") variant = "success";
  if (job.status === "failed") variant = "error";
  return { label: labels[job.status], variant };
}

function InstallationPanel({
  model,
  requestId,
}: {
  model: InstallationPanelModel;
  requestId: string | null;
}) {
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
  const selectedHistory = history.find((job) => job.id === requestId);
  const missingRequest =
    requestId && state.lastUpdatedAt && !state.jobs.some((job) => job.id === requestId);
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
      <View style={settingsStyles.card} testID="installation-card">
        <InstallationOwnerAccess model={model} state={state} />
        {state.error ? (
          <Text accessibilityRole="alert" style={[styles.textInset, styles.error]}>
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
                linked={job.id === requestId}
              />
            ))}
            {selectedHistory ? (
              <RestartRequest
                job={selectedHistory}
                model={model}
                busy={state.busy}
                historical
                linked
              />
            ) : null}
            {missingRequest ? (
              <Text style={[styles.textInset, styles.text]}>
                This restart request is no longer available.
              </Text>
            ) : null}
            {state.lastUpdatedAt && active.length === 0 ? (
              <Text style={[styles.textInset, styles.text]}>No pending restart requests</Text>
            ) : null}
            <View style={[styles.cardBody, settingsStyles.rowBorder]}>
              <View style={styles.requestHeader}>
                <Button
                  variant="ghost"
                  size={controlSize}
                  onPress={toggleSharing}
                  {...disclosureProps(sharingVisible)}
                  testID="installation-sharing-toggle"
                >
                  {sharingVisible ? "Hide shared workflows" : "Shared workflows"}
                </Button>
                <StatusBadge label={sharingLabel} variant={sharingVariant} />
              </View>
              {sharingVisible ? (
                <ProfileSharingStatusView
                  status={state.profileSharing}
                  model={model}
                  busy={state.busy}
                />
              ) : null}
            </View>
            <View testID="restart-history" style={settingsStyles.rowBorder}>
              <View style={[styles.cardBody, styles.requestHeader]}>
                <Button
                  variant="ghost"
                  size={controlSize}
                  onPress={toggleHistory}
                  {...disclosureProps(historyVisible)}
                  testID="restart-history-toggle"
                  disabled={!history.length}
                >
                  {historyVisible ? "Hide restart history" : `Restart history (${history.length})`}
                </Button>
              </View>
              {historyVisible
                ? history
                    .filter((job) => job.id !== selectedHistory?.id)
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
            </View>
          </>
        ) : null}
      </View>
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
            {...disclosureProps(helpVisible)}
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
        <View>
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
      <View>
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
  linked = false,
}: {
  job: RestartJob;
  model: InstallationPanelModel;
  busy: boolean;
  historical?: boolean;
  linked?: boolean;
}) {
  const status = restartStatus(job, historical);
  const source = Boolean(job.update || job.sourceBatch);
  useEffect(() => {
    if (!linked || !isWeb) return;
    const frame = requestAnimationFrame(() => {
      document.getElementById(`restart-request-${job.id}`)?.scrollIntoView({ block: "center" });
    });
    return () => cancelAnimationFrame(frame);
  }, [linked, job.id]);
  return (
    <View
      style={settingsStyles.rowBorder}
      nativeID={`restart-request-${job.id}`}
      testID={`restart-request-${job.id}`}
    >
      <View style={styles.cardBody}>
        <View style={styles.requestHeader}>
          <Text style={settingsStyles.rowTitle}>{restartTargetLabel(job)}</Text>
          <StatusBadge {...status} />
        </View>
        <Text style={styles.text} testID={`restart-summary-${job.id}`}>
          {restartExplanation(job.reason).summary}
          {restartBlockingReason(job) ? ` Needs correction: ${restartBlockingReason(job)}` : null}
          {source && job.status === "pending" && !restartBlockingReason(job)
            ? ` Approval lets the submitted code and build scripts run on ${job.target === "host" ? "Host" : "Dev"} and may interrupt its tasks and terminals.`
            : null}
          {source && job.status === "running"
            ? " The approved update is being built and installed."
            : null}
        </Text>
        <RestartDetails job={job} />
        <RestartActions job={job} model={model} busy={busy} historical={historical} />
      </View>
    </View>
  );
}

function isInstallReady(job: RestartJob): boolean {
  return Boolean(job.update) && (!job.sourceBatch || job.sourceBatch.status === "ready");
}

function RestartActions({
  job,
  model,
  busy,
  historical,
}: {
  job: RestartJob;
  model: InstallationPanelModel;
  busy: boolean;
  historical: boolean;
}) {
  const installation = readExecutionInstallation();
  const pending = job.status === "pending";
  const queued = job.status === "approved" && job.whenIdle;
  const source = Boolean(job.update || job.sourceBatch);
  const install = useCallback(() => {
    void model.decide(job, "approve");
  }, [job, model]);
  const queue = useCallback(() => {
    void model.decide(job, "approve-when-idle");
  }, [job, model]);
  const finish = useCallback(() => {
    void model.decide(job, "finish-current-turns");
  }, [job, model]);
  const cancel = useCallback(() => {
    void model.decide(job, pending ? "reject" : "cancel");
  }, [job, model, pending]);
  if (historical) return null;
  return (
    <>
      {pending && source ? (
        <View style={styles.actions}>
          <Button
            variant="destructive"
            disabled={busy || !isInstallReady(job)}
            onPress={install}
            testID={`restart-install-${job.id}`}
          >
            Install update and restart
          </Button>
          <Button variant="ghost" disabled={busy} onPress={cancel}>
            Cancel
          </Button>
        </View>
      ) : null}
      {pending && !source ? (
        <View style={styles.actions}>
          {!job.supervisorPlanSha256 ? (
            <Button
              variant="outline"
              disabled={busy || !installation?.idleRestarts || !job.impact?.idleRestartSupported}
              onPress={queue}
              testID={`restart-queue-${job.id}`}
            >
              Restart when idle
            </Button>
          ) : null}
          <Button
            variant="outline"
            disabled={
              busy || !installation?.gracefulRestarts || !job.impact?.gracefulRestartSupported
            }
            onPress={finish}
            testID={`restart-finish-${job.id}`}
          >
            Finish turns and restart
          </Button>
          <Button variant="ghost" disabled={busy} onPress={cancel}>
            Cancel
          </Button>
        </View>
      ) : null}
      {queued ? (
        <View style={styles.actions}>
          <Button variant="ghost" disabled={busy} onPress={cancel}>
            Cancel
          </Button>
          <RestartEscalation job={job} model={model} busy={busy} />
        </View>
      ) : null}
    </>
  );
}

function restartTargetLabel(job: RestartJob): string {
  if (job.supervisorPlanSha256) return "Dev supervisor";
  return job.target === "host" ? "Host" : "Dev container";
}

function RestartDetails({ job }: { job: RestartJob }) {
  const [expanded, setExpanded] = useState(false);
  const toggle = useCallback(() => setExpanded((value) => !value), []);
  const controlSize = useVortonTouch() ? "md" : "sm";
  const source = Boolean(job.update || job.sourceBatch);
  return (
    <View>
      <Button
        variant="ghost"
        size={controlSize}
        onPress={toggle}
        {...disclosureProps(expanded)}
        testID={`restart-details-${job.id}`}
      >
        Details
      </Button>
      {expanded ? (
        <View style={styles.details}>
          {source ? <SourceUpdateDetails job={job} /> : <RestartActivity job={job} />}
          {!source ? <Text style={styles.text}>{job.reason}</Text> : null}
          {job.supervisorPlanSha256 ? (
            <Text selectable style={styles.text}>
              Reviewed supervisor plan: {job.supervisorPlanSha256}
            </Text>
          ) : null}
          {job.status === "failed" ? <Text style={styles.error}>{job.detail}</Text> : null}
        </View>
      ) : null}
    </View>
  );
}

function SourceContribution({
  item,
}: {
  item: NonNullable<RestartJob["sourceBatch"]>["contributions"][number];
}) {
  return (
    <View>
      <Text style={styles.text}>
        {item.reason} ({item.status})
      </Text>
      <Text selectable style={styles.text}>
        {item.update.sourceCommit}
      </Text>
      {item.status === "conflict" || item.status === "invalid" ? (
        <Text selectable style={styles.error}>
          {item.detail}
        </Text>
      ) : null}
    </View>
  );
}

function SourceUpdateDetails({ job }: { job: RestartJob }) {
  const [historyVisible, setHistoryVisible] = useState(false);
  const toggleHistory = useCallback(() => setHistoryVisible((value) => !value), []);
  const controlSize = useVortonTouch() ? "md" : "sm";
  const contributions = job.sourceBatch?.contributions ?? [];
  const current = contributions.filter((item) => item.status !== "superseded");
  const history = contributions.filter((item) => item.status === "superseded");
  return (
    <View style={styles.details}>
      {job.sourceBatch ? (
        <>
          <Text style={styles.text}>{job.detail}</Text>
          {current.map((item) => (
            <SourceContribution key={item.id} item={item} />
          ))}
          {history.length ? (
            <View>
              <Button
                variant="ghost"
                size={controlSize}
                onPress={toggleHistory}
                {...disclosureProps(historyVisible)}
                testID={`source-history-${job.id}`}
              >
                {`Previous submissions (${history.length})`}
              </Button>
              {historyVisible
                ? history.map((item) => <SourceContribution key={item.id} item={item} />)
                : null}
            </View>
          ) : null}
        </>
      ) : null}
      {job.update ? (
        <Text selectable style={styles.text}>
          {job.target === "host" ? "Install interface and Host daemon" : "Install Dev daemon"} from
          source {job.update.sourceCommit}
          {"\n"}Bundle SHA-256: {job.update.sha256}
          {"\n"}
          {job.target === "host"
            ? "Approval allows this code and its build scripts to run on Host. The coordinator and Dev container are not updated."
            : "Approval allows this code and its build scripts to run inside Dev. The existing container and supervisor remain running. Host and the shared interface are not updated."}
        </Text>
      ) : null}
    </View>
  );
}

function RestartEscalation({
  job,
  model,
  busy,
}: {
  job: RestartJob;
  model: InstallationPanelModel;
  busy: boolean;
}) {
  const [appearsStuck, setAppearsStuck] = useState(false);
  const reportStuck = useCallback(() => setAppearsStuck(true), []);
  if (appearsStuck) return <ForceRestartButton job={job} model={model} busy={busy} />;
  return (
    <Button
      variant="outline"
      disabled={busy}
      onPress={reportStuck}
      testID={`restart-stuck-${job.id}`}
    >
      Restart appears stuck
    </Button>
  );
}

function ForceRestartButton({
  job,
  model,
  busy,
}: {
  job: RestartJob;
  model: InstallationPanelModel;
  busy: boolean;
}) {
  const force = useCallback(async () => {
    const confirmed = await confirmDialog({
      title: `Force restart ${restartTargetLabel(job)}?`,
      message: "Running tasks will be interrupted and terminals may disconnect.",
      confirmLabel: "Force restart now",
      destructive: true,
    });
    if (confirmed) await model.decide(job, "approve");
  }, [job, model]);
  return (
    <Button
      variant="destructive"
      disabled={busy}
      onPress={force}
      testID={`restart-force-${job.id}`}
    >
      Force restart now
    </Button>
  );
}

function RestartActivity({ job }: { job: RestartJob }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (job.status !== "approved" || !job.whenIdle) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [job.status, job.whenIdle]);
  const seconds = Math.max(
    0,
    Math.floor((now - Date.parse(job.approvedAt ?? job.createdAt)) / 1000),
  );
  const elapsed = `${Math.floor(seconds / 3600)}h ${Math.floor(seconds / 60) % 60}m ${seconds % 60}s`;
  return (
    <View style={styles.details}>
      {job.status === "approved" && job.whenIdle ? (
        <Text style={styles.text}>Waiting {elapsed}</Text>
      ) : null}
      {job.impact ? (
        <>
          <Text style={styles.text}>
            {job.impact.error ||
              `${job.impact.agents.length} active tasks · ${job.impact.pendingStarts} starting`}
          </Text>
          {!job.impact.idleRestartSupported && !job.impact.error ? (
            <Text style={styles.text}>
              This daemon needs an update before queued idle restarts can run.
            </Text>
          ) : null}
        </>
      ) : (
        <Text style={styles.text}>Checking affected agents…</Text>
      )}
    </View>
  );
}

export function InstallationRestartBanner() {
  const model = getInstallationPanel(useHostRegistryLoaded());
  return model ? <RestartBanner model={model} /> : null;
}

function RestartBanner({ model }: { model: InstallationPanelModel }) {
  const state = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  const router = useRouter();
  const open = useCallback(() => router.push("/settings/general?installation=1"), [router]);
  const pendingIds = new Set(state.pendingJobs.map((job) => job.id));
  const jobs = state.jobs.filter(
    (job) => pendingIds.has(job.id) || job.status === "approved" || job.status === "running",
  );
  if (!state.unlocked && state.restartSummary) {
    const summary = state.restartSummary;
    if (!summary.requested && !summary.queued && !summary.running) return null;
    return (
      <View testID="installation-restart-banner">
        <SidebarCallout
          title="Installation restarts"
          description={`${summary.requested} requested · ${summary.queued} queued · ${summary.running} restarting. Unlock controls to review details.`}
        />
        <Button variant="outline" onPress={open}>
          Review restart
        </Button>
      </View>
    );
  }
  if (!jobs.length) return null;
  return (
    <ScrollView style={styles.banner} testID="installation-restart-banner">
      {state.error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {state.error}
        </Text>
      ) : null}
      {jobs.map((job, index) => (
        <RestartBannerItem key={job.id} job={job} showTopBorder={index > 0} />
      ))}
    </ScrollView>
  );
}

function RestartBannerItem({ job, showTopBorder }: { job: RestartJob; showTopBorder: boolean }) {
  const router = useRouter();
  const open = useCallback(
    () =>
      router.push({
        pathname: "/settings/[section]",
        params: { section: "general", installation: "1", restart: job.id },
      }),
    [router, job.id],
  );
  const description = useMemo(
    () => (
      <View style={styles.details}>
        <Text style={styles.text}>
          {restartBlockingReason(job) ?? restartExplanation(job.reason).summary}
        </Text>
        {job.status === "approved" || job.status === "running" ? (
          <RestartActivity job={job} />
        ) : null}
        <View style={styles.actions}>
          <Button variant="outline" onPress={open}>
            Review restart
          </Button>
        </View>
      </View>
    ),
    [job, open],
  );
  const title = restartBannerTitle(job);
  const inProgress = job.status === "approved" || job.status === "running";
  const icon = useMemo(
    () =>
      inProgress ? (
        <View testID={`restart-progress-${job.id}`}>
          <ThemedLoadingSpinner uniProps={spinnerColor} size={16} />
        </View>
      ) : undefined,
    [inProgress, job.id],
  );
  return (
    <SidebarCallout
      title={title}
      icon={icon}
      description={description}
      showTopBorder={showTopBorder}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  banner: { maxHeight: 280, flexGrow: 0, borderTopWidth: 1, borderTopColor: theme.colors.border },
  details: { gap: theme.spacing[2] },
  unlockRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  passwordInput: { flexGrow: 1, flexBasis: 200 },
  textInset: { padding: theme.spacing[4] },
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
