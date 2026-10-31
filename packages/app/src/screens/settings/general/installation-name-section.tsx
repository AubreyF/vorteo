import { useCallback, useState } from "react";
import { Text } from "react-native";
import { SettingsCard, SettingsRow, SettingsSection } from "@/components/settings";
import { Button } from "@/components/ui/button";
import { FormTextInput } from "@/components/ui/form-field";
import { settingsStyles } from "@/styles/settings";
import { toErrorMessage } from "@/utils/error-messages";
import {
  DEFAULT_INSTALLATION_NAME,
  saveInstallationName,
  useInstallationName,
} from "@/execution-installation/installation-name";
import { readExecutionInstallation } from "@/execution-installation/policy";

/** Names this installation so two open side by side, such as a lab and production, never blur. */
export function InstallationNameSection() {
  const name = useInstallationName();
  const [draft, setDraft] = useState(name);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const save = useCallback(async () => {
    setSaving(true);
    setNotice(null);
    try {
      const saved = await saveInstallationName(draft);
      setDraft(saved);
      setNotice("Saved.");
    } catch (error) {
      setNotice(toErrorMessage(error));
    } finally {
      setSaving(false);
    }
  }, [draft]);
  const pressSave = useCallback(() => void save(), [save]);
  if (!readExecutionInstallation()) return null;
  const unchanged = draft.trim() === name || (!draft.trim() && name === DEFAULT_INSTALLATION_NAME);
  return (
    <SettingsSection title="Installation name" testID="settings-installation-name">
      <SettingsCard>
        <SettingsRow
          label="Name"
          hint={`Shown in the browser tab, the welcome page and the sidebar. Leave empty for "${DEFAULT_INSTALLATION_NAME}".`}
        >
          <FormTextInput
            size="sm"
            initialValue={name}
            onChangeText={setDraft}
            onSubmitEditing={pressSave}
            placeholder={DEFAULT_INSTALLATION_NAME}
            maxLength={40}
            autoCorrect={false}
            editable={!saving}
            accessibilityLabel="Installation name"
            testID="settings-installation-name-input"
          />
          <Button
            variant="outline"
            size="sm"
            onPress={pressSave}
            disabled={saving || unchanged}
            testID="settings-installation-name-save"
          >
            {saving ? "Saving..." : "Save"}
          </Button>
        </SettingsRow>
        {notice ? (
          <Text accessibilityLiveRegion="polite" style={settingsStyles.rowHint}>
            {notice}
          </Text>
        ) : null}
      </SettingsCard>
    </SettingsSection>
  );
}
