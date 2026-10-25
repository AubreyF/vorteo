import { useCustomIconState, loadCustomIcons } from "@/plugins/icon-catalog";
import { Button } from "@/components/ui/button";
import { useCallback, useState } from "react";
import { SettingsCard, SettingsRow, SettingsSection } from "@/components/settings";
import { Switch } from "@/components/ui/switch";
import { isWeb } from "@/constants/platform";
import { useDataSaver, setDataSaver } from "@/network-preferences";

export function DataSaverSection() {
  const enabled = useDataSaver();
  const icons = useCustomIconState();
  const loadIcons = useCallback(() => {
    void loadCustomIcons().catch(() => undefined);
  }, []);
  const [sessionOnly, setSessionOnly] = useState(false);
  const change = useCallback((value: boolean) => {
    setSessionOnly(!setDataSaver(value));
  }, []);
  if (!isWeb) return null;
  let iconHint = "Common icons remain available. Other icons use a placeholder until downloaded.";
  let iconAction = "Load custom icons";
  if (icons.phase === "ready") iconHint = "Custom icons are downloaded and available.";
  if (icons.phase === "loading") {
    iconHint =
      "Downloading custom icons. A slow request stays in progress without duplicate retries.";
    iconAction = "Downloading…";
  }
  if (icons.phase === "failed") iconAction = "Retry icons";
  return (
    <SettingsSection title="Data saver" testID="settings-data-saver">
      <SettingsCard>
        <SettingsRow
          label="Use less data in this browser"
          hint={
            sessionOnly
              ? "Applied to this page. Browser storage is unavailable, so this choice cannot be saved."
              : "Use system fonts and defer diagrams and custom icons until requested. Text and attachments stay available when connected."
          }
        >
          <Switch
            value={enabled}
            onValueChange={change}
            accessibilityLabel="Use less data in this browser"
          />
        </SettingsRow>
        <SettingsRow
          label="Optional custom icons"
          hint={iconHint}
          error={
            icons.phase === "failed"
              ? "The icon download failed. Retry, or reload after three failed attempts."
              : undefined
          }
        >
          <Button
            variant="outline"
            onPress={loadIcons}
            disabled={icons.phase === "loading" || icons.phase === "ready" || icons.attempts >= 3}
          >
            {iconAction}
          </Button>
        </SettingsRow>
      </SettingsCard>
    </SettingsSection>
  );
}
