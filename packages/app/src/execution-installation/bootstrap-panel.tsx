import { useCallback, useState, useSyncExternalStore } from "react";
import { Text, View } from "react-native";
import { useRouter } from "expo-router";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { EditingTextInput } from "@/components/ui/text-input";
import { StatusBadge } from "@/components/ui/status-badge";
import { SidebarCallout } from "@/components/sidebar-callout";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { settingsStyles } from "@/styles/settings";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { readExecutionInstallation } from "./policy";
import {
  BootstrapPanelModel,
  bootstrapDecisionDisabledReason,
  bootstrapNeedsAttention,
  bootstrapStatus,
  currentBootstrapRequests,
} from "./bootstrap-model";
import type { CoordinatorBootstrapRequest } from "@getpaseo/protocol/coordinator-bootstrap";

const expanded = { expanded: true };
const collapsed = { expanded: false };
const models = new Map<string, BootstrapPanelModel>();
export function getBootstrapPanel(): BootstrapPanelModel | null {
  const installation = readExecutionInstallation();
  const host = installation?.environments.find((environment) => environment.kind === "host");
  if (!installation || !host) return null;
  const key = `${installation.installationId}:${host.serverId}`;
  let model = models.get(key);
  if (!model) {
    model = new BootstrapPanelModel(() => {
      const client = getHostRuntimeStore().getClient(host.serverId);
      return client?.getLastServerInfoMessage()?.features?.coordinatorBootstrapReview === true
        ? client
        : null;
    });
    models.set(key, model);
  }
  return model;
}

export function BootstrapReview({ model }: { model: BootstrapPanelModel }) {
  const refresh = useCallback(() => {
    void model.refresh();
  }, [model]);
  const state = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  if (!state.available) return null;
  return (
    <View testID="coordinator-bootstrap-review">
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
      {currentBootstrapRequests(state.requests).map((request) => (
        <BootstrapRequestCard key={request.id} request={request} model={model} />
      ))}
    </View>
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

function BootstrapRequestCard({
  request,
  model,
}: {
  request: CoordinatorBootstrapRequest;
  model: BootstrapPanelModel;
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
  return (
    <View
      style={[styles.card, settingsStyles.rowBorder]}
      testID={`coordinator-bootstrap-${request.id}`}
    >
      <View style={styles.row}>
        <Text style={settingsStyles.rowTitle}>Installation coordinator</Text>
        <StatusBadge
          label={checking ? "Checking decision" : bootstrapStatus(request)}
          variant={request.execution?.stage === "recovery_required" ? "error" : "muted"}
        />
      </View>
      <Text style={styles.text}>
        Update the installation coordinator. Installation controls will briefly reconnect; Host and
        Dev tasks keep running.{" "}
        {request.plan.hostRequestsAfter
          ? "This also enables automatic approval for trusted Host requests."
          : "Review the exact source before approving."}
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
        <View style={styles.details}>
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
          {request.plan.nativeHelperConfiguration !== undefined ? (
            <Text style={styles.text}>
              {request.plan.nativeHelperConfiguration === null
                ? "Disable new native helper requests. Existing receipts remain in history."
                : "Enable native helper maintenance for Host requests. Each helper installation still requires its own approval."}
            </Text>
          ) : null}
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
        </View>
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
      <SidebarCallout
        title={`Coordinator: ${state.busy ? "Checking decision" : bootstrapStatus(request)}`}
        description={
          state.error ??
          (state.busy
            ? "Host is processing your decision and checking the prepared update. This can take several minutes; do not submit it again."
            : "Coordinator maintenance. Host and Dev tasks keep running.")
        }
        actions={[{ label: "Review update", onPress: open }]}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  card: { padding: theme.spacing[4], gap: theme.spacing[3] },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[2] },
  details: { gap: theme.spacing[2] },
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
