import { MaintenanceServiceQueue } from "./maintenance-service-queue";
import { MaintenanceDashboard } from "./maintenance-dashboard";
import { RecoveryBookmark } from "./recovery-bookmark";
import { MaintenanceProvisioning } from "./maintenance-provisioning";
import { ClaimedRepairProvisioning } from "./claimed-repair-provisioning";
import { SettingsExpansion } from "@/components/settings/settings-expansion";
import type { PreviewMonitorJob } from "@getpaseo/protocol/preview-monitor-maintenance";
import {
  monitorActionDisabledReason,
  monitorReviewSummary,
  type MonitorAction,
} from "./preview-monitor-review";
import type { NativeHelperJob } from "@getpaseo/protocol/native-helper-maintenance";
import {
  helperActionDisabledReason,
  helperReviewSummary,
  lockedMaintenanceSummary,
  helperRollbackSummary,
  type HelperReviewAction,
} from "./helper-review";
import type { SessionHostJob } from "@getpaseo/protocol/session-host-maintenance";
import type { InstructionRequestQuery } from "@getpaseo/protocol/instruction-requests";
import { diffInstructionLines } from "./instruction-diff";
import {
  sessionHostActionDisabledReason,
  sessionHostOperationTitle,
  sessionHostPlanLines,
  sessionHostRequestDisabledReason,
  sessionHostRestartWarning,
  sessionHostReviewSummary,
  sessionHostStatusLines,
  visibleSessionHostJobs,
  type SessionHostAction,
  type SessionHostOverview,
} from "./session-host-review";
import { ActionFooter } from "@/components/ui/action-footer";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ComponentProps,
} from "react";
import { Pressable, Text, View } from "react-native";
import { CheckSquare, Square, Info, ChevronDown, ChevronUp } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import { isWeb } from "@/constants/platform";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { EditingTextInput } from "@/components/ui/text-input";
import { usePathname, useRouter } from "expo-router";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { settingsStyles } from "@/styles/settings";
import { StatusBadge, type StatusBadgeVariant } from "@/components/ui/status-badge";
import { MaintenanceNotice, MaintenanceNoticePlacement } from "./maintenance-notice";
import { confirmDialog } from "@/utils/confirm-dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";

import { getHostRuntimeStore, useHostRegistryLoaded } from "@/runtime/host-runtime";
import { useVortonTouch } from "@/vorton-touch";
import {
  getBootstrapPanel,
  BootstrapHistory,
  BootstrapReview,
  CoordinatorRecoveryHistory,
  HistoryGroup,
  useCoordinatorHistoryCount,
  BootstrapBanner,
  getPreclaimRecoveryPanel,
  getClaimedRecoveryPanel,
  ClaimedRecoveryReview,
  ClaimedRecoveryBanner,
  PreclaimRecoveryReview,
  PreclaimRecoveryBanner,
} from "./bootstrap-panel";
import { readExecutionInstallation } from "./policy";
import { InstallationClient, requestInstallationOwner, hasInstallationConnections } from "./client";
import {
  InstallationPanelModel,
  restartRequestSummary,
  restartBannerTitle,
  restartCancellable,
  delegationOverdueNote,
  restartNoticeVisible,
  restartBlockingReason,
  restartRepairGuidance,
  restartActionDisabledReason,
} from "./panel-model";
import type {
  MaintenanceService,
  ProfileSharingStatus,
  RestartJob,
  RestartSummary,
} from "@getpaseo/protocol/execution-installation";
import { restartOperationView } from "./restart-operations";

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
  // The model outlives this dialog; dismissed password drafts must not.
  useEffect(() => () => model.clearPasswordDraft(), [model]);
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
    <View style={styles.historyItem} testID="installation-welcome">
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
    void getPreclaimRecoveryPanel()?.refresh();
    void getClaimedRecoveryPanel()?.refresh();
    const timer = setInterval(() => {
      void model.refresh();
      void getBootstrapPanel()?.refresh(true);
      void getPreclaimRecoveryPanel()?.refresh(true);
      void getClaimedRecoveryPanel()?.refresh(true);
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
  if (job.delegatedTo && !historical)
    return { label: `Being handled by ${job.delegatedTo}`, variant: "muted" as const };
  if (job.status === "pending") {
    if (historical) return { label: "Superseded", variant: "muted" as const };
    const batchStatus = job.sourceBatch?.status;
    if (batchStatus && batchStatus !== "ready") {
      const labels = {
        preparing: "Combining source",
        waiting: "Next batch",
        conflict: "Source repair needed",
      };
      return { label: labels[batchStatus], variant: "warning" as const };
    }
    if (job.delegationOverdue)
      return { label: "Waiting longer than expected", variant: "warning" as const };
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

function CoordinatorMaintenanceReviews() {
  const bootstrap = getBootstrapPanel();
  const recovery = getPreclaimRecoveryPanel();
  const claimedRecovery = getClaimedRecoveryPanel();
  return (
    <>
      <MaintenanceProvisioning />
      <ClaimedRepairProvisioning />
      {claimedRecovery ? <ClaimedRecoveryReview model={claimedRecovery} /> : null}
      {recovery ? <PreclaimRecoveryReview model={recovery} /> : null}
      {bootstrap ? <BootstrapReview model={bootstrap} /> : null}
    </>
  );
}

/**
 * One history for everything finished: restarts and updates, coordinator
 * updates and coordinator recoveries. Only active work stays above it.
 */
function InstallationHistory({
  history,
  model,
  busy,
  requestId,
  visible,
  onToggle,
  controlSize,
}: {
  history: RestartJob[];
  model: InstallationPanelModel;
  busy: boolean;
  requestId: string | null;
  visible: boolean;
  onToggle: () => void;
  controlSize: "sm" | "md";
}) {
  const historyCount = history.length + useCoordinatorHistoryCount();
  const bootstrapModel = getBootstrapPanel();
  return (
    <View testID="restart-history" style={[styles.cardBody, settingsStyles.rowBorder]}>
      <View style={styles.requestHeader}>
        <Button
          variant="ghost"
          size={controlSize}
          onPress={onToggle}
          {...disclosureProps(visible)}
          testID="restart-history-toggle"
          disabled={!historyCount}
        >
          {visible ? "Hide history" : `History (${historyCount})`}
        </Button>
      </View>
      {visible ? (
        <SettingsExpansion testID="restart-history-content">
          {history.length ? (
            <HistoryGroup title="Restarts and updates">
              {history.slice(0, 20).map((job) => (
                <RestartRequest
                  key={`${job.id}:${job.revision}`}
                  job={job}
                  model={model}
                  busy={busy}
                  historical
                  linked={job.id === requestId}
                />
              ))}
            </HistoryGroup>
          ) : null}
          {bootstrapModel ? <BootstrapHistory model={bootstrapModel} /> : null}
          <CoordinatorRecoveryHistory />
        </SettingsExpansion>
      ) : null}
    </View>
  );
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
  const selectedHistoryId = selectedHistory?.id;
  const visibleHistory = selectedHistory
    ? [selectedHistory, ...history.filter((job) => job.id !== selectedHistory.id)]
    : history;
  useEffect(() => {
    if (selectedHistoryId) setHistoryVisible(true);
  }, [selectedHistoryId]);
  const missingRequest =
    requestId &&
    state.lastUpdatedAt &&
    ![...state.jobs, ...state.helperJobs, ...state.monitorJobs].some((job) => job.id === requestId);
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
        <CoordinatorMaintenanceReviews />
        <HelperActionError model={model} />
        {state.error ? (
          <Text accessibilityRole="alert" style={[styles.textInset, styles.error]}>
            {state.error}
          </Text>
        ) : null}
        {state.unlocked ? (
          <>
            <MaintenanceDashboard
              status={state.enrollmentStatus}
              error={state.enrollmentError}
              refreshing={state.enrollmentRefreshing}
              onRefresh={model.refreshEnrollmentStatus}
            >
              <RecoveryBookmark
                status={state.recoveryAccess}
                error={state.recoveryAccessError}
                refreshing={state.recoveryAccessRefreshing}
                onRefresh={model.refreshRecoveryAccess}
              />
            </MaintenanceDashboard>
            <MaintenanceServiceQueue
              status={state.serviceQueue}
              error={state.serviceQueueError}
              refreshing={state.serviceQueueRefreshing}
              busy={state.busy}
              onRefresh={model.refreshServiceQueue}
              onCancel={model.cancelMaintenanceService}
            />
            <DaemonAutomationControl model={model} state={state} />
            {state.monitorJobs.map((job) => (
              <MonitorRequest
                key={`${job.id}:${job.revision}`}
                job={job}
                model={model}
                busy={state.busy}
              />
            ))}
            {state.helperJobs.map((job) => (
              <HelperRequest
                key={`${job.id}:${job.revision}`}
                job={job}
                model={model}
                busy={state.busy}
              />
            ))}
            <SessionHostCard model={model} state={state} />
            <InstructionRequestsCard model={model} state={state} />
            {active.map((job) => (
              <RestartRequest
                key={`${job.id}:${job.revision}`}
                job={job}
                model={model}
                busy={state.busy}
                linked={job.id === requestId}
              />
            ))}
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
                  {sharingVisible ? "Hide profile sharing" : "Profile sharing"}
                </Button>
                <StatusBadge label={sharingLabel} variant={sharingVariant} />
              </View>
              {sharingVisible ? (
                <SettingsExpansion testID="installation-sharing-content">
                  <ProfileSharingStatusView
                    status={state.profileSharing}
                    model={model}
                    busy={state.busy}
                  />
                </SettingsExpansion>
              ) : null}
            </View>
            <InstallationHistory
              history={visibleHistory}
              model={model}
              busy={state.busy}
              requestId={requestId}
              visible={historyVisible}
              onToggle={toggleHistory}
              controlSize={controlSize}
            />
          </>
        ) : null}
      </View>
    </SettingsSection>
  );
}

const permissionRowStyle = {
  flexDirection: "row",
  alignItems: "center",
  flex: 1,
  gap: 8,
  minHeight: 44,
} as const;
const permissionInfoStyle = {
  minHeight: 44,
  minWidth: 44,
  alignItems: "center",
  justifyContent: "center",
} as const;
function MaintenancePermission({
  service,
  label,
  explanation,
  model,
  checked,
  disabled,
  readiness,
}: {
  service: MaintenanceService;
  label: string;
  explanation: string;
  model: InstallationPanelModel;
  checked: boolean;
  disabled: boolean;
  readiness: string;
}) {
  const change = useCallback(
    () => void model.changeDaemonAutomation(!checked, service),
    [model, checked, service],
  );
  const accessibilityState = useMemo(() => ({ checked, disabled }), [checked, disabled]);
  const Icon = checked ? CheckSquare : Square;
  return (
    <View>
      <View style={styles.requestHeader}>
        <Pressable
          accessibilityRole="checkbox"
          accessibilityLabel={`Automatically authorize ${label} maintenance`}
          accessibilityState={accessibilityState}
          aria-checked={checked}
          disabled={disabled}
          testID={`maintenance-permission-${service}`}
          style={permissionRowStyle}
          onPress={change}
        >
          <Icon size={20} color={styles.text.color} />
          <Text style={styles.text}>{label} maintenance</Text>
        </Pressable>
        <Tooltip enabledOnMobile>
          <TooltipTrigger
            accessibilityRole="button"
            accessibilityLabel={`About ${label} maintenance`}
            style={permissionInfoStyle}
            testID={`maintenance-info-${service}`}
          >
            <Info size={18} color={styles.text.color} />
          </TooltipTrigger>
          <TooltipContent maxWidth={360} testID={`maintenance-info-${service}-tooltip`}>
            <Text style={styles.text}>
              {explanation} Only authenticated Host threads qualify; Dev requests and mixed-origin
              source batches always need your approval. Requests remain visible and cancellable
              before dispatch. Turning this off revokes undispatched automatic grants; it does not
              stop an operation already running. Uncertain identity or exhausted recovery stops
              automation for the affected operation.
            </Text>
          </TooltipContent>
        </Tooltip>
      </View>
      <Text style={styles.text} testID={`maintenance-readiness-${service}`}>
        {readiness}
      </Text>
    </View>
  );
}

/**
 * Which request paths are automatic or manual right now. It explains the
 * permissions above, so it stays folded until asked for.
 */
function RequestReadiness({
  status,
}: {
  status: ReturnType<InstallationPanelModel["getState"]>["maintenanceStatus"];
}) {
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((value) => !value), []);
  if (!status) {
    return (
      <Text style={styles.text}>Detailed maintenance readiness requires a coordinator update.</Text>
    );
  }
  return (
    <View>
      <Button
        variant="ghost"
        size="sm"
        onPress={toggle}
        {...disclosureProps(open)}
        testID="maintenance-readiness-toggle"
      >
        {open ? "Hide request readiness" : "Request readiness"}
      </Button>
      {open ? (
        <SettingsExpansion testID="maintenance-readiness">
          {status.paths.map((item) => (
            <Text key={`${item.requester}-${item.target}-${item.operation}`} style={styles.text}>
              {item.requester === "host-agent" ? "Host" : "Dev"} request for{" "}
              {item.target === "host" ? "Host" : "Dev"}{" "}
              {item.operation === "restart" ? "restart" : "update"}:{" "}
              {item.readiness === "blocked" ? "blocked" : item.authorization}. {item.reason}
            </Text>
          ))}
        </SettingsExpansion>
      ) : null}
    </View>
  );
}

function FullMaintenanceDelegation({
  model,
  state,
}: {
  model: InstallationPanelModel;
  state: ReturnType<InstallationPanelModel["getState"]>;
}) {
  const delegation = state.maintenanceDelegation;
  const change = useCallback(
    () => void model.changeMaintenanceDelegation(!delegation?.enabled),
    [model, delegation?.enabled],
  );
  if (!delegation?.available) return null;
  return (
    <View>
      <Text style={styles.text}>
        {delegation.enabled
          ? "Full maintenance delegation is enabled."
          : "Full maintenance delegation is off."}{" "}
        Trusted Host requests can cover all supported updates, restarts and exact recovery plans.
        Degraded Docker recovery may interrupt unknown work. Plan checks and cancellation remain;
        failed operations stop for inspection.
      </Text>
      <Button
        size="md"
        disabled={state.busy || Boolean(state.maintenanceDelegationError)}
        onPress={change}
        testID="maintenance-delegation-change"
      >
        {delegation.enabled
          ? "Revoke full maintenance delegation"
          : "Delegate all supported maintenance"}
      </Button>
    </View>
  );
}

export function DaemonAutomationControl({
  model,
  state,
}: {
  model: InstallationPanelModel;
  state: ReturnType<InstallationPanelModel["getState"]>;
}) {
  if (!state.daemonAutomation)
    return (
      <View
        style={[styles.cardBody, settingsStyles.rowBorder]}
        testID="daemon-automation-unavailable"
      >
        <Text style={settingsStyles.rowTitle}>Automatic daemon updates and restarts</Text>
        <Text style={styles.text}>
          The selected coordinator does not support this preference. Update the coordinator through
          Installation controls. Existing approval rules remain in effect.
        </Text>
      </View>
    );
  return (
    <View style={[styles.cardBody, settingsStyles.rowBorder]} testID="daemon-automation-preference">
      <Text style={settingsStyles.rowTitle}>Automatic maintenance authorization</Text>
      <FullMaintenanceDelegation model={model} state={state} />
      {(
        [
          [
            "host",
            "Host",
            "Allows routine Host updates, build scripts and daemon restarts without another approval. Current turns finish before replacement; Host connections may briefly disconnect.",
          ],
          [
            "container-daemon",
            "Dev",
            "Allows routine Dev updates, build scripts and daemon restarts without another approval. Current turns finish before replacement; Dev connections may briefly disconnect.",
          ],
          [
            "coordinator",
            "Coordinator",
            "Allows maintenance of the service that manages installation requests. Maintenance controls may briefly be unavailable. Execution requires verified independent recovery and an exact compatible rollback plan.",
          ],
          [
            "supervisor",
            "Supervisor",
            "Allows maintenance of the process manager that keeps daemons running. Its managed daemon may also be interrupted. Execution requires supported admission, process preservation and verified recovery.",
          ],
        ] as const
      ).map(([service, label, explanation]) => {
        return (
          <MaintenancePermission
            key={service}
            service={service}
            label={label}
            explanation={explanation}
            model={model}
            checked={Boolean(
              state.maintenanceDelegation?.enabled || state.daemonAutomation?.services?.[service],
            )}
            disabled={
              state.busy ||
              Boolean(state.maintenanceDelegation?.enabled) ||
              !state.daemonAutomation?.services
            }
            readiness={
              state.maintenanceStatus?.services?.find((item) => item.service === service)?.reason ??
              "Checking maintenance readiness..."
            }
          />
        );
      })}
      {!state.daemonAutomation.services ? (
        <Text style={styles.text}>
          Update the coordinator to configure separate service permissions. Existing permissions
          remain in effect.
        </Text>
      ) : null}
      {state.daemonAutomation.legacyHostOnly && !state.maintenanceDelegation?.enabled ? (
        <Text style={styles.text}>
          Existing Host-only daemon permissions are retained. Coordinator and supervisor permissions
          require their own opt-in.
        </Text>
      ) : null}
      <RequestReadiness status={state.maintenanceStatus} />
      {state.maintenanceDelegationError ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {state.maintenanceDelegationError}
        </Text>
      ) : null}
      {state.daemonAutomationError ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {state.daemonAutomationError}
        </Text>
      ) : null}
      {state.notice ? (
        <Text accessibilityLiveRegion="polite" style={styles.text}>
          {state.notice}
        </Text>
      ) : null}
    </View>
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
            <SettingsExpansion>
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
            </SettingsExpansion>
          ) : null}
        </>
      ) : null}
      {state.unlocked ? (
        <Text style={styles.text}>
          {state.lastUpdatedAt
            ? `Updated ${new Date(state.lastUpdatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.`
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
      <View style={styles.historyItem}>
        <Text style={settingsStyles.rowTitle}>Waiting for compatible environments</Text>
        <Text style={styles.text}>
          Profile sharing starts when every environment is connected and supports shared workflows
        </Text>
      </View>
    );
  return (
    <View style={styles.sharedWorkflows}>
      <Text style={styles.text}>
        Workflows, model choices and provider defaults synchronize across environments. Account
        credentials and available providers stay local.
      </Text>
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
    <View style={styles.historyItem}>
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
      style={!historical && settingsStyles.rowBorder}
      nativeID={`restart-request-${job.id}`}
      testID={`restart-request-${job.id}`}
    >
      <View style={historical ? styles.historyItem : styles.cardBody}>
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

function MonitorRequest({
  job,
  model,
  busy,
}: {
  job: PreviewMonitorJob;
  model: InstallationPanelModel;
  busy: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const size = useVortonTouch() ? "md" : "sm";
  const toggle = useCallback(() => setExpanded((value) => !value), []);
  return (
    <View style={[styles.cardBody, settingsStyles.rowBorder]} testID={`monitor-request-${job.id}`}>
      <View style={styles.requestHeader}>
        <Text style={settingsStyles.rowTitle}>Dev preview monitor</Text>
        <StatusBadge
          label={job.stage === "recovery_required" ? "Needs inspection" : job.status}
          variant={job.stage === "recovery_required" ? "warning" : "muted"}
        />
      </View>
      <Text style={styles.text}>{monitorReviewSummary(job)}</Text>
      <Text style={styles.text}>{job.reason}</Text>
      <Button variant="ghost" size={size} onPress={toggle} {...disclosureProps(expanded)}>
        Details
      </Button>
      {expanded ? (
        <SettingsExpansion>
          <Text selectable style={styles.text}>
            {job.detail}
            {"\n"}Container: {job.plan.containerId}
            {"\n"}Target: {job.plan.destination}
            {"\n"}Source: {job.plan.sourceCommit}
            {"\n"}Candidate: {job.plan.candidate.sha256}
            {"\n"}Retained before: {job.plan.previous.sha256}
            {"\n"}Ancestry: {job.plan.ancestrySha256}
            {"\n"}Plan: {job.planSha256}
            {"\n"}Owner: root:root, mode 0755
          </Text>
        </SettingsExpansion>
      ) : null}
      {["pending", "approved"].includes(job.status) ? (
        <ActionFooter style={styles.actions}>
          {(["approve", "cancel"] as MonitorAction[]).map((action) => (
            <MonitorActionButton key={action} job={job} model={model} action={action} busy={busy} />
          ))}
        </ActionFooter>
      ) : null}
    </View>
  );
}

function MonitorActionButton({
  job,
  model,
  action,
  busy,
}: {
  job: PreviewMonitorJob;
  model: InstallationPanelModel;
  action: MonitorAction;
  busy: boolean;
}) {
  const size = useVortonTouch() ? "md" : "sm";
  const onPress = useCallback(() => {
    void model.decideMonitor(job, action);
  }, [model, job, action]);
  return (
    <RestartActionButton
      size={size}
      testID={`monitor-${job.id}-${action}`}
      variant={action === "approve" ? "destructive" : "outline"}
      disabledReason={monitorActionDisabledReason(job, action, { busy, unlocked: true })}
      onPress={onPress}
    >
      {action === "approve" ? "Replace preview monitor" : "Cancel"}
    </RestartActionButton>
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
        <SettingsExpansion>
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
        </SettingsExpansion>
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

/**
 * Agent-proposed changes to the shared agent instructions. Nothing changes until the owner presses
 * Apply, which applies exactly the text shown. Hidden for coordinators without instruction requests.
 */
function InstructionRequestsCard({
  model,
  state,
}: {
  model: InstallationPanelModel;
  state: ReturnType<InstallationPanelModel["getState"]>;
}) {
  const size = useVortonTouch() ? "md" : "sm";
  const overview = state.instructionRequests;
  if (!overview) return null;
  const pending = overview.requests.filter((request) => request.status === "pending");
  const recent = overview.requests
    .filter((request) => request.status !== "pending")
    .slice(-3)
    .toReversed();
  if (!pending.length && !recent.length && !state.instructionError) return null;
  return (
    <View style={[styles.cardBody, settingsStyles.rowBorder]} testID="instruction-requests-card">
      <View style={styles.requestHeader}>
        <Text style={settingsStyles.rowTitle}>Agent instruction changes</Text>
        <StatusBadge
          label={pending.length ? `${pending.length} pending` : "None pending"}
          variant={pending.length ? "warning" : "muted"}
        />
      </View>
      {state.instructionError ? (
        <>
          <Text accessibilityRole="alert" style={styles.error}>
            {state.instructionError}
          </Text>
          <Button variant="ghost" size={size} onPress={model.dismissInstructionError}>
            Dismiss
          </Button>
        </>
      ) : null}
      {pending.map((request) => (
        <InstructionRequestReview
          key={request.id}
          request={request}
          current={overview.appendSystemPrompt ?? ""}
          model={model}
          busy={state.busy}
        />
      ))}
      {recent.map((request) => (
        <Text key={request.id} style={styles.text} testID={`instruction-${request.id}-settled`}>
          {`${request.environment === "container" ? "Dev" : "Host"} request: ${request.status}${request.detail ? ` (${request.detail})` : ""}`}
        </Text>
      ))}
    </View>
  );
}

type InstructionRequest = InstructionRequestQuery["requests"][number];

function InstructionRequestReview({
  request,
  current,
  model,
  busy,
}: {
  request: InstructionRequest;
  current: string;
  model: InstallationPanelModel;
  busy: boolean;
}) {
  const size = useVortonTouch() ? "md" : "sm";
  const approve = useCallback(() => {
    void model.decideInstructionRequest(request, "approve");
  }, [model, request]);
  const reject = useCallback(() => {
    void model.decideInstructionRequest(request, "reject");
  }, [model, request]);
  const changes = useMemo(
    () => diffInstructionLines(current, request.appendSystemPrompt),
    [current, request.appendSystemPrompt],
  );
  // The source comes from the submitting credential, never from agent-written text.
  const fromDev = request.environment === "container";
  return (
    <View testID={`instruction-${request.id}`} style={styles.historyItem}>
      <View style={styles.requestHeader}>
        <StatusBadge
          label={fromDev ? "From Dev (untrusted)" : "From Host"}
          variant={fromDev ? "error" : "muted"}
        />
      </View>
      <Text selectable style={styles.text} numberOfLines={1}>
        {`Requester (as named by the agent): ${request.requester}`}
      </Text>
      <Text selectable style={styles.text}>{`Reason: ${request.reason}`}</Text>
      <Text style={settingsStyles.rowTitle}>Changes</Text>
      <View testID={`instruction-${request.id}-changes`}>
        {changes.map((line, index) => (
          <Text
            // Diff lines have no identity beyond position.
            // eslint-disable-next-line react/no-array-index-key
            key={index}
            selectable
            style={line.kind === "added" ? styles.diffAdded : styles.diffRemoved}
          >
            {`${line.kind === "added" ? "+ " : "- "}${line.text}`}
          </Text>
        ))}
      </View>
      <Text style={settingsStyles.rowTitle}>Full proposed instructions (applied exactly)</Text>
      <SettingsExpansion testID={`instruction-${request.id}-proposed`}>
        <Text selectable style={styles.text}>
          {request.appendSystemPrompt || "(empty)"}
        </Text>
      </SettingsExpansion>
      <Text style={settingsStyles.rowTitle}>Current instructions</Text>
      <SettingsExpansion>
        <Text selectable style={styles.text}>
          {current || "(empty)"}
        </Text>
      </SettingsExpansion>
      <Text style={styles.text}>
        New agent sessions use the applied text. Running Cursor, Copilot, Kimi and Kiro sessions
        keep the instructions they started with.
      </Text>
      <ActionFooter style={styles.actions}>
        <RestartActionButton
          testID={`instruction-${request.id}-reject`}
          size={size}
          variant="outline"
          disabledReason={busy ? "Another installation action is running" : null}
          onPress={reject}
        >
          Reject
        </RestartActionButton>
        <RestartActionButton
          testID={`instruction-${request.id}-approve`}
          size={size}
          variant="destructive"
          disabledReason={busy ? "Another installation action is running" : null}
          onPress={approve}
        >
          Apply to all agents
        </RestartActionButton>
      </ActionFooter>
    </View>
  );
}

/**
 * The session host's launchd job, owned by the coordinator. Hidden for coordinators without session
 * host jobs. Install and Remove only prepare a plan; each plan needs its own Approve.
 */
function SessionHostCard({
  model,
  state,
}: {
  model: InstallationPanelModel;
  state: ReturnType<InstallationPanelModel["getState"]>;
}) {
  const size = useVortonTouch() ? "md" : "sm";
  const install = useCallback(() => {
    void model.requestSessionHost("session-host-install");
  }, [model]);
  const remove = useCallback(() => {
    void model.requestSessionHost("session-host-remove");
  }, [model]);
  const restart = useCallback(() => {
    void model.requestSessionHost("session-host-restart");
  }, [model]);
  const overview = state.sessionHost;
  if (!overview) return null;
  const review = { busy: state.busy, unlocked: state.unlocked };
  return (
    <>
      <View style={[styles.cardBody, settingsStyles.rowBorder]} testID="session-host-card">
        <View style={styles.requestHeader}>
          <Text style={settingsStyles.rowTitle}>Session host</Text>
          <StatusBadge
            label={sessionHostBadge(overview.status)}
            variant={overview.status?.installed ? "success" : "muted"}
          />
        </View>
        <Text selectable style={styles.text} testID="session-host-status">
          {sessionHostStatusLines(overview.status).join("\n")}
        </Text>
        {state.sessionHostError ? (
          <>
            <Text accessibilityRole="alert" style={styles.error}>
              {state.sessionHostError}
            </Text>
            <Button variant="ghost" size={size} onPress={model.dismissSessionHostError}>
              Dismiss
            </Button>
          </>
        ) : null}
        <ActionFooter style={styles.actions}>
          <RestartActionButton
            testID="session-host-install"
            size={size}
            variant="outline"
            disabledReason={sessionHostRequestDisabledReason(
              "session-host-install",
              overview,
              review,
            )}
            onPress={install}
          >
            Install
          </RestartActionButton>
          <RestartActionButton
            testID="session-host-remove"
            size={size}
            variant="outline"
            disabledReason={sessionHostRequestDisabledReason(
              "session-host-remove",
              overview,
              review,
            )}
            onPress={remove}
          >
            Remove
          </RestartActionButton>
          {overview.restartSupported ? (
            <RestartActionButton
              testID="session-host-restart"
              size={size}
              variant="outline"
              disabledReason={sessionHostRequestDisabledReason(
                "session-host-restart",
                overview,
                review,
              )}
              onPress={restart}
            >
              Restart
            </RestartActionButton>
          ) : null}
        </ActionFooter>
        {overview.restartSupported &&
        sessionHostRequestDisabledReason("session-host-restart", overview, review) === null ? (
          <Text style={styles.text} testID="session-host-restart-warning">
            {sessionHostRestartWarning(overview.status)}
          </Text>
        ) : null}
      </View>
      {visibleSessionHostJobs(overview.jobs).map((job) => (
        <SessionHostRequest
          key={`${job.id}:${job.revision}`}
          job={job}
          model={model}
          busy={state.busy}
        />
      ))}
    </>
  );
}

function sessionHostBadge(status: SessionHostOverview["status"]): string {
  if (!status) return "Unknown";
  return status.installed ? "Installed" : "Not installed";
}

function SessionHostRequest({
  job,
  model,
  busy,
}: {
  job: SessionHostJob;
  model: InstallationPanelModel;
  busy: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const size = useVortonTouch() ? "md" : "sm";
  const toggle = useCallback(() => setExpanded((value) => !value), []);
  // An open request shows its whole plan: the owner approves exactly these facts.
  const reviewing = job.status === "pending" || job.status === "approved";
  return (
    <View
      style={[styles.cardBody, settingsStyles.rowBorder]}
      testID={`session-host-request-${job.id}`}
    >
      <View style={styles.requestHeader}>
        <Text style={settingsStyles.rowTitle}>{sessionHostOperationTitle(job.operation)}</Text>
        <StatusBadge label={job.status} variant={job.status === "failed" ? "warning" : "muted"} />
      </View>
      <Text style={styles.text}>{sessionHostReviewSummary(job)}</Text>
      <Text style={styles.text}>{job.reason}</Text>
      {reviewing ? null : (
        <Button variant="ghost" size={size} onPress={toggle} {...disclosureProps(expanded)}>
          Details
        </Button>
      )}
      {reviewing || expanded ? (
        <Text selectable style={styles.text}>
          {[job.detail, ...sessionHostPlanLines(job)].join("\n")}
        </Text>
      ) : null}
      {reviewing ? (
        <ActionFooter style={styles.actions}>
          {(["approve", "cancel"] as SessionHostAction[]).map((action) => (
            <SessionHostActionButton
              key={action}
              job={job}
              model={model}
              action={action}
              busy={busy}
            />
          ))}
        </ActionFooter>
      ) : null}
    </View>
  );
}

function SessionHostActionButton({
  job,
  model,
  action,
  busy,
}: {
  job: SessionHostJob;
  model: InstallationPanelModel;
  action: SessionHostAction;
  busy: boolean;
}) {
  const size = useVortonTouch() ? "md" : "sm";
  const onPress = useCallback(() => {
    void model.decideSessionHost(job, action);
  }, [model, job, action]);
  return (
    <RestartActionButton
      testID={`session-host-${job.id}-${action}`}
      size={size}
      variant={action === "approve" ? "destructive" : "outline"}
      disabledReason={sessionHostActionDisabledReason(job, action, { busy, unlocked: true })}
      onPress={onPress}
    >
      {action === "approve" ? "Approve" : "Cancel"}
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

function DevRepairAction({
  job,
  model,
  busy,
}: {
  job: RestartJob;
  model: InstallationPanelModel;
  busy: boolean;
}) {
  const state = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  const prepare = useCallback(() => {
    void model.prepareDevRepair(job);
  }, [job, model]);
  if (
    job.target !== "container-daemon" ||
    job.sourceBatch?.status !== "conflict" ||
    !state.devRepair.available
  )
    return null;
  const preparing = state.devRepair.preparingIds.includes(job.id);
  return (
    <Button
      variant="outline"
      disabled={busy || preparing}
      onPress={prepare}
      testID={`dev-repair-${job.id}`}
    >
      {preparing ? "Preparing repair" : "Prepare Dev repair"}
    </Button>
  );
}

/** Reviewed plan operations run only after held turns finish, never when idle. */
function isPlanBound(job: RestartJob): boolean {
  return restartOperationView(job) !== undefined;
}

function isPlainHostRestart(job: RestartJob): boolean {
  return job.target === "host" && !isPlanBound(job);
}

function finishLabel(job: RestartJob): string {
  return restartOperationView(job)?.finishLabel ?? "Finish turns and restart";
}

export function RestartActions({
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
  const plainHostRestart = isPlainHostRestart(job);
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
          <DevRepairAction job={job} model={model} busy={busy} />
          <Button variant="ghost" disabled={busy} onPress={cancel}>
            Cancel update
          </Button>
        </ActionFooter>
      ) : null}
      {pending && !source ? (
        <ActionFooter style={styles.actions}>
          {!isPlanBound(job) ? (
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
          {job.engineRecoveryPlanSha256 ? (
            <RestartActionButton
              variant="destructive"
              disabledReason={busy ? "Request in progress" : null}
              onPress={install}
              testID={`restart-recover-${job.id}`}
            >
              Recover Docker now, interrupt unknown work
            </RestartActionButton>
          ) : (
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
              {finishLabel(job)}
            </RestartActionButton>
          )}
          {plainHostRestart ? <ForceRestartButton job={job} model={model} busy={busy} /> : null}
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
  const view = restartOperationView(job);
  return view?.cardTarget ?? view?.target ?? (job.target === "host" ? "Host" : "Dev container");
}

function RestartDetails({ job }: { job: RestartJob }) {
  const [expanded, setExpanded] = useState(false);
  const toggle = useCallback(() => setExpanded((value) => !value), []);
  const controlSize = useVortonTouch() ? "md" : "sm";
  const source = Boolean(job.update || job.sourceBatch);
  const operation = restartOperationView(job);
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
        <SettingsExpansion>
          {source ? <SourceUpdateDetails job={job} /> : <RestartActivity job={job} />}
          {!source ? <Text style={styles.text}>{job.reason}</Text> : null}
          {operation ? (
            <Text selectable style={styles.text}>
              {operation.detail(job[operation.field]!)}
            </Text>
          ) : null}
          {job.factoryRuntimeRecoveryOf ? (
            <Text selectable style={styles.text}>
              Recover the unresolved startup selection from request {job.factoryRuntimeRecoveryOf}.
              This plan must reconcile the retained selection before restarting Dev.
            </Text>
          ) : null}
          {job.factoryRuntimeRecoveredBy ? (
            <Text selectable style={styles.text}>
              Recovery verified by request {job.factoryRuntimeRecoveredBy}.
            </Text>
          ) : null}
          {job.status === "failed" ? <Text style={styles.error}>{job.detail}</Text> : null}
        </SettingsExpansion>
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
    <View style={styles.historyItem}>
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
              {historyVisible ? (
                <SettingsExpansion>
                  {history.map((item) => (
                    <SourceContribution key={item.id} item={item} />
                  ))}
                </SettingsExpansion>
              ) : null}
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
    <View style={styles.historyItem}>
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

const NO_SUBSCRIPTION = () => () => {};

/**
 * Restart requests waiting on the owner, for the Settings attention strip.
 * Locked controls only expose the summary count.
 */
export function useRestartsAwaitingApproval(): number {
  const model = getInstallationPanel(useHostRegistryLoaded());
  const getState = useCallback(() => model?.getState() ?? null, [model]);
  const state = useSyncExternalStore(model?.subscribe ?? NO_SUBSCRIPTION, getState, getState);
  if (!state) return 0;
  return state.unlocked ? state.pendingJobs.length : (state.restartSummary?.requested ?? 0);
}

export function InstallationRestartBanner({
  placement = "floating",
}: {
  placement?: "floating" | "sidebar" | "rail";
}) {
  const model = getInstallationPanel(useHostRegistryLoaded());
  const bootstrap = getBootstrapPanel();
  const recovery = getPreclaimRecoveryPanel();
  const claimedRecovery = getClaimedRecoveryPanel();
  return (
    <MaintenanceNoticePlacement.Provider value={placement}>
      {placement !== "floating" ? <MaintenanceProvisioning banner /> : null}
      {placement !== "floating" ? <ClaimedRepairProvisioning banner /> : null}
      {placement !== "floating" && claimedRecovery ? (
        <ClaimedRecoveryBanner model={claimedRecovery} />
      ) : null}
      {placement !== "floating" && recovery ? <PreclaimRecoveryBanner model={recovery} /> : null}
      {bootstrap ? <BootstrapBanner model={bootstrap} /> : null}
      {model ? <RestartBanner model={model} /> : null}
    </MaintenanceNoticePlacement.Provider>
  );
}

function restartSummaryNeedsAction(summary: RestartSummary) {
  return [
    summary.requested,
    summary.serviceMaintenance?.requested,
    summary.serviceMaintenance?.attention,
    summary.nativeHelper?.requested,
    summary.nativeHelper?.recovery,
    summary.sessionHost?.requested,
    summary.previewMonitor?.requested,
    summary.previewMonitor?.recovery,
  ].some((count) => (count ?? 0) > 0);
}

function RestartBanner({ model }: { model: InstallationPanelModel }) {
  const state = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  const router = useRouter();
  const open = useCallback(() => router.push("/settings/general?installation=1"), [router]);
  const pendingIds = new Set(state.pendingJobs.map((job) => job.id));
  const jobs = state.jobs.filter((job) => {
    const active = pendingIds.has(job.id) || job.status === "approved" || job.status === "running";
    return active && restartNoticeVisible(job);
  });
  if (!state.unlocked && state.restartSummary) {
    const summary = state.restartSummary;
    const serviceCount = summary.serviceMaintenance
      ? summary.serviceMaintenance.requested +
        summary.serviceMaintenance.queued +
        summary.serviceMaintenance.unverified
      : 0;
    const description = lockedMaintenanceSummary(summary);
    if (!description) return null;
    return (
      <View testID="installation-restart-banner">
        <MaintenanceNotice
          sidebarOnly={serviceCount > 0}
          needsAction={restartSummaryNeedsAction(summary)}
          revision={description}
          title="Installation maintenance"
          description={description}
          reviewLabel="Review restart"
          onReview={open}
        />
      </View>
    );
  }
  const helpers = state.helperJobs.filter(
    (job) =>
      ["pending", "approved", "running"].includes(job.status) || job.stage === "recovery_required",
  );
  const monitors = state.monitorJobs.filter(
    (job) =>
      ["pending", "approved", "running"].includes(job.status) || job.stage === "recovery_required",
  );
  const services = (state.serviceQueue?.jobs ?? []).filter((job) =>
    ["pending", "approved", "running", "failed"].includes(job.status),
  );
  if (!jobs.length && !helpers.length && !monitors.length && !services.length) return null;
  return (
    <View testID="installation-restart-banner">
      {state.error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {state.error}
        </Text>
      ) : null}
      {services.map((job) => (
        <MaintenanceNotice
          sidebarOnly
          testID={`maintenance-service-notice-${job.id}`}
          key={job.id}
          needsAction={job.status === "pending" || job.status === "failed"}
          revision={`${job.id}:${job.revision}:${job.status}`}
          title={
            job.target === "maintenance-controller"
              ? "Controller maintenance"
              : "Recovery launcher maintenance"
          }
          description={job.status === "running" ? `Outcome unverified. ${job.detail}` : job.detail}
          reviewLabel="Review maintenance"
          onReview={open}
        />
      ))}
      {monitors.map((job) => (
        <View key={job.id}>
          <MaintenanceNotice
            needsAction={job.status === "pending" || job.stage === "recovery_required"}
            revision={`${job.id}:${job.revision}:${job.status}:${job.stage}`}
            title="Preview monitor maintenance"
            description={monitorReviewSummary(job)}
            reviewLabel="Review monitor"
            onReview={open}
          />
        </View>
      ))}
      {helpers.map((job) => (
        <View key={job.id}>
          <MaintenanceNotice
            needsAction={job.status === "pending" || job.stage === "recovery_required"}
            revision={`${job.id}:${job.revision}:${job.status}:${job.stage}`}
            title="Native helper maintenance"
            description={helperReviewSummary(job)}
            reviewLabel="Review helper"
            onReview={open}
          />
        </View>
      ))}
      {jobs.map((job) => (
        <RestartBannerItem key={job.id} job={job} model={model} />
      ))}
    </View>
  );
}

function RestartBannerItem({ job, model }: { job: RestartJob; model: InstallationPanelModel }) {
  const router = useRouter();
  const delegated = Boolean(job.delegatedTo);
  const cancel = useCallback(() => {
    void model.decide(job, job.status === "pending" ? "reject" : "cancel");
  }, [job, model]);
  const open = useCallback(
    () =>
      router.push({
        pathname: "/settings/[section]",
        params: { section: "general", installation: "1", restart: job.id },
      }),
    [router, job.id],
  );
  return (
    <MaintenanceNotice
      title={restartBannerTitle(job)}
      description={
        delegated
          ? job.reason
          : [delegationOverdueNote(job), restartRepairGuidance(job) ?? restartRequestSummary(job)]
              .filter(Boolean)
              .join(" ")
      }
      // A delegate is handling it, so it is status rather than a request for approval.
      needsAction={job.status === "pending" && !delegated}
      onCancel={delegated && restartCancellable(job) ? cancel : undefined}
      revision={`${job.id}:${job.revision}:${job.status}:${job.sourceBatch?.status ?? ""}`}
      reviewLabel={job.update || job.sourceBatch ? "Review update" : "Review restart"}
      onReview={open}
      testID={`restart-notice-${job.id}`}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  disabledAction: { position: "relative", alignSelf: "flex-start" },
  unlockRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  passwordInput: { flexGrow: 1, flexBasis: 200 },
  textInset: { padding: theme.spacing[4] },
  cardBody: { padding: theme.spacing[4], gap: theme.spacing[2] },
  historyItem: { gap: theme.spacing[2] },
  sharedWorkflows: { gap: theme.spacing[4] },
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
  diffAdded: {
    color: theme.colors.diffAddition,
    fontSize: theme.fontSize.sm,
    fontFamily: "monospace",
  },
  diffRemoved: {
    color: theme.colors.diffDeletion,
    fontSize: theme.fontSize.sm,
    fontFamily: "monospace",
  },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.base },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[2] },
}));
