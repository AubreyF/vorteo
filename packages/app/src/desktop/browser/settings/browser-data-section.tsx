import { useCallback, useRef, useState } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { useToast } from "@/contexts/toast-context";
import { getDesktopHost } from "@/desktop/host";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { useBrowserStore } from "@/desktop/browser/store";
import { settingsStyles } from "@/styles/settings";
import { confirmDialog } from "@/utils/confirm-dialog";

export function BrowserDataSection() {
  const { t } = useTranslation();
  const toast = useToast();
  const clearInFlightRef = useRef(false);
  const [isClearing, setIsClearing] = useState(false);
  const [isResetting, setIsResetting] = useState(false);

  const handleResetPermissions = useCallback(async () => {
    if (clearInFlightRef.current) return;
    clearInFlightRef.current = true;
    setIsResetting(true);
    try {
      if (
        !(await confirmDialog({
          title: t("settings.general.browserData.resetTitle", {
            defaultValue: "Reset site permissions?",
          }),
          message: t("settings.general.browserData.resetMessage", {
            defaultValue:
              "Saved allow and block decisions will be removed and browser tabs will reload. Cookies and sign-ins will stay.",
          }),
          confirmLabel: t("settings.general.browserData.reset", {
            defaultValue: "Reset permissions",
          }),
          cancelLabel: t("common.actions.cancel"),
        }))
      )
        return;
      const reset = getDesktopHost()?.browser?.resetPermissions;
      if (!reset) throw new Error("Browser permission controls are unavailable");
      await reset();
      toast.show(
        t("settings.general.browserData.resetSuccess", { defaultValue: "Site permissions reset." }),
        { variant: "success" },
      );
    } catch {
      toast.error(
        t("settings.general.browserData.resetError", {
          defaultValue: "Couldn't reset site permissions.",
        }),
      );
    } finally {
      clearInFlightRef.current = false;
      setIsResetting(false);
    }
  }, [t, toast]);

  const handleClear = useCallback(async () => {
    if (clearInFlightRef.current) {
      return;
    }

    clearInFlightRef.current = true;
    setIsClearing(true);
    try {
      const confirmed = await confirmDialog({
        title: t("settings.general.browserData.confirmTitle"),
        message: t("settings.general.browserData.confirmMessage"),
        confirmLabel: t("settings.general.browserData.clear"),
        cancelLabel: t("common.actions.cancel"),
        destructive: true,
      });
      if (!confirmed) {
        return;
      }

      const clearProfile = getDesktopHost()?.browser?.clearProfile;
      if (!clearProfile) {
        throw new Error("Electron browser profile bridge is unavailable");
      }

      await clearProfile(Object.keys(useBrowserStore.getState().browsersById));
      toast.show(t("settings.general.browserData.success"), { variant: "success" });
    } catch {
      toast.error(t("settings.general.browserData.error"));
    } finally {
      clearInFlightRef.current = false;
      setIsClearing(false);
    }
  }, [t, toast]);
  const clearButtonLabel = isClearing
    ? t("settings.general.browserData.clearing")
    : t("settings.general.browserData.clear");

  return (
    <SettingsSection title={t("settings.general.browserData.title")}>
      <View style={settingsStyles.card}>
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>
              {t("settings.general.browserData.siteData")}
            </Text>
            <Text style={settingsStyles.rowHint}>
              {t("settings.general.browserData.description")}
            </Text>
          </View>
          <Button
            variant="outline"
            size="sm"
            loading={isClearing}
            disabled={isClearing || isResetting}
            onPress={handleClear}
          >
            {clearButtonLabel}
          </Button>
        </View>
        {getDesktopHost()?.browser?.resetPermissions ? (
          <View style={settingsStyles.row}>
            <View style={settingsStyles.rowContent}>
              <Text style={settingsStyles.rowTitle}>
                {t("settings.general.browserData.permissions", {
                  defaultValue: "Site permissions",
                })}
              </Text>
              <Text style={settingsStyles.rowHint}>
                {t("settings.general.browserData.permissionsHint", {
                  defaultValue:
                    "Sites ask before using your camera, microphone, location or notifications. Remembering a choice is optional.",
                })}
              </Text>
            </View>
            <Button
              variant="outline"
              size="sm"
              loading={isResetting}
              disabled={isClearing || isResetting}
              onPress={handleResetPermissions}
            >
              {t("settings.general.browserData.reset", { defaultValue: "Reset permissions" })}
            </Button>
          </View>
        ) : null}
      </View>
    </SettingsSection>
  );
}
