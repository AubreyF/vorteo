import { useCallback, useMemo, useReducer, useRef, useState } from "react";
import { Text, type GestureResponderEvent } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useQueryClient } from "@tanstack/react-query";

import { useFetchQuery } from "@/data/query";
import type { ProviderResetView } from "@getpaseo/protocol/provider-reset";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { CompactAccountButton } from "./compact-account-button";
import { providerUsageQueryKey } from "./use-provider-usage";
import { currentResetPreparation, resetPresentation, selectableResetCredits } from "./reset-state";
import { providerResetQueryOptions } from "./reset-query";
import { initialResetFlow, resetFlowReducer } from "./reset-flow";
import { ResetDialogContent } from "./reset-dialog";
import { prepareResetForView, reconcileResetResult, resetResultNotice } from "./reset-result";

function useResetControl({
  serverId,
  providerId,
  name,
  preloaded = false,
}: {
  serverId: string | null;
  providerId: string;
  name: string;
  preloaded?: boolean;
}) {
  const hostId = serverId ?? "";
  const client = useHostRuntimeClient(hostId);
  const connected = useHostRuntimeIsConnected(hostId);

  const hostSupported = useSessionStore(
    (state) => state.sessions[hostId]?.serverInfo?.features?.providerResetManagement === true,
  );
  const selectionSupported = useSessionStore(
    (state) => state.sessions[hostId]?.serverInfo?.features?.providerResetCreditSelection === true,
  );
  const cache = useQueryClient();
  const supported = hostSupported;
  const clientGeneration = useSessionStore((state) => state.sessions[hostId]?.clientGeneration);
  const queryOptions = useMemo(
    () =>
      providerResetQueryOptions({
        serverId,
        providerId,
        clientGeneration,
        client,
        enabled: Boolean(client && connected && supported && !preloaded),
      }),
    [serverId, providerId, clientGeneration, client, connected, supported, preloaded],
  );
  const key = queryOptions.queryKey;
  const [open, setOpen] = useState(false);
  const [flow, dispatch] = useReducer(resetFlowReducer, initialResetFlow);
  const { busy } = flow;
  const busyRef = useRef(false);
  const query = useFetchQuery(queryOptions);
  const prepared = currentResetPreparation(flow.preparation, query.data);
  const view = prepared ?? query.data;
  const snapshot = view?.snapshot;
  const available = snapshot?.status === "available" ? snapshot : null;
  const credits = selectableResetCredits(query.data);
  const selection = flow.selection?.accountId === available?.accountId ? flow.selection : null;
  const selectedCreditId = selection?.creditId ?? credits[0]?.id;
  const selectedExists =
    selectedCreditId === undefined || credits.some((credit) => credit.id === selectedCreditId);
  // A changed account must never retain a confirmation for the previous identity.
  const displayedFlow = flow.preparation && !prepared ? initialResetFlow : flow;
  let title = `Reset credits: ${name}`;
  if (displayedFlow.stage === "review") title = busy ? "Applying reset…" : "Use this reset?";
  if (displayedFlow.stage === "result") title = "Reset result";
  const header = useMemo(() => ({ title }), [title]);
  const close = useCallback(() => {
    if (!busyRef.current) {
      setOpen(false);
      dispatch({ type: "clear" });
    }
  }, []);
  const refresh = useCallback(() => {
    if (busyRef.current) return;
    dispatch({ type: "clear" });
    void query.refetch();
  }, [query]);
  const back = useCallback(() => {
    if (!busyRef.current) dispatch({ type: "back" });
  }, []);
  const select = useCallback(
    (creditId: string) => {
      if (!busyRef.current && available)
        dispatch({ type: "select", accountId: available.accountId, creditId });
    },
    [available],
  );
  const act = useCallback(async () => {
    const viewed = query.data;
    if (busyRef.current || !client || !available || !connected || !viewed || !selectionSupported)
      return;
    if (!prepared && !selectedExists) return;
    busyRef.current = true;
    dispatch({ type: "start" });
    try {
      if (!prepared?.operation) {
        const result = await prepareResetForView(
          viewed,
          () => cache.getQueryData<ProviderResetView>(key),
          () => client.prepareProviderReset(providerId, available.accountId, selectedCreditId),
        );
        if (!result) {
          dispatch({
            type: "failure",
            uncertain: false,
            notice:
              "Account details changed during review. Refresh and review the current account before confirming.",
          });
          return;
        }
        dispatch({ type: "prepared", view: result });
        cache.setQueryData(key, result);
      } else {
        const result = await client.confirmProviderReset(
          providerId,
          available.accountId,
          prepared.operation.operationId,
        );
        dispatch({ type: "result", result, notice: resetResultNotice(result) });
        if (result.view && cache.getQueryData(key) === viewed) cache.setQueryData(key, result.view);
        const notice = await reconcileResetResult(result, [
          () =>
            cache.invalidateQueries(
              { queryKey: ["providerReset", serverId] },
              { throwOnError: true },
            ),
          () =>
            cache.invalidateQueries(
              { queryKey: providerUsageQueryKey(serverId) },
              { throwOnError: true },
            ),
        ]);
        dispatch({ type: "result", result, notice });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "The request failed.";
      const uncertain = Boolean(prepared?.operation);
      const recovery = uncertain
        ? " Retry this same reset to verify its result, or go back to review account details."
        : " Refresh account details and review again.";
      dispatch({ type: "failure", notice: message + recovery, uncertain });
    } finally {
      busyRef.current = false;
      dispatch({ type: "settled" });
    }
  }, [
    available,
    cache,
    client,
    connected,
    key,
    prepared,
    providerId,
    serverId,
    query.data,
    selectionSupported,
    selectedCreditId,
    selectedExists,
  ]);
  const press = useCallback(() => {
    void act();
  }, [act]);
  const show = useCallback((event: GestureResponderEvent) => {
    event.stopPropagation();
    setOpen(true);
  }, []);
  return {
    query,
    view,
    available,
    header,
    close,
    refresh,
    press,
    show,
    supported,
    open,
    connected,
    busy,
    prepared,
    flow: displayedFlow,
    selectedCreditId,
    selectedExists,
    selectionSupported,
    back,
    select,
  };
}

export function ProviderResetControl(props: {
  critical?: boolean;
  compact?: boolean;
  preloaded?: boolean;
  serverId: string | null;
  providerId: string;
  name: string;
}) {
  const {
    query,
    view,
    header,
    close,
    refresh,
    press,
    show,
    supported,
    open,
    connected,
    prepared,
    flow,
    selectedCreditId,
    selectedExists,
    selectionSupported,
    back,
    select,
  } = useResetControl(props);
  const { name, providerId } = props;
  const criticalTextStyle = useMemo(
    () => (props.critical ? styles.critical : undefined),
    [props.critical],
  );
  const { visible, showBadge, badge, enabled } = resetPresentation({
    supported,
    connected,
    open,
    current: query.data,
    displayed: view,
    readFailed: query.isError,
    positiveOnly: props.compact,
  });
  if (!visible) return null;
  const BadgeButton = props.compact ? CompactAccountButton : Button;
  return (
    <>
      {showBadge ? (
        <BadgeButton
          dense={props.compact}
          variant="ghost"
          size="sm"
          onPress={show}
          accessibilityLabel={`${name}: ${badge}`}
          textStyle={[styles.text, props.compact && styles.compactText, criticalTextStyle]}
          testID={`provider-reset-${providerId}`}
        >
          <Text numberOfLines={1} style={criticalTextStyle}>
            {badge}
          </Text>
        </BadgeButton>
      ) : null}
      {open ? (
        <AdaptiveModalSheet
          visible
          header={header}
          onClose={close}
          desktopMaxWidth={560}
          testID="provider-reset-dialog"
        >
          <ResetDialogContent
            name={name}
            view={view}
            flow={flow}
            selectedCreditId={selectedCreditId}
            selectionSupported={selectionSupported}
            enabled={enabled && selectionSupported && (Boolean(prepared) || selectedExists)}
            connected={connected}
            readFailed={query.isError}
            onSelect={select}
            onBack={back}
            onClose={close}
            onRefresh={refresh}
            onAct={press}
          />
        </AdaptiveModalSheet>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  compactText: { fontSize: theme.fontSize.sm - 2, lineHeight: 16 },
  critical: { color: theme.colors.destructive },
  text: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.base },
}));
