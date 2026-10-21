import { Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { AgentUsage } from "@/usage";
import { VortonAgentUsage } from "@/provider-usage/tooltip-section";

import { ContextBreakdown } from "./context-breakdown/view";

interface ContextWindowDetailsProps {
  serverId: string;
  agentId: string;
  percentage: number;
  usedTokens: number;
  maxTokens: number;
  sessionCost: string | null;
  /** The tooltip titles itself; the sheet's header carries the title instead. */
  showTitle: boolean;
  /**
   * Only the sheet and the details card can be pressed, so only they show Refresh buttons and
   * expandable breakdown groups.
   */
  refreshable: boolean;
}

/**
 * What the context window meter opens and the Context details card shows: how full the window
 * is and what fills it, then the usage of the agent's account. The wide tooltip, the compact
 * sheet and the card all render it, so they always match.
 */
export function ContextWindowDetails({
  serverId,
  agentId,
  percentage,
  usedTokens,
  maxTokens,
  sessionCost,
  showTitle,
  refreshable,
}: ContextWindowDetailsProps) {
  const { t } = useTranslation();

  return (
    <>
      {showTitle ? <Text style={styles.title}>{t("contextWindow.title")}</Text> : null}
      <ContextBreakdown
        serverId={serverId}
        agentId={agentId}
        percentage={percentage}
        usedTokens={usedTokens}
        maxTokens={maxTokens}
        sessionCost={sessionCost}
        interactive={refreshable}
      />
      <AgentUsage serverId={serverId} agentId={agentId} refreshable={refreshable} />
      {<VortonAgentUsage serverId={serverId} agentId={agentId} />}
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
}));
