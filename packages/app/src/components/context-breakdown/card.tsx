import { useCallback, useMemo } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/shallow";
import { useCardDisclosure } from "@/agent-stream/use-card-disclosure";
import { TaskCard, TaskCardHeader } from "@/agent-stream/task-card";
import { TaskCardIcon } from "@/agent-stream/task-card-icon";
import { CardDisclosure } from "@/agent-stream/card-disclosure";
import { CountBadge } from "@/components/ui/count-badge";
import { ContextWindowDetails } from "@/components/context-window-details";
import { formatSessionCost, getUsagePercentage } from "@/components/context-window-meter.utils";
import { useSessionStore } from "@/stores/session-store";

/**
 * The context window meter's details as a persistent details card. It renders whenever the agent
 * has reported usage, for every provider; the body is the meter popover's content.
 */
export function ContextCard({ serverId, agentId }: { serverId: string; agentId: string }) {
  const usage = useSessionStore(
    useShallow((state) => {
      const session = state.sessions[serverId];
      const agent = session?.agents.get(agentId) ?? session?.agentDetails.get(agentId);
      return {
        maxTokens: agent?.lastUsage?.contextWindowMaxTokens ?? null,
        usedTokens: agent?.lastUsage?.contextWindowUsedTokens ?? null,
        totalCostUsd: agent?.lastUsage?.totalCostUsd ?? null,
      };
    }),
  );
  if (usage.maxTokens === null || usage.usedTokens === null) return null;
  const percentage = getUsagePercentage(usage.maxTokens, usage.usedTokens);
  if (percentage === null) return null;
  return (
    <ContextCardContent
      serverId={serverId}
      agentId={agentId}
      percentage={Math.round(percentage)}
      usedTokens={usage.usedTokens}
      maxTokens={usage.maxTokens}
      sessionCost={usage.totalCostUsd === null ? null : formatSessionCost(usage.totalCostUsd)}
    />
  );
}

function ContextCardContent({
  serverId,
  agentId,
  percentage,
  usedTokens,
  maxTokens,
  sessionCost,
}: {
  serverId: string;
  agentId: string;
  percentage: number;
  usedTokens: number;
  maxTokens: number;
  sessionCost: string | null;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useCardDisclosure("context");
  const toggle = useCallback(() => setExpanded((value) => !value), [setExpanded]);
  const badge = useMemo(
    () => (
      <CountBadge
        label={`${percentage}%`}
        accessibilityLabel={t("contextWindow.accessibility", { percentage })}
        testID="agent-context-card-percentage"
      />
    ),
    [percentage, t],
  );
  return (
    <TaskCard testID="agent-context-card" bodyVisible={expanded}>
      <TaskCardHeader>
        <CardDisclosure
          icon={HEADING_ICON}
          title={t("contextWindow.title")}
          expanded={expanded}
          onPress={toggle}
          count={badge}
          testID="agent-context-toggle"
        />
      </TaskCardHeader>
      {/* Mounted only while expanded, so the breakdown is read only while someone looks. */}
      {expanded ? (
        <View style={styles.body}>
          <ContextWindowDetails
            serverId={serverId}
            agentId={agentId}
            percentage={percentage}
            usedTokens={usedTokens}
            maxTokens={maxTokens}
            sessionCost={sessionCost}
            showTitle={false}
            refreshable
          />
        </View>
      ) : null}
    </TaskCard>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: { gap: theme.spacing[4], paddingBottom: theme.spacing[2] },
}));

const HEADING_ICON = <TaskCardIcon kind="context" />;
