import { useCallback, useState } from "react";
import { View, Text } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { FOOTER_HEIGHT } from "@/constants/layout";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { KeyboardTranslateView } from "@/keyboard/shift";
import { Button } from "@/components/ui/button";
import type { Theme } from "@/styles/theme";
import { useReportActionError } from "@/hooks/use-action-error";

interface ArchivedAgentCalloutProps {
  serverId: string;
  agentId: string;
}

export function ArchivedAgentCallout({ serverId, agentId }: ArchivedAgentCalloutProps) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const [isUnarchiving, setIsUnarchiving] = useState(false);
  const reportActionError = useReportActionError();

  const handleUnarchive = useCallback(async () => {
    if (!client || !isConnected || isUnarchiving) return;
    setIsUnarchiving(true);
    try {
      await client.refreshAgent(agentId);
    } catch (error) {
      reportActionError(error);
      setIsUnarchiving(false);
    }
  }, [client, isConnected, isUnarchiving, agentId, reportActionError]);

  return (
    <KeyboardTranslateView style={styles.container}>
      <View style={styles.inputAreaContainer}>
        <View style={styles.inputAreaContent}>
          <View style={styles.callout}>
            <Text style={styles.calloutText}>{t("agentPanel.archived.callout")}</Text>
            <Button
              size="sm"
              variant="secondary"
              onPress={handleUnarchive}
              disabled={!isConnected || isUnarchiving}
            >
              {t("agentPanel.archived.unarchive")}
            </Button>
          </View>
        </View>
      </View>
    </KeyboardTranslateView>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  container: {
    flexDirection: "column",
    position: "relative",
  },
  inputAreaContainer: {
    position: "relative",
    minHeight: FOOTER_HEIGHT,
    marginHorizontal: "auto",
    alignItems: "center",
    width: "100%",
    overflow: "visible",
    padding: theme.spacing[4],
  },
  inputAreaContent: {
    width: "100%",
    maxWidth: theme.contentMaxWidth,
  },
  callout: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[3],
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.borderAccent,
    borderRadius: theme.borderRadius["2xl"],
    paddingVertical: {
      xs: theme.spacing[3],
      md: theme.spacing[4],
    },
    paddingHorizontal: {
      xs: theme.spacing[4],
      md: theme.spacing[6],
    },
  },
  calloutText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
})) as unknown as Record<string, object>;
