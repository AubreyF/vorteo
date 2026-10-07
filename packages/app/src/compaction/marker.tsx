import React, { memo, useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronDown, ChevronRight, Copy, Download } from "lucide-react-native";
import * as Clipboard from "expo-clipboard";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { getCompactionMarkerLabel } from "@/components/message-compaction-label";
import type { CompactionItem } from "@/types/stream";
import type { CompactionInspection } from "@getpaseo/protocol/messages";
import { exportCompactionSummary } from "./export";

const ThemedSpinner = withUnistyles(LoadingSpinner, (theme) => ({
  color: theme.colors.foregroundMuted,
}));

export const CompactionMarker = memo(function CompactionMarker({ item }: { item: CompactionItem }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const toggle = useCallback(() => setExpanded((value) => !value), []);
  const accessibilityState = useMemo(() => ({ expanded }), [expanded]);
  const summary = item.inspection?.summary;
  let label = getCompactionMarkerLabel(item);
  if (summary?.type === "unavailable" && summary.reason === "failed")
    label = t("message.compaction.failed");
  if (summary?.type === "unavailable" && summary.reason === "aborted")
    label = t("message.compaction.aborted");
  const showInspector = expanded && item.status === "completed";
  return (
    <View style={styles.container}>
      <View style={styles.marker}>
        <View style={styles.line} />
        {item.status === "loading" ? (
          <View style={styles.loading}>
            <ThemedSpinner size="small" />
            <Text style={styles.metadata}>{label}</Text>
          </View>
        ) : (
          <Button
            variant="ghost"
            size="md"
            leftIcon={expanded ? ChevronDown : ChevronRight}
            accessibilityLabel={label}
            accessibilityState={accessibilityState}
            onPress={toggle}
            style={styles.trigger}
            textStyle={styles.triggerText}
          >
            {label}
          </Button>
        )}
        <View style={styles.line} />
      </View>
      {showInspector ? <CompactionInspector item={item} /> : null}
    </View>
  );
});

function CompactionInspector({ item }: { item: CompactionItem }) {
  const { t } = useTranslation();
  const inspection = item.inspection;
  const summary = inspection?.summary;
  return (
    <View style={styles.inspector} testID="compaction-inspector">
      <Text style={styles.heading}>{t("message.compaction.summaryTitle")}</Text>
      <Text style={styles.metadata}>{t("message.compaction.summaryDescription")}</Text>
      <Text style={styles.metadata}>{item.timestamp.toLocaleString()}</Text>
      {item.preTokens !== undefined ? (
        <Text style={styles.metadata}>
          {t("message.compaction.beforeTokens", { count: item.preTokens })}
        </Text>
      ) : null}
      {inspection?.postTokens !== undefined ? (
        <Text style={styles.metadata}>
          {t("message.compaction.afterTokens", { count: inspection.postTokens })}
        </Text>
      ) : null}
      {inspection?.estimatedPostTokens !== undefined ? (
        <Text style={styles.metadata}>
          {t("message.compaction.estimatedAfterTokens", { count: inspection.estimatedPostTokens })}
        </Text>
      ) : null}
      {inspection?.firstKeptEntryId ? (
        <Text selectable style={styles.metadata}>
          {t("message.compaction.retainedFrom", { id: inspection.firstKeptEntryId })}
        </Text>
      ) : null}
      {summary?.type === "text" ? (
        <SummaryContent text={summary.text} timestamp={item.timestamp} />
      ) : (
        <UnavailableSummary summary={summary} />
      )}
    </View>
  );
}

function UnavailableSummary({
  summary,
}: {
  summary: Exclude<CompactionInspection["summary"], { type: "text" }> | undefined;
}) {
  const { t } = useTranslation();
  const reason = summary ? summary.reason : "not_saved";
  return (
    <Text selectable style={styles.metadata}>
      {t(`message.compaction.${reason}`)}
      {summary?.error ? `\n${summary.error}` : ""}
    </Text>
  );
}

type SummaryAction = "idle" | "copying" | "exporting" | "copied" | "exported" | "error";
function SummaryContent({ text, timestamp }: { text: string; timestamp: Date }) {
  const { t } = useTranslation();
  const [action, setAction] = useState<SummaryAction>("idle");
  const pending = action === "copying" || action === "exporting";
  const perform = useCallback(
    async (next: "copying" | "exporting") => {
      if (pending) return;
      setAction(next);
      try {
        if (next === "copying") {
          if (!(await Clipboard.setStringAsync(text))) throw new Error("Clipboard write failed");
        } else {
          await exportCompactionSummary(text, `compaction-${timestamp.getTime()}.txt`);
        }
        setAction(next === "copying" ? "copied" : "exported");
      } catch {
        setAction("error");
      }
    },
    [pending, text, timestamp],
  );
  const copy = useCallback(() => void perform("copying"), [perform]);
  const download = useCallback(() => void perform("exporting"), [perform]);
  return (
    <>
      <View style={styles.actions}>
        <Button variant="ghost" size="md" leftIcon={Copy} disabled={pending} onPress={copy}>
          {t("message.compaction.copy")}
        </Button>
        <Button variant="ghost" size="md" leftIcon={Download} disabled={pending} onPress={download}>
          {t("message.compaction.download")}
        </Button>
      </View>
      {action !== "idle" ? (
        <Text accessibilityLiveRegion="polite" style={styles.metadata}>
          {t(`message.compaction.${action}`)}
        </Text>
      ) : null}
      <Text selectable style={styles.summary} testID="compaction-summary">
        {text}
      </Text>
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: { paddingVertical: theme.spacing[3], paddingHorizontal: theme.spacing[4] },
  marker: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  line: { flex: 1, height: 1, backgroundColor: theme.colors.border },
  trigger: { flexShrink: 1 },
  triggerText: { flexShrink: 1, color: theme.colors.foregroundMuted },
  loading: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  inspector: { gap: theme.spacing[2], paddingTop: theme.spacing[3] },
  heading: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  metadata: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[2] },
  summary: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.base,
    color: theme.colors.foreground,
  },
}));
