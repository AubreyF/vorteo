import { ActionFooter } from "@/components/ui/action-footer";
import React, { useCallback, useMemo } from "react";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { ProviderResetView } from "@getpaseo/protocol/provider-reset";
import { Check } from "lucide-react-native";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import { resetCountLabel, selectableResetCredits } from "./reset-state";
import type { ResetFlow } from "./reset-flow";

const CreditCheck = withUnistyles(Check, (theme) => ({
  color: theme.colors.accent,
  size: theme.iconSize.sm,
}));
const creditCheck = <CreditCheck />;

type Credit = NonNullable<
  Extract<ProviderResetView["snapshot"], { status: "available" }>["credits"]
>[number];

function CreditSummary({ credit }: { credit: Credit }) {
  return (
    <>
      <Text style={styles.primary}>{credit.title ?? "Reset credit"}</Text>
      <Text style={styles.text}>
        {credit.expiresAt === null
          ? "Expiry not reported"
          : `Expires ${new Date(credit.expiresAt * 1000).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })}`}
      </Text>
      <Text style={styles.metadata}>
        Granted {new Date(credit.grantedAt * 1000).toLocaleDateString()}
      </Text>
    </>
  );
}

interface ResetDialogProps {
  name: string;
  view: ProviderResetView | undefined;
  flow: ResetFlow;
  selectedCreditId: string | undefined;
  selectionSupported: boolean;
  enabled: boolean;
  connected: boolean;
  readFailed: boolean;
  onSelect(creditId: string): void;
  onBack(): void;
  onClose(): void;
  onRefresh(): void;
  onAct(): void;
}

function CreditOption({
  credit,
  selected,
  busy,
  onSelect,
}: {
  credit: Credit;
  selected: boolean;
  busy: boolean;
  onSelect(id: string): void;
}) {
  const select = useCallback(() => onSelect(credit.id), [onSelect, credit.id]);
  const accessibilityState = useMemo(() => ({ selected }), [selected]);
  return (
    <View style={[styles.credit, selected && styles.selectedCredit]}>
      <CreditSummary credit={credit} />
      <Button
        variant="ghost"
        onPress={select}
        disabled={busy}
        accessibilityLabel={`Select reset granted ${new Date(credit.grantedAt * 1000).toLocaleDateString()}`}
        accessibilityState={accessibilityState}
        aria-selected={selected}
        style={styles.touchTarget}
        testID={`provider-reset-select-${credit.id}`}
      >
        {selected ? "Selected" : "Select"}
      </Button>
    </View>
  );
}

function ResetReview({ flow }: Pick<ResetDialogProps, "flow">) {
  const credit = flow.preparation?.operation?.credit;
  return (
    <>
      <View style={styles.selectedCredit} testID="provider-reset-selected-credit">
        {credit ? (
          <>
            <StatusBadge
              label={flow.uncertain ? "Previously submitted" : "Will be used"}
              leading={flow.uncertain ? undefined : creditCheck}
            />
            <CreditSummary credit={credit} />
          </>
        ) : (
          <>
            <Text style={styles.primary}>Provider chooses the credit</Text>
            <Text style={styles.text}>
              This operation does not identify a specific reset credit.
            </Text>
          </>
        )}
      </View>
      <Text style={styles.text}>Uses 1 reset credit. Tasks stay paused until you resume them.</Text>
      {flow.uncertain ? (
        <Text style={styles.text}>
          The previous result is unverified. Retrying uses the same operation and cannot spend a
          second credit.
        </Text>
      ) : null}
    </>
  );
}

function ResetBrowse(props: ResetDialogProps) {
  const { view, flow, selectedCreditId } = props;
  const available = view?.snapshot.status === "available" ? view.snapshot : null;
  const pending = view?.operation?.state === "pending";
  const credits = selectableResetCredits(view);
  return (
    <>
      <Text style={styles.primary}>
        {available
          ? `${resetCountLabel(available.availableCount)} available`
          : "Reset availability is unknown."}
      </Text>
      {!props.selectionSupported ? (
        <Text style={styles.text}>Update the host to review and select reset credits.</Text>
      ) : null}
      {pending ? (
        <Text style={styles.text}>
          An earlier reset is unresolved. Review it before starting another.
        </Text>
      ) : null}
      {!pending && props.selectionSupported
        ? credits.map((entry) => (
            <CreditOption
              key={entry.id}
              credit={entry}
              selected={entry.id === selectedCreditId}
              busy={flow.busy}
              onSelect={props.onSelect}
            />
          ))
        : null}
      {!pending && props.selectionSupported && credits.length === 0 && available?.availableCount ? (
        <Text style={styles.text}>
          Provider chooses the credit. Individual credit selection is unavailable.
        </Text>
      ) : null}
      {available?.credits && available.credits.length < available.availableCount ? (
        <Text style={styles.metadata}>
          The provider has not supplied details for every available credit.
        </Text>
      ) : null}
      {view && !view.canRedeem ? (
        <Text style={styles.text}>This provider has not verified reset redemption support.</Text>
      ) : null}
    </>
  );
}

function ResetActions(props: ResetDialogProps) {
  const { flow } = props;
  const reviewing = flow.stage === "review";
  const result = flow.stage === "result";
  const pending = props.view?.operation?.state === "pending";
  let action = "Review reset";
  if (pending) action = "Review pending reset";
  if (reviewing) action = flow.uncertain ? "Retry same reset" : "Use 1 reset credit";
  if (flow.busy) action = reviewing ? "Applying reset…" : "Preparing reset…";
  const canRepair = result && Boolean(flow.result?.refreshError);
  return (
    <ActionFooter style={styles.actions}>
      {reviewing ? (
        <Button
          variant="ghost"
          onPress={props.onBack}
          disabled={flow.busy}
          style={styles.touchTarget}
        >
          Back
        </Button>
      ) : (
        <Button
          variant="ghost"
          onPress={props.onClose}
          disabled={flow.busy}
          style={styles.touchTarget}
        >
          Close
        </Button>
      )}
      {flow.stage === "browse" ? (
        <Button
          variant="ghost"
          onPress={props.onRefresh}
          disabled={flow.busy || !props.connected}
          style={styles.touchTarget}
        >
          Refresh
        </Button>
      ) : null}
      {!result ? (
        <Button
          variant="default"
          onPress={props.onAct}
          disabled={flow.busy || !props.enabled}
          loading={flow.busy}
          style={styles.touchTarget}
          testID="provider-reset-action"
        >
          {action}
        </Button>
      ) : null}
      {canRepair ? (
        <Button
          variant="default"
          onPress={props.onAct}
          disabled={flow.busy || !props.connected}
          loading={flow.busy}
          style={styles.touchTarget}
        >
          Retry result recovery
        </Button>
      ) : null}
    </ActionFooter>
  );
}

export function ResetDialogContent(props: ResetDialogProps) {
  const { view, flow } = props;
  const available = view?.snapshot.status === "available" ? view.snapshot : null;
  return (
    <View style={styles.body} testID={`provider-reset-${flow.stage}`}>
      <View style={styles.identity}>
        <Text style={styles.primary}>{available?.accountLabel ?? "Account label unavailable"}</Text>
        <Text style={styles.text}>{props.name}</Text>
      </View>
      {flow.stage === "review" ? <ResetReview flow={flow} /> : null}
      {flow.stage === "browse" ? <ResetBrowse {...props} /> : null}
      {props.readFailed ? (
        <Text style={styles.text}>
          Could not refresh account details. Displayed data may be stale.
        </Text>
      ) : null}
      {flow.notice ? (
        <Text style={styles.primary} accessibilityRole="alert">
          {flow.notice}
        </Text>
      ) : null}
      <ResetActions {...props} />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: { padding: theme.spacing[4], gap: theme.spacing[4] },
  identity: { gap: theme.spacing[1] },
  primary: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  text: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.base },
  metadata: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  credit: {
    gap: theme.spacing[2],
    padding: theme.spacing[3],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
  },
  selectedCredit: {
    gap: theme.spacing[2],
    padding: theme.spacing[3],
    borderWidth: 1,
    borderColor: theme.colors.accent,
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface2,
  },
  touchTarget: { minHeight: 44 },
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
  },
}));
