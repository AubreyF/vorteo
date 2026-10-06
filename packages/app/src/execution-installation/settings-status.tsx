import { useCallback, useState, type ReactNode } from "react";
import { Text, View } from "react-native";
import type { InstallationSettings } from "@getpaseo/protocol/installation-settings";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { settingsStyles } from "@/styles/settings";
import { useInstallationSettings } from "./settings";

function MigrationCandidate({
  label,
  settings,
  differences,
  onChoose,
  disabled,
}: {
  label: string;
  settings: InstallationSettings;
  differences: string;
  onChoose: (settings: InstallationSettings) => Promise<void>;
  disabled: boolean;
}) {
  const choose = useCallback(() => {
    void onChoose(settings);
  }, [onChoose, settings]);
  return (
    <SettingsSection title={label}>
      <Text selectable style={settingsStyles.rowHint}>
        {differences}
      </Text>
      <Button onPress={choose} disabled={disabled}>
        Use these shared values
      </Button>
    </SettingsSection>
  );
}

export function InstallationSettingsStatus({ children }: { children: ReactNode }) {
  const { installation, data, error, save } = useInstallationSettings();
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const choose = useCallback(
    async (settings: InstallationSettings) => {
      if (!data) return;
      setSaving(true);
      setSaveError(null);
      try {
        await save({ expectedRevision: data.revision, settings });
      } catch (cause) {
        setSaveError(cause instanceof Error ? cause.message : "Unable to save shared settings.");
      } finally {
        setSaving(false);
      }
    },
    [data, save],
  );
  if (!installation) return children;
  if (error && !data) return <Alert variant="error" description={error.message} />;
  if (!data) return <Text style={settingsStyles.rowHint}>Loading shared settings...</Text>;
  if (data.conflicts) {
    const conflicts = data.conflicts;
    return (
      <View>
        <Alert
          variant="warning"
          description="Host and dev settings differ. Review the values below and choose the initial shared configuration. Environment credentials remain local."
        />
        {saveError ? <Alert variant="error" description={saveError} /> : null}
        {Object.entries(conflicts.candidates).map(([serverId, settings]) => (
          <MigrationCandidate
            key={serverId}
            label={
              installation.environments.find((environment) => environment.serverId === serverId)
                ?.kind === "host"
                ? "Host values"
                : "Dev container values"
            }
            settings={settings}
            differences={JSON.stringify(
              Object.fromEntries(conflicts.fields.map((field) => [field, settings[field]])),
              null,
              2,
            )}
            onChoose={choose}
            disabled={saving}
          />
        ))}
      </View>
    );
  }
  if (!data.settings)
    return (
      <Alert
        variant="warning"
        description="Waiting to read both environments before migrating shared settings. Existing settings have not been changed."
      />
    );
  const pending = Object.entries(data.sources).filter(
    ([, source]) => source.pendingRevision !== null || source.error !== null,
  );
  const needsAccountBinding = pending.some(
    ([, source]) => source.error === "account_binding_unavailable",
  );
  let pendingDescription = needsAccountBinding
    ? "Shared settings are saved. An environment needs a unique enabled binding for the selected account before it can apply them."
    : "Shared settings are saved. Some environments are still waiting to apply them.";
  if (pending.some(([, source]) => source.error === "skill_removal_review_required")) {
    pendingDescription =
      "Shared settings are saved. Open the skill selector and save again to review pending removals.";
  }
  return (
    <View>
      {error ? <Alert variant="error" description={error.message} /> : null}
      {pending.length ? <Alert variant="warning" description={pendingDescription} /> : null}
      {children}
    </View>
  );
}
