import { Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { AgentUsageSection, useAgentUsage } from "@/usage";
import { ProviderUsageTooltipSection } from "@/provider-usage/tooltip-section";
import { useProviderUsage } from "@/provider-usage/use-provider-usage";
import { useSessionStore } from "@/stores/session-store";

import { ContextBreakdown } from "./context-breakdown/view";
import { useContextBreakdown } from "./context-breakdown/use-context-breakdown";

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
 *
 * The breakdown, account usage and plan usage load independently. Until all three settle, one
 * loading pulse stands in for them, so the details appear together instead of as three
 * separate loading sentences.
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
  const breakdown = useContextBreakdown(serverId, agentId);
  const accountUsage = useAgentUsage(serverId, agentId);
  const { view: planUsage } = useProviderUsage(serverId, { refreshOnMount: true });
  const provider = useSessionStore(
    (state) => state.sessions[serverId]?.agents.get(agentId)?.provider,
  );
  const loading =
    breakdown.kind === "loading" || accountUsage.kind === "loading" || planUsage.kind === "loading";

  return (
    <>
      {showTitle ? <Text style={styles.title}>{t("contextWindow.title")}</Text> : null}
      <ContextBreakdown
        view={breakdown}
        loading={loading}
        percentage={percentage}
        usedTokens={usedTokens}
        maxTokens={maxTokens}
        sessionCost={sessionCost}
        interactive={refreshable}
      />
      {loading ? null : (
        <>
          <AgentUsageSection serverId={serverId} view={accountUsage} refreshable={refreshable} />
          <ProviderUsageTooltipSection view={planUsage} activeProviderId={provider} />
        </>
      )}
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
}));
