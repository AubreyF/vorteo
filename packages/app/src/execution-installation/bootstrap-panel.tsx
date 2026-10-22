import { isWeb } from "@/constants/platform";
import { ClaimedRepairClient } from "./claimed-repair-client";
import { SettingsExpansion } from "@/components/settings/settings-expansion";
import { useCallback, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { Text, View } from "react-native";
import { useRouter } from "expo-router";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { EditingTextInput } from "@/components/ui/text-input";
import { StatusBadge } from "@/components/ui/status-badge";
import { MaintenanceNotice } from "./maintenance-notice";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { settingsStyles } from "@/styles/settings";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { readExecutionInstallation } from "./policy";
import {
  BootstrapPanelModel,
  bootstrapDecisionDisabledReason,
  bootstrapNeedsAttention,
  bootstrapStatus,
  bootstrapAutomaticDetail,
  bootstrapRequiresOwnerAction,
  currentBootstrapRequests,
  preclaimRecoveryStatus,
  preclaimRecoveryNeedsAttention,
  preclaimDispatchDescription,
  recoveryTargetDescription,
  type BootstrapRecoveryRequest,
} from "./bootstrap-model";
import type {
  CoordinatorBootstrapRequestView as CoordinatorBootstrapRequest,
  BootstrapPreclaimRecoveryRequestView as BootstrapPreclaimRecoveryRequest,
  BootstrapClaimedRecoveryRequestView,
} from "@getpaseo/protocol/coordinator-bootstrap";

const expanded = { expanded: true };
const collapsed = { expanded: false };
const models = new Map<string, BootstrapPanelModel>();
type RecoveryPanelModel = BootstrapPanelModel<BootstrapPreclaimRecoveryRequest>;
const recoveryModels = new Map<string, RecoveryPanelModel>();
export function getPreclaimRecoveryPanel(): RecoveryPanelModel | null {
  const installation = readExecutionInstallation();
  const host = installation?.environments.find((environment) => environment.kind === "host");
  if (!installation || !host) return null;
  const key = `${installation.installationId}:${host.serverId}`;
  let model = recoveryModels.get(key);
  if (!model) {
    model = new BootstrapPanelModel<BootstrapPreclaimRecoveryRequest>(() => {
      const client = getHostRuntimeStore().getClient(host.serverId);
      if (
        client?.getLastServerInfoMessage()?.features?.coordinatorBootstrapPreclaimRecovery !== true
      )
        return null;
      return {
        listCoordinatorBootstrapRequests: () => client.listPreclaimRecoveryRequests(),
        ...(client.getLastServerInfoMessage()?.features?.coordinatorBootstrapPreclaimObservation ===
        true
          ? {
              verifyRetainedOutcome: (input: {
                id: string;
                revision: string;
                planSha256: string;
                generation: string;
              }) => client.reconcilePreclaimRecovery(input),
            }
          : {}),
        decideCoordinatorBootstrap: (input, password) =>
          client.decidePreclaimRecovery(input, password),
      };
    });
    recoveryModels.set(key, model);
  }
  return model;
}
type ClaimedRecoveryPanelModel = BootstrapPanelModel<BootstrapClaimedRecoveryRequestView>;
const claimedRecoveryModels = new Map<string, ClaimedRecoveryPanelModel>();
export function getClaimedRecoveryPanel(): ClaimedRecoveryPanelModel | null {
  const installation = readExecutionInstallation();
  const host = installation?.environments.find((environment) => environment.kind === "host");
  if (!installation || !host) return null;
  const key = `${installation.installationId}:${host.serverId}`;
  let model = claimedRecoveryModels.get(key);
  if (!model) {
    const provisioned =
      isWeb && window.location.origin === installation.origin
        ? new ClaimedRepairClient(installation.installationId, {
            fetch: (url, init) => fetch(url, init),
            now: Date.now,
          })
        : null;
    model = new BootstrapPanelModel<BootstrapClaimedRecoveryRequestView>(() => {
      const client = getHostRuntimeStore().getClient(host.serverId);
      if (
        client?.getLastServerInfoMessage()?.features?.coordinatorBootstrapClaimedRecovery !== true
      )
        return provisioned;
      return {
        listCoordinatorBootstrapRequests: () => client.listClaimedRecoveryRequests(),
        ...(client.getLastServerInfoMessage()?.features?.coordinatorBootstrapClaimedObservation ===
        true
          ? {
              verifyRetainedOutcome: (input: {
                id: string;
                revision: string;
                planSha256: string;
                generation: string;
              }) => client.reconcileClaimedRecovery(input),
            }
          : {}),
        decideCoordinatorBootstrap: (input, password) =>
          client.decideClaimedRecovery(input, password),
      };
    });
    claimedRecoveryModels.set(key, model);
  }
  return model;
}
export function getBootstrapPanel(): BootstrapPanelModel | null {
  const installation = readExecutionInstallation();
  const host = installation?.environments.find((environment) => environment.kind === "host");
  if (!installation || !host) return null;
  const key = `${installation.installationId}:${host.serverId}`;
  let model = models.get(key);
  if (!model) {
    model = new BootstrapPanelModel(
      () => {
        const client = getHostRuntimeStore().getClient(host.serverId);
        return client?.getLastServerInfoMessage()?.features?.coordinatorBootstrapReview === true
          ? client
          : null;
      },
      () => {
        const client = getHostRuntimeStore().getClient(host.serverId);
        return (
          client?.getLastServerInfoMessage()?.features?.coordinatorBootstrapUnavailableReason ??
          null
        );
      },
    );
    models.set(key, model);
  }
  return model;
}

function useBootstrapRequests(model: BootstrapPanelModel) {
  const state = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  const current = currentBootstrapRequests(state.requests).filter(bootstrapNeedsAttention);
  const currentIds = new Set(current.map((request) => request.id));
  const history = state.requests.filter((request) => !currentIds.has(request.id));
  return { state, current, history };
}

/** Coordinator updates that still need a decision or are running. */
export function BootstrapReview({ model }: { model: BootstrapPanelModel }) {
  const refresh = useCallback(() => {
    void model.refresh();
  }, [model]);
  const { state, current } = useBootstrapRequests(model);
  if (!state.available || (!current.length && !state.error)) return null;
  return (
    <View testID="coordinator-bootstrap-review" style={settingsStyles.rowBorder}>
      {state.error ? (
        <View>
          <Text accessibilityRole="alert" style={styles.error}>
            {state.error}
          </Text>
          <Button variant="ghost" onPress={refresh}>
            Refresh status
          </Button>
        </View>
      ) : null}
      {current.map((request) => (
        <BootstrapRequestCard key={request.id} request={request} model={model} />
      ))}
    </View>
  );
}

/** Finished and canceled coordinator updates, for the Installation history. */
export function BootstrapHistory({ model }: { model: BootstrapPanelModel }) {
  const { state, history } = useBootstrapRequests(model);
  if (!state.available || !history.length) return null;
  return (
    <HistoryGroup title="Coordinator updates" testID="coordinator-history-content">
      {history.map((request) => (
        <BootstrapRequestCard key={request.id} request={request} model={model} historical />
      ))}
    </HistoryGroup>
  );
}

export function HistoryGroup({
  title,
  testID,
  children,
}: {
  title: string;
  testID?: string;
  children: ReactNode;
}) {
  return (
    <View style={styles.historyGroup} testID={testID}>
      <Text style={settingsStyles.rowTitle} accessibilityRole="header">
        {title}
      </Text>
      {children}
    </View>
  );
}

const NO_SUBSCRIPTION = () => () => {};
const NO_STATE = () => null;

function useOptionalRequests<
  Request extends CoordinatorBootstrapRequest | BootstrapRecoveryRequest,
>(model: BootstrapPanelModel<Request> | null): Request[] {
  const state = useSyncExternalStore(
    model?.subscribe ?? NO_SUBSCRIPTION,
    model?.getState ?? NO_STATE,
    model?.getState ?? NO_STATE,
  );
  return state?.available ? state.requests : [];
}

/** How many finished coordinator updates and recoveries the history holds. */
export function useCoordinatorHistoryCount(): number {
  const bootstrap = useOptionalRequests(getBootstrapPanel());
  const preclaim = useOptionalRequests(getPreclaimRecoveryPanel());
  const claimed = useOptionalRequests(getClaimedRecoveryPanel());
  const currentIds = new Set(
    currentBootstrapRequests(bootstrap)
      .filter(bootstrapNeedsAttention)
      .map((request) => request.id),
  );
  const finishedRecoveries = [...preclaim, ...claimed].filter(
    (request) => !recoveryIsActive(request),
  );
  return (
    bootstrap.filter((request) => !currentIds.has(request.id)).length + finishedRecoveries.length
  );
}

function CoordinatorElapsed({ request }: { request: CoordinatorBootstrapRequest }) {
  const active = bootstrapNeedsAttention(request);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  if (!active) return null;
  const seconds = Math.max(
    0,
    Math.floor((now - Date.parse(request.decisionAt ?? request.createdAt)) / 1000),
  );
  const elapsed = `${Math.floor(seconds / 3600)}h ${Math.floor(seconds / 60) % 60}m ${seconds % 60}s`;
  let label = "Awaiting approval";
  if (request.execution) label = "Since approval";
  else if (request.automaticStatus)
    label = request.decisionAt ? "Since authorization" : "Request age";
  else if (request.status === "approved") label = "Awaiting dispatch";
  const dispatchAfter = request.automaticStatus?.dispatchAfter;
  const cancellationSeconds = dispatchAfter
    ? Math.max(0, Math.ceil((Date.parse(dispatchAfter) - now) / 1000))
    : null;
  return (
    <>
      <Text style={styles.text} testID="coordinator-elapsed">
        {label}: {elapsed}
      </Text>
      {request.automaticStatus?.state === "cancellation-window" && cancellationSeconds !== null ? (
        <Text style={styles.text} testID="coordinator-cancellation-window">
          Minimum wait before dispatch: {cancellationSeconds}s
        </Text>
      ) : null}
    </>
  );
}

function FactoryAdoptionConfiguration({ plan }: { plan: CoordinatorBootstrapRequest["plan"] }) {
  const configuration = plan.factoryRuntimeAdoptionConfiguration;
  if (configuration === undefined) return null;
  return (
    <Text selectable style={styles.text}>
      {configuration === null
        ? "Disable new Factory startup adoption requests. Existing recovery requirements remain."
        : `Configure Factory startup adoption plan ${configuration.sha256}. Adopting startup still requires a separate approval.`}
    </Text>
  );
}

function CompatibleRecoveryConfiguration({ plan }: { plan: CoordinatorBootstrapRequest["plan"] }) {
  const recovery = plan.compatibleRecovery;
  if (!recovery) return null;
  return (
    <View>
      <Text style={styles.text}>
        Recovery uses the separately approved executable below with the previous configuration. It
        may resume the exact previous process to let busy work settle, but maintenance then remains
        unresolved. A new approved update is required to restore restart-safe operation. If that
        previous process exits, it may not restart. Other unverified recovery also remains
        unresolved.
      </Text>
      <Text selectable style={styles.text}>
        Recovery source: {recovery.sourceCommit}
      </Text>
      <Text selectable style={styles.text}>
        Recovery artifact SHA-256: {recovery.artifactSha256}
      </Text>
      <Text selectable style={styles.text}>
        Recovery launcher: {recovery.launcher.path}
      </Text>
      <Text selectable style={styles.text}>
        Recovery configuration: {recovery.configuration.path}
      </Text>
      <Text selectable style={styles.text}>
        Recovery configuration SHA-256: {recovery.configuration.sha256}
      </Text>
    </View>
  );
}

function MonitorConfiguration({ plan }: { plan: CoordinatorBootstrapRequest["plan"] }) {
  const config = plan.previewMonitorConfiguration;
  if (config === undefined) return null;
  return (
    <Text style={styles.text}>
      {config === null
        ? "Disable new preview monitor requests. Existing receipts remain in history."
        : "Enable Dev preview monitor maintenance with compatible selected and recovery coordinators. Each replacement still requires its own approval."}
    </Text>
  );
}

function ClaudeRefreshConfiguration({ plan }: { plan: CoordinatorBootstrapRequest["plan"] }) {
  const config = plan.claudeHostRefreshConfiguration;
  if (config === undefined) return null;
  return (
    <Text style={styles.text}>
      {config === null
        ? "Turn off Host-owned refresh for full sign-in Claude accounts. Dev loses those accounts when their current access expires, within about 8 hours, and new full sign-in accounts can no longer be added. Host use and setup-token accounts are unaffected."
        : "Turn on Host-owned refresh for full sign-in Claude accounts. The Host keeps each account signed in and sends Dev short-lived access, so long Dev turns survive token expiry. Adding a full sign-in account becomes available once every environment supports it."}
    </Text>
  );
}

function SourceUpdateToolingConfiguration({ plan }: { plan: CoordinatorBootstrapRequest["plan"] }) {
  if (plan.sourceUpdateTooling !== true) return null;
  return (
    <Text selectable style={styles.text}>
      Select Host source update tooling from {plan.candidate.directory}/scripts. Binding setup
      remains separate.
    </Text>
  );
}

function BootRecoveryConfiguration({ plan }: { plan: CoordinatorBootstrapRequest["plan"] }) {
  if (!plan.bootRecovery) return null;
  return (
    <Text selectable style={styles.text}>
      Install independent recovery for this update. It starts after this Host account logs in,
      including after a reboot, and can perform only the recovery approved in this request. It
      cannot recover before login or retry the update.
    </Text>
  );
}

function RetainedBootRecovery({ plan }: { plan: CoordinatorBootstrapRequest["plan"] }) {
  const recovery = plan.bootRecovery;
  if (!recovery) return null;
  return (
    <Text selectable style={styles.text}>
      The original approval includes startup recovery after Host login. This recovery review does
      not authorize another original update launch.
      {"\n"}Retained recovery service: {recovery.service}
      {"\n"}Retained launcher: {recovery.installedLauncher}
      {"\n"}Launcher SHA-256: {recovery.launcher.sha256}
      {"\n"}Setup SHA-256: {recovery.setup.sha256}
    </Text>
  );
}

function bootstrapCardStyle(historical?: boolean) {
  return historical ? styles.historyItem : styles.card;
}

function CoordinatorStatus({
  request,
  checking,
}: {
  request: CoordinatorBootstrapRequest;
  checking: boolean;
}) {
  const automaticDetail = bootstrapAutomaticDetail(request);
  const failed =
    request.execution?.stage === "recovery_required" ||
    (request.automaticStatus !== undefined && bootstrapRequiresOwnerAction(request));
  return (
    <>
      <View style={styles.row}>
        <Text style={settingsStyles.rowTitle}>Installation coordinator</Text>
        <StatusBadge
          label={checking ? "Checking decision" : bootstrapStatus(request)}
          variant={failed ? "error" : "muted"}
        />
      </View>
      <CoordinatorElapsed request={request} />
      {automaticDetail ? (
        <Text accessibilityLiveRegion="polite" style={styles.text}>
          {automaticDetail}
        </Text>
      ) : null}
    </>
  );
}

function BootstrapRequestCard({
  request,
  model,
  historical,
}: {
  request: CoordinatorBootstrapRequest;
  model: BootstrapPanelModel;
  historical?: boolean;
}) {
  const state = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  const [details, setDetails] = useState(false);
  const toggle = useCallback(() => setDetails((value) => !value), []);
  const password = useCallback((value: string) => model.setPassword(value), [model]);
  const approve = useCallback(() => {
    void model.decide(request, "approve");
  }, [model, request]);
  const cancel = useCallback(() => {
    void model.decide(request, "cancel");
  }, [model, request]);
  const reason = bootstrapDecisionDisabledReason(request, state);
  const deciding = !request.execution && request.status !== "canceled";
  const checking = state.busy && deciding;
  const approvalDescription = request.automaticStatus
    ? "This request follows the authorization shown above."
    : "Review the exact source before approving.";
  return (
    <View style={bootstrapCardStyle(historical)} testID={`coordinator-bootstrap-${request.id}`}>
      <CoordinatorStatus request={request} checking={checking} />
      <Text style={styles.text}>
        Update the installation coordinator. Installation controls will briefly reconnect; Host and
        Dev tasks keep running.{" "}
        {request.plan.hostRequestsAfter
          ? "This also enables automatic approval for trusted Host requests."
          : approvalDescription}
      </Text>
      {checking ? (
        <Text accessibilityLiveRegion="polite" style={styles.text}>
          Host is processing your decision. Approval verifies the prepared release files and can
          take several minutes. Do not submit it again. Host and Dev tasks keep running.
        </Text>
      ) : null}
      <Button variant="ghost" onPress={toggle} accessibilityState={details ? expanded : collapsed}>
        {details ? "Hide details" : "Details"}
      </Button>
      {details ? (
        <SettingsExpansion>
          <Text selectable style={styles.text}>
            {request.reason}
          </Text>
          {request.plan.automaticRecovery === "restore-previous" ? (
            <Text style={styles.text}>
              If the updater stalls for three minutes or replacement fails, the system stops only
              that updater and restores the verified previous coordinator. Host and Dev tasks keep
              running; the failed update is not retried.
            </Text>
          ) : null}
          <CompatibleRecoveryConfiguration plan={request.plan} />
          <SourceUpdateToolingConfiguration plan={request.plan} />
          <BootRecoveryConfiguration plan={request.plan} />
          {request.plan.nativeHelperConfiguration !== undefined ? (
            <Text style={styles.text}>
              {request.plan.nativeHelperConfiguration === null
                ? "Disable new native helper requests. Existing receipts remain in history."
                : "Enable native helper maintenance for Host requests. Each helper installation still requires its own approval."}
            </Text>
          ) : null}
          <MonitorConfiguration plan={request.plan} />
          <ClaudeRefreshConfiguration plan={request.plan} />
          <FactoryAdoptionConfiguration plan={request.plan} />
          <Text selectable style={styles.text}>
            Source: {request.plan.candidate.sourceCommit}
          </Text>
          <Text selectable style={styles.text}>
            Artifact SHA-256: {request.plan.candidate.artifactSha256}
          </Text>
          <Text selectable style={styles.text}>
            Plan SHA-256: {request.planSha256}
          </Text>
          <Text selectable style={styles.text}>
            Request: {request.id}
          </Text>
          <Text selectable style={styles.text}>
            Revision: {request.revision}
          </Text>
        </SettingsExpansion>
      ) : null}
      {deciding ? (
        <>
          <EditingTextInput
            key={state.passwordEpoch}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            initialValue=""
            onChangeText={password}
            accessibilityLabel="Coordinator maintenance owner password"
            placeholder="Owner password"
            style={styles.input}
          />
          <View style={styles.actions}>
            {request.status === "pending" ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <View
                    accessible={reason !== null}
                    focusable={reason !== null}
                    accessibilityLabel={reason ?? undefined}
                  >
                    <Button
                      variant="outline"
                      disabled={reason !== null}
                      onPress={approve}
                      testID="bootstrap-approve"
                    >
                      Approve coordinator update
                    </Button>
                  </View>
                </TooltipTrigger>
                <TooltipContent>
                  <Text style={styles.text}>
                    {reason ?? "Approve only this source, artifact and request revision."}
                  </Text>
                </TooltipContent>
              </Tooltip>
            ) : null}
            <Tooltip>
              <TooltipTrigger asChild>
                <View
                  accessible={reason !== null}
                  focusable={reason !== null}
                  accessibilityLabel={reason ?? undefined}
                >
                  <Button
                    variant="ghost"
                    disabled={reason !== null}
                    onPress={cancel}
                    testID="bootstrap-cancel"
                  >
                    Cancel
                  </Button>
                </View>
              </TooltipTrigger>
              <TooltipContent>
                <Text style={styles.text}>
                  {reason ?? "Cancel before the handoff is dispatched."}
                </Text>
              </TooltipContent>
            </Tooltip>
          </View>
        </>
      ) : null}
    </View>
  );
}

export function BootstrapBanner({ model }: { model: BootstrapPanelModel }) {
  const state = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  const router = useRouter();
  const request = currentBootstrapRequests(state.requests).find(bootstrapNeedsAttention);
  const requestId = request?.id;
  const open = useCallback(
    () =>
      router.push({
        pathname: "/settings/[section]",
        params: { section: "general", installation: "1", bootstrap: requestId },
      }),
    [router, requestId],
  );
  if (!request) return null;
  return (
    <View testID="coordinator-bootstrap-banner">
      <MaintenanceNotice
        needsAction={bootstrapRequiresOwnerAction(request) || !!state.error}
        revision={`${request.id}:${request.revision}:${request.status}:${request.execution?.stage ?? ""}:${request.automaticStatus?.state ?? ""}`}
        title="Coordinator update"
        description={
          state.error ??
          (state.busy
            ? "Host is processing your decision and checking the prepared update. This can take several minutes; do not submit it again."
            : bootstrapStatus(request))
        }
        reviewLabel="Review update"
        onReview={open}
      />
    </View>
  );
}

/**
 * A recovery is active until its executor cleanup is verified or it stopped
 * before effects; finished recoveries belong in history, not in the review.
 */
function recoveryIsActive(request: BootstrapRecoveryRequest): boolean {
  return preclaimRecoveryNeedsAttention(request);
}

export function PreclaimRecoveryReview({ model }: { model: RecoveryPanelModel }) {
  return <RecoveryReview model={model} kind="preclaim" />;
}
export function ClaimedRecoveryReview({ model }: { model: ClaimedRecoveryPanelModel }) {
  return <RecoveryReview model={model} kind="claimed" />;
}
function RecoveryReview<Request extends BootstrapRecoveryRequest>({
  model,
  kind,
}: {
  model: BootstrapPanelModel<Request>;
  kind: "preclaim" | "claimed";
}) {
  const state = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  const refresh = useCallback(() => {
    void model.refresh();
  }, [model]);
  const active = state.requests.filter(recoveryIsActive);
  if (!state.available || (!active.length && !state.error)) return null;
  return (
    <View testID={kind === "claimed" ? "claimed-recovery-review" : "bootstrap-recovery-review"}>
      {state.error ? (
        <View>
          <Text accessibilityRole="alert" style={styles.error}>
            {state.error}
          </Text>
          {/* Status refreshes on its own every few seconds; this retries after an error. */}
          <Button variant="ghost" onPress={refresh}>
            Refresh recovery status
          </Button>
        </View>
      ) : null}
      {active.map((request) => (
        <PreclaimRecoveryCard key={request.id} request={request} model={model} />
      ))}
    </View>
  );
}

/** Finished coordinator recoveries from both recovery queues, newest first. */
export function CoordinatorRecoveryHistory() {
  const preclaimModel = getPreclaimRecoveryPanel();
  const claimedModel = getClaimedRecoveryPanel();
  const preclaim = useOptionalRequests(preclaimModel);
  const claimed = useOptionalRequests(claimedModel);
  const finished = [
    ...claimed
      .filter((request) => !recoveryIsActive(request))
      .map((request) => ({
        request,
        model: claimedModel as BootstrapPanelModel<BootstrapRecoveryRequest>,
      })),
    ...preclaim
      .filter((request) => !recoveryIsActive(request))
      .map((request) => ({
        request,
        model: preclaimModel as BootstrapPanelModel<BootstrapRecoveryRequest>,
      })),
  ].sort((a, b) => recoveryTime(b.request).localeCompare(recoveryTime(a.request)));
  if (!finished.length) return null;
  return (
    <HistoryGroup title="Coordinator recoveries" testID="coordinator-recovery-history">
      {finished.map(({ request, model }) => (
        <PreclaimRecoveryCard key={request.id} request={request} model={model} historical />
      ))}
    </HistoryGroup>
  );
}

function recoveryTime(request: BootstrapRecoveryRequest): string {
  return request.execution?.updatedAt ?? request.decisionAt ?? "";
}

function PreclaimRecoveryCard<Request extends BootstrapRecoveryRequest>({
  request,
  model,
  historical,
}: {
  request: Request;
  model: BootstrapPanelModel<Request>;
  /** A finished recovery: one line with its outcome; the full plan stays behind Details. */
  historical?: boolean;
}) {
  const state = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  const [details, setDetails] = useState(false);
  const password = useCallback((value: string) => model.setPassword(value), [model]);
  const approve = useCallback(() => {
    void model.decide(request, "approve");
  }, [model, request]);
  const cancel = useCallback(() => {
    void model.decide(request, "cancel");
  }, [model, request]);
  const toggle = useCallback(() => setDetails((value) => !value), []);
  const reason = bootstrapDecisionDisabledReason(request, state);
  const deciding = !request.execution && request.status !== "canceled";
  const { plan } = request;
  const reconcile = useCallback(() => {
    void model.reconcile(request);
  }, [model, request]);
  return (
    <View
      style={historical ? styles.historyItem : [styles.card, settingsStyles.rowBorder]}
      testID={`bootstrap-recovery-${request.id}`}
    >
      <View style={styles.row}>
        <Text style={settingsStyles.rowTitle}>
          {plan.operation === "bootstrap-claimed-recovery"
            ? "Recover stalled coordinator executor"
            : "Recover coordinator preparation"}
        </Text>
        <StatusBadge
          label={preclaimRecoveryStatus(request)}
          variant={request.execution?.stage === "recovery_required" ? "error" : "muted"}
        />
      </View>
      {historical ? (
        <Text style={styles.text}>{formatRecoveryTime(request)}</Text>
      ) : (
        <RecoveryPlanText request={request} />
      )}
      {model.canReconcile() &&
      request.execution &&
      !["succeeded", "aborted_before_effects"].includes(request.execution.stage) ? (
        <Button
          variant="outline"
          onPress={reconcile}
          disabled={state.busy}
          testID="bootstrap-recovery-observe"
        >
          Verify outcome without repeating effects
        </Button>
      ) : null}
      <Button variant="ghost" onPress={toggle} accessibilityState={details ? expanded : collapsed}>
        Exact recovery details
      </Button>
      {details ? (
        <SettingsExpansion>
          {historical ? <RecoveryPlanText request={request} /> : null}
          <Text selectable style={styles.text}>
            Request: {request.id}
            {"\n"}Revision: {request.revision}
            {"\n"}Plan SHA-256: {request.planSha256}
          </Text>
          <Text selectable style={styles.text}>
            Original revision: {plan.original.revision}
            {"\n"}Original plan SHA-256: {plan.original.planSha256}
            {"\n"}Original approval: {plan.original.decisionAt}
          </Text>
          <RetainedBootRecovery plan={plan.original.plan} />
          <Text selectable style={styles.text}>
            Executor birth: {plan.executor.identity.startIdentity}
            {"\n"}Boot: {plan.executor.identity.bootId}
            {"\n"}Arguments SHA-256: {plan.executor.identity.argumentsSha256}
          </Text>
          <Text selectable style={styles.text}>
            Executor source: {plan.runner.sourceCommit}
            {"\n"}Artifact SHA-256: {plan.runner.artifactSha256}
          </Text>
          <Text selectable style={styles.text}>
            Preserved launcher: {plan.selectedLauncher.path}
            {"\n"}SHA-256: {plan.selectedLauncher.sha256}
          </Text>
          <Text selectable style={styles.text}>
            Preserved configuration: {plan.selectedConfiguration.path}
            {"\n"}SHA-256: {plan.selectedConfiguration.sha256}
          </Text>
        </SettingsExpansion>
      ) : null}
      {deciding ? (
        <>
          {state.busy ? (
            <Text accessibilityLiveRegion="polite" style={styles.text}>
              Checking the exact recovery decision. Status continues to refresh; do not submit
              approval again.
            </Text>
          ) : null}
          <EditingTextInput
            key={state.passwordEpoch}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            initialValue=""
            onChangeText={password}
            accessibilityLabel="Recovery owner password"
            placeholder="Owner password"
            style={styles.input}
          />
          {reason ? <Text style={styles.text}>{reason}</Text> : null}
          <View style={styles.actions}>
            {request.status === "pending" ? (
              <Button
                variant="outline"
                disabled={reason !== null}
                onPress={approve}
                testID="bootstrap-recovery-approve"
              >
                Approve this recovery
              </Button>
            ) : null}
            <Button
              variant="ghost"
              disabled={reason !== null}
              onPress={cancel}
              testID="bootstrap-recovery-cancel"
            >
              Cancel recovery
            </Button>
          </View>
        </>
      ) : null}
    </View>
  );
}

function RecoveryPlanText({ request }: { request: BootstrapRecoveryRequest }) {
  const { plan } = request;
  const dispatch = preclaimDispatchDescription(request);
  return (
    <>
      <Text style={styles.text}>{request.reason}</Text>
      {dispatch ? (
        <Text selectable accessibilityLiveRegion="polite" style={styles.text}>
          {dispatch}
        </Text>
      ) : null}
      <Text selectable style={styles.text}>
        {recoveryTargetDescription(request)}
      </Text>
      <Text style={styles.text}>
        {plan.signalPolicy.escalation === "SIGKILL"
          ? `Send SIGTERM, then permit SIGKILL after ${plan.signalPolicy.graceSeconds} seconds if the same verified executor remains. This approval includes that escalation.`
          : `Send SIGTERM and wait ${plan.signalPolicy.graceSeconds} seconds. Force termination is not authorized.`}
      </Text>
      <Text style={styles.text}>
        A started process does not prove recovery. Wait for the verified receipt before preparing
        another operation.
      </Text>
    </>
  );
}

function formatRecoveryTime(request: BootstrapRecoveryRequest): string {
  const time = recoveryTime(request);
  return time ? new Date(time).toLocaleString() : "";
}

export function PreclaimRecoveryBanner({ model }: { model: RecoveryPanelModel }) {
  const state = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  const router = useRouter();
  const request = state.requests.find(preclaimRecoveryNeedsAttention);
  const requestId = request?.id;
  const open = useCallback(
    () =>
      router.push({
        pathname: "/settings/[section]",
        params: { section: "general", installation: "1", bootstrapRecovery: requestId },
      }),
    [router, requestId],
  );
  if (!request) return null;
  return (
    <View testID="bootstrap-recovery-banner">
      <MaintenanceNotice
        sidebarOnly
        needsAction={request.status !== "approved" || !!state.error}
        revision={`${request.id}:${request.revision}`}
        title={`Coordinator recovery: ${preclaimRecoveryStatus(request)}`}
        description={
          state.error ??
          "Review the exact executor and cancellation. Existing coordinator selection is preserved."
        }
        reviewLabel="Review recovery"
        onReview={open}
      />
    </View>
  );
}

export function ClaimedRecoveryBanner({ model }: { model: ClaimedRecoveryPanelModel }) {
  const state = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  const router = useRouter();
  const request = state.requests.find(preclaimRecoveryNeedsAttention);
  const requestId = request?.id;
  const open = useCallback(
    () =>
      router.push({
        pathname: "/settings/[section]",
        params: { section: "general", installation: "1", claimedRecovery: requestId },
      }),
    [router, requestId],
  );
  if (!request) return null;
  return (
    <View testID="claimed-recovery-banner">
      <MaintenanceNotice
        sidebarOnly
        needsAction={request.status !== "approved" || !!state.error}
        revision={`${request.id}:${request.revision}`}
        title={`Coordinator recovery: ${preclaimRecoveryStatus(request)}`}
        description={
          state.error ??
          "Review the stalled executor recovery. Original approval history and coordinator selection are preserved."
        }
        reviewLabel="Review recovery"
        onReview={open}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  card: { padding: theme.spacing[4], gap: theme.spacing[3] },
  historyItem: { gap: theme.spacing[3] },
  historyGroup: { gap: theme.spacing[3] },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[2] },
  text: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  error: {
    color: theme.colors.destructive,
    padding: theme.spacing[4],
    fontSize: theme.fontSize.sm,
  },
  input: {
    color: theme.colors.foreground,
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.md,
    padding: theme.spacing[3],
    fontSize: theme.fontSize.base,
  },
}));
