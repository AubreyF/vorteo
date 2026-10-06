import { useMaintenanceTask } from "@/execution-installation/use-maintenance-task";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { settingsStyles } from "@/styles/settings";
import { openExternalUrl } from "@/utils/open-external-url";
import { useFormPreferences } from "@/hooks/use-form-preferences";

import { buildUpdatePrompt, VORTON_REPOSITORY, type VortonUpdate } from "./check";
import { useVortonUpdate, VORTON_BUILD_COMMIT } from "./use-update";
import { UpdateSuccessBadge } from "./success-badge";

function statusText(update: VortonUpdate | undefined, t: TFunction): string {
  if (!update) return t("settings.about.vortonUpdates.idle");
  return t(`settings.about.vortonUpdates.${update.status}`, { count: update.incomingCommits });
}

export function VortonUpdatesSection() {
  const { isLoading: preferencesLoading } = useFormPreferences();
  const { t } = useTranslation();
  const update = useVortonUpdate();
  const prepareTask = useMaintenanceTask();
  const checking = update.isFetching || update.feedback.phase === "checking";
  const showSuccess = update.feedback.phase === "success" && !update.isFetching;
  const help = useCallback(() => {
    prepareTask(buildUpdatePrompt(VORTON_BUILD_COMMIT, update.data?.latestCommit ?? null));
  }, [prepareTask, update.data?.latestCommit]);
  const changes = useCallback(() => {
    const url =
      VORTON_BUILD_COMMIT && update.data && update.data.status !== "unpublished"
        ? `${VORTON_REPOSITORY}/compare/${VORTON_BUILD_COMMIT}...${update.data.latestCommit}`
        : `${VORTON_REPOSITORY}/commits/main`;
    void openExternalUrl(url);
  }, [update.data]);
  if (preferencesLoading) return null;
  let message = statusText(update.data, t);
  if (!VORTON_BUILD_COMMIT) message = t("settings.about.vortonUpdates.unknown");
  else if (checking) message = t("settings.about.vortonUpdates.checking");
  else if (update.isError)
    message = t("settings.about.vortonUpdates.failed", { error: update.error.message });
  return (
    <SettingsSection
      title={t("settings.about.vortonUpdates.title")}
      testID="vorton-updates-section"
    >
      <View style={settingsStyles.card}>
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle} testID="vorton-update-status">
              {message}
            </Text>
            <Text style={settingsStyles.rowHint}>
              {VORTON_BUILD_COMMIT
                ? t("settings.about.vortonUpdates.commit", {
                    commit: VORTON_BUILD_COMMIT.slice(0, 7),
                  }) + " "
                : ""}
              {t("settings.about.vortonUpdates.interval")}
            </Text>
          </View>
        </View>
        <View style={styles.actions}>
          <Button
            variant="outline"
            size="md"
            onPress={update.checkNow}
            loading={checking}
            disabled={!VORTON_BUILD_COMMIT}
            testID="vorton-check-update"
          >
            {t(`settings.about.vortonUpdates.${checking ? "checking" : "check"}`)}
          </Button>
          <Button variant="outline" size="md" onPress={changes}>
            {t("settings.about.vortonUpdates.changes")}
          </Button>
          <Button size="md" onPress={help} testID="vorton-help-update">
            Prepare host update task
          </Button>
        </View>
        <View style={styles.hintArea} testID="vorton-update-feedback-area">
          {/* Keep the instructions in layout so feedback never moves the card or buttons. */}
          <Text
            style={[styles.hint, showSuccess && styles.hiddenHint]}
            accessibilityElementsHidden={showSuccess}
            importantForAccessibility={showSuccess ? "no-hide-descendants" : "auto"}
            testID="vorton-update-instructions"
          >
            Review and edit the host task, select a project and agent, then send it when ready.
          </Text>
          {showSuccess && (
            <View style={styles.feedbackOverlay} pointerEvents="none">
              <UpdateSuccessBadge
                label={t(
                  `settings.about.vortonUpdates.${update.feedback.result?.status === "current" ? "confirmedCurrent" : "checkComplete"}`,
                )}
              />
            </View>
          )}
        </View>
      </View>
    </SettingsSection>
  );
}

const styles = StyleSheet.create((theme) => ({
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[3],
  },
  hint: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  hiddenHint: {
    opacity: 0,
  },
  hintArea: {
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[4],
  },
  feedbackOverlay: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[4],
    justifyContent: "center",
    alignItems: "flex-start",
  },
}));
