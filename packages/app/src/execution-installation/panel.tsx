import type { NativeHelperJob } from "@getpaseo/protocol/native-helper-maintenance";
import {
  helperActionDisabledReason,
  helperReviewSummary,
  lockedMaintenanceSummary,
  helperRollbackSummary,
  type HelperReviewAction,
} from "./helper-review";
import { ActionFooter } from "@/components/ui/action-footer";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ComponentProps,
} from "react";
import { Text, View } from "react-native";
import { ChevronDown, ChevronUp } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { isWeb } from "@/constants/platform";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { EditingTextInput } from "@/components/ui/text-input";
import { usePathname, useRouter } from "expo-router";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { settingsStyles } from "@/styles/settings";
import { StatusBadge, type StatusBadgeVariant } from "@/components/ui/status-badge";
import { SidebarCallout } from "@/components/sidebar-callout";
import { confirmDialog } from "@/utils/confirm-dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import type { Theme } from "@/styles/theme";

import { getHostRuntimeStore, useHostRegistryLoaded } from "@/runtime/host-runtime";
import { useVortonTouch } from "@/vorton-touch";
import { getBootstrapPanel, BootstrapReview, BootstrapBanner } from "./bootstrap-panel";
import { readExecutionInstallation } from "./policy";
import { InstallationClient, requestInstallationOwner, hasInstallationConnections } from "./client";
import {
  InstallationPanelModel,
  restartRequestSummary,
  restartBannerTitle,
  restartBlockingReason,
  restartRepairGuidance,
  restartActionDisabledReason,
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

export function InstallationWelcome() {
  const model = getInstallationPanel(useHostRegistryLoaded());
  return model ? <InstallationWelcomeForm model={model} /> : null;
}

function InstallationWelcomeForm({ model }: { model: InstallationPanelModel }) {
  const state = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  const setPassword = useCallback((value: string) => model.setPassword(value), [model]);
  const connect = useCallback(() => {
    if (model.getState().password.trim()) void model.unlock();
  }, [model]);
  if (!state.initialized) {
    return <Text style={styles.text}>Checking owner access...</Text>;
  }
  if (state.unlocked) {
    return (
      <Text accessibilityLiveRegion="polite" style={styles.text}>
        Signed in. Connecting to your environments. Keep Tailscale connected on this device.
      </Text>
    );
  }
  return (
    <View style={styles.details} testID="installation-welcome">
      <Field label="Owner password">
        <FormTextInput
          size="md"
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="current-password"
          textContentType="password"
          initialValue=""
          onChangeText={setPassword}
          onSubmitEditing={connect}
          returnKeyType="go"
          editable={!state.busy}
          accessibilityLabel="Owner password"
          testID="installation-password"
        />
      </Field>
      {state.error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {state.error}
        </Text>
      ) : null}
      <Button
        size="lg"
        disabled={state.busy || !state.password.trim()}
        onPress={connect}
        testID="installation-unlock"
      >
        {state.busy ? "Connecting..." : "Connect"}
      </Button>
    </View>
  );
}

export function InstallationControls({ requestId = null }: { requestId?: string | null }) {
  const registryLoaded = useHostRegistryLoaded();
  const model = getInstallationPanel(registryLoaded);
  if (!model) return null;
  return <InstallationPanel model={model} requestId={requestId} />;
}

// Session restoration stays app-wide. New devices sign in on the welcome page;
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
    void getBootstrapPanel()?.refresh();
    const timer = setInterval(() => {
      void model.refresh();
      void getBootstrapPanel()?.refresh(true);
    }, 5000);
    return () => clearInterval(timer);
  }, [model]);
  useEffect(() => {
    if (!state.initialized || state.busy || !state.visible) return;
    model.close();
    const inSettings = pathname === "/settings" || pathname.startsWith("/settings/");
    if (!inSettings) router.replace(state.unlocked ? "/settings/general" : "/welcome");
  }, [model, pathname, router, state.busy, state.initialized, state.visible, state.unlocked]);
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
        conflict: "Awaiting agent repair",
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
  const bootstrap = getBootstrapPanel();
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
    requestId &&
    state.lastUpdatedAt &&
    ![...state.jobs, ...state.helperJobs].some((job) => job.id === requestId);
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
        {bootstrap ? <BootstrapReview model={bootstrap} /> : null}
        <HelperActionError model={model} />
        {state.error ? (
          <Text accessibilityRole="alert" style={[styles.textInset, styles.error]}>
            {state.error}
          </Text>
        ) : null}
        {state.unlocked ? (
          <>
            {state.helperJobs.map((job) => (
              <HelperRequest
                key={`${job.id}:${job.revision}`}
                job={job}
                model={model}
                busy={state.busy}
              />
            ))}
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
            ? `Updated ${new Date(state.lastUpdatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}. Dev requests require your approval.`
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
          {restartRepairGuidance(job) ?? restartRequestSummary(job)}
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

function HelperActionError({ model }: { model: InstallationPanelModel }) {
  const state = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  const dismiss = useCallback(() => model.dismissHelperError(), [model]);
  if (!state.helperError) return null;
  return (
    <View style={styles.cardBody}>
      <Text accessibilityRole="alert" style={styles.error}>
        {state.helperError}
      </Text>
      <Button variant="ghost" onPress={dismiss}>
        Dismiss
      </Button>
    </View>
  );
}

function HelperRequest({
  job,
  model,
  busy,
}: {
  job: NativeHelperJob;
  model: InstallationPanelModel;
  busy: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const controlSize = useVortonTouch() ? "md" : "sm";
  const toggle = useCallback(() => setExpanded((value) => !value), []);
  let actions: HelperReviewAction[] = [];
  if (job.stage === "recovery_required") actions = ["verify-installed"];
  else if (job.status === "pending" || job.status === "approved") actions = ["approve", "cancel"];
  return (
    <View style={[styles.cardBody, settingsStyles.rowBorder]} testID={`helper-request-${job.id}`}>
      <View style={styles.requestHeader}>
        <Text style={settingsStyles.rowTitle}>Native helper</Text>
        <StatusBadge
          label={job.stage === "recovery_required" ? "Needs recovery" : job.status}
          variant={job.stage === "recovery_required" ? "warning" : "muted"}
        />
      </View>
      <Text style={styles.text}>{helperReviewSummary(job)}</Text>
      <Button variant="ghost" size={controlSize} onPress={toggle} {...disclosureProps(expanded)}>
        Details
      </Button>
      {expanded ? (
        <View style={styles.details}>
          <Text style={styles.text}>{job.reason}</Text>
          <Text style={styles.text}>{job.detail}</Text>
          <Text selectable style={styles.text}>
            Source: {job.plan.candidate.sourceCommit}
            {"\n"}Artifact: {job.plan.candidate.artifactSha256}
            {"\n"}Plan: {job.planSha256}
          </Text>
          <Text selectable style={styles.text}>
            Signing:{" "}
            {job.plan.candidate.signingMode === "developer-id" ? "Developer ID" : "Local identity"}
            {"\n"}Helper identity: {job.plan.candidate.helperRequirement}
            {"\n"}Client identity: {job.plan.candidate.clientRequirement}
          </Text>
          <Text selectable style={styles.text}>
            {helperRollbackSummary(job.plan)}
          </Text>
        </View>
      ) : null}
      <ActionFooter style={styles.actions}>
        {actions.map((action) => (
          <HelperActionButton key={action} job={job} model={model} busy={busy} action={action} />
        ))}
      </ActionFooter>
    </View>
  );
}

function HelperActionButton({
  job,
  model,
  busy,
  action,
}: {
  job: NativeHelperJob;
  model: InstallationPanelModel;
  busy: boolean;
  action: HelperReviewAction;
}) {
  const size = useVortonTouch() ? "md" : "sm";
  const onPress = useCallback(() => {
    void model.decideHelper(job, action);
  }, [model, job, action]);
  const labels = {
    approve: job.operation === "native-helper-rollback" ? "Restore helper" : "Install helper",
    cancel: "Cancel",
    "verify-installed": "Verify installed helper",
  };
  return (
    <RestartActionButton
      testID={`helper-${job.id}-${action}`}
      size={size}
      variant={action === "approve" ? "destructive" : "outline"}
      disabledReason={helperActionDisabledReason(job, action, { busy, unlocked: true })}
      onPress={onPress}
    >
      {labels[action]}
    </RestartActionButton>
  );
}

function RestartActionButton({
  disabledReason,
  ...props
}: ComponentProps<typeof Button> & { disabledReason: string | null }) {
  if (!disabledReason) return <Button {...props} />;
  // A separate hit target avoids browsers suppressing taps on a disabled descendant.
  return (
    <Tooltip enabledOnMobile>
      <View style={styles.disabledAction}>
        <Button {...props} disabled accessible={false} focusable={false} />
        <TooltipTrigger
          style={StyleSheet.absoluteFillObject}
          accessibilityRole="button"
          accessibilityLabel={`Why ${String(props.children)} is unavailable`}
          accessibilityHint={disabledReason}
          testID={`${props.testID}-explanation`}
        />
      </View>
      <TooltipContent maxWidth={360} testID={`${props.testID}-tooltip`}>
        <Text style={styles.text}>{disabledReason}</Text>
      </TooltipContent>
    </Tooltip>
  );
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
        <ActionFooter style={styles.actions}>
          <RestartActionButton
            variant="destructive"
            disabledReason={restartActionDisabledReason(job, "install", busy)}
            onPress={install}
            testID={`restart-install-${job.id}`}
          >
            Install update and restart
          </RestartActionButton>
          <Button variant="ghost" disabled={busy} onPress={cancel}>
            Cancel update
          </Button>
        </ActionFooter>
      ) : null}
      {pending && !source ? (
        <ActionFooter style={styles.actions}>
          {!job.supervisorPlanSha256 ? (
            <RestartActionButton
              variant="outline"
              disabledReason={restartActionDisabledReason(
                job,
                "idle",
                busy,
                Boolean(installation?.idleRestarts && job.impact?.idleRestartSupported),
              )}
              onPress={queue}
              testID={`restart-queue-${job.id}`}
            >
              Restart when idle
            </RestartActionButton>
          ) : null}
          <RestartActionButton
            variant="outline"
            disabledReason={restartActionDisabledReason(
              job,
              "finish",
              busy,
              Boolean(installation?.gracefulRestarts && job.impact?.gracefulRestartSupported),
            )}
            onPress={finish}
            testID={`restart-finish-${job.id}`}
          >
            Finish turns and restart
          </RestartActionButton>
          <Button variant="ghost" disabled={busy} onPress={cancel}>
            Cancel
          </Button>
        </ActionFooter>
      ) : null}
      {queued ? (
        <ActionFooter style={styles.actions}>
          <Button variant="ghost" disabled={busy} onPress={cancel}>
            Cancel
          </Button>
          <RestartEscalation job={job} model={model} busy={busy} />
        </ActionFooter>
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
  const bootstrap = getBootstrapPanel();
  return (
    <>
      {bootstrap ? <BootstrapBanner model={bootstrap} /> : null}
      {model ? <RestartBanner model={model} /> : null}
    </>
  );
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
    const description = lockedMaintenanceSummary(summary);
    if (!description) return null;
    return (
      <View testID="installation-restart-banner">
        <SidebarCallout
          title="Installation maintenance"
          description={description}
          actions={[{ label: "Review restart", onPress: open }]}
        />
      </View>
    );
  }
  const helpers = state.helperJobs.filter(
    (job) =>
      ["pending", "approved", "running"].includes(job.status) || job.stage === "recovery_required",
  );
  if (!jobs.length && !helpers.length) return null;
  return (
    <View testID="installation-restart-banner">
      {state.error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {state.error}
        </Text>
      ) : null}
      {helpers.map((job) => (
        <View key={job.id}>
          <SidebarCallout
            title="Native helper maintenance"
            description={helperReviewSummary(job)}
            actions={[{ label: "Review helper", onPress: open }]}
          />
        </View>
      ))}
      {jobs.map((job) => (
        <RestartBannerItem key={job.id} job={job} showTopBorder={true} />
      ))}
    </View>
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
        <Text style={styles.text}>{restartRepairGuidance(job) ?? restartRequestSummary(job)}</Text>
        {job.status === "approved" || job.status === "running" ? (
          <RestartActivity job={job} />
        ) : null}
      </View>
    ),
    [job],
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
      actions={[
        {
          label: job.update || job.sourceBatch ? "Review update" : "Review restart",
          onPress: open,
        },
      ]}
      icon={icon}
      description={description}
      showTopBorder={showTopBorder}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  disabledAction: { position: "relative", alignSelf: "flex-start" },
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
