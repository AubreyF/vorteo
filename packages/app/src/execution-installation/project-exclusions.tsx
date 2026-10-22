import { useCallback, useState } from "react";
import { Text, View } from "react-native";
import {
  projectPolicyKey,
  type InstallationProjectPolicy,
  type InstallationSettingsSnapshot,
} from "@getpaseo/protocol/installation-settings";
import { profilePolicyIdentity } from "@getpaseo/protocol/provider-preferences";
import { Alert } from "@/components/ui/alert";
import { Switch } from "@/components/ui/switch";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { settingsStyles } from "@/styles/settings";
import { useAgentProfiles } from "@/agent-profiles/internal/use-agent-profiles";
import { EnvironmentAvailabilityField } from "./environment-availability-field";
import { OwnerAccessExpired } from "./client";
import { useInstallationSettings } from "./settings";
import { readExecutionInstallation } from "./policy";

const LIST_FIELDS = ["providerIds", "profileIds", "skillIdentities"] as const;
type ListField = (typeof LIST_FIELDS)[number];
type ProjectPolicyPatch = Partial<InstallationProjectPolicy>;

interface ExclusionChoice {
  field: ListField;
  id: string;
  name: string;
}

/**
 * Per-project exclusions, stored by the installation rather than in `paseo.json`. They add to
 * each environment's exclusions; the daemons refuse excluded launches and workspaces.
 */
export function ProjectExclusionsSection(props: { rootPath: string; serverId: string }) {
  if (!readExecutionInstallation()) return null;
  return <ProjectExclusions {...props} />;
}

function ProjectExclusions({ rootPath, serverId }: { rootPath: string; serverId: string }) {
  const { installation, data, error, save } = useInstallationSettings();
  const { profiles } = useAgentProfiles(serverId);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const key = projectPolicyKey(rootPath);
  const settings = data?.settings;
  const policy = settings?.projectPolicies?.[key] ?? {};

  const change = useCallback(
    async (patch: ProjectPolicyPatch) => {
      if (!data?.settings || saving) return;
      setSaving(true);
      setSaveError(null);
      try {
        await save({
          expectedRevision: data.revision,
          settings: { projectPolicies: nextProjectPolicies(data, key, patch) },
        });
      } catch (cause) {
        setSaveError(cause instanceof Error ? cause.message : "Unable to change exclusions.");
      } finally {
        setSaving(false);
      }
    },
    [data, key, save, saving],
  );
  const changeEnvironments = useCallback(
    (excludedEnvironments: NonNullable<InstallationProjectPolicy["excludedEnvironments"]>) => {
      const kinds = installation?.environments.map((environment) => environment.kind) ?? [];
      if (kinds.every((kind) => excludedEnvironments.includes(kind))) {
        setSaveError("Keep this project available in at least one environment.");
        return;
      }
      void change({ excludedEnvironments });
    },
    [change, installation],
  );

  if (!installation) return null;
  if (error instanceof OwnerAccessExpired)
    return (
      <SettingsSection title="Exclusions" testID="project-exclusions">
        <Text style={settingsStyles.rowHint}>
          Unlock Installation controls in General settings to change exclusions for this project.
        </Text>
      </SettingsSection>
    );
  // COMPAT(projectPolicies): coordinators without project policies omit the field.
  if (!settings?.projectPolicies) return null;

  const choices: ExclusionChoice[] = [
    ...(settings.providerDefinitions ?? [])
      .filter((provider) => !provider.removed)
      .map((provider) => ({
        field: "providerIds" as const,
        id: provider.id,
        name: `Account: ${provider.policy.label ?? provider.providerType}`,
      })),
    ...uniqueProfiles(profiles ?? []).map((profile) => ({
      field: "profileIds" as const,
      id: profile.id,
      name: `Profile: ${profile.name}`,
    })),
    ...(settings.skillLibrary ?? []).map((skill) => ({
      field: "skillIdentities" as const,
      id: skill.identity,
      name: `Skill: ${skill.name}`,
    })),
  ];
  return (
    <SettingsSection title="Exclusions" testID="project-exclusions">
      <Text style={settingsStyles.rowHint}>
        Everything is available by default. Turn off what this project should not use. These
        settings belong to this installation, not to files in the project.
      </Text>
      <EnvironmentAvailabilityField
        excludedEnvironments={policy.excludedEnvironments ?? []}
        onChange={changeEnvironments}
        disabled={saving}
      />
      {choices.length > 0 ? (
        <View style={settingsStyles.card}>
          {choices.map((choice) => (
            <ExclusionRow
              key={`${choice.field}:${choice.id}`}
              choice={choice}
              excluded={policy[choice.field]?.includes(choice.id) ?? false}
              disabled={saving}
              onChange={change}
              current={policy[choice.field] ?? []}
            />
          ))}
        </View>
      ) : null}
      {saveError ? <Alert variant="error" description={saveError} /> : null}
    </SettingsSection>
  );
}

function ExclusionRow({
  choice,
  excluded,
  disabled,
  current,
  onChange,
}: {
  choice: ExclusionChoice;
  excluded: boolean;
  disabled: boolean;
  current: readonly string[];
  onChange: (patch: ProjectPolicyPatch) => Promise<void>;
}) {
  const toggle = useCallback(
    (available: boolean) => {
      const remaining = current.filter((id) => id !== choice.id);
      void onChange({ [choice.field]: available ? remaining : [...remaining, choice.id] });
    },
    [choice, current, onChange],
  );
  return (
    <View style={settingsStyles.row}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>{choice.name}</Text>
        <Text style={settingsStyles.rowHint}>Available in this project</Text>
      </View>
      <Switch
        testID={`project-exclusion-${choice.field}-${choice.id}`}
        accessibilityLabel={`${choice.name} availability in this project`}
        value={!excluded}
        onValueChange={toggle}
        disabled={disabled}
      />
    </View>
  );
}

/** Shared workflows appear once per account; the project excludes the workflow everywhere. */
function uniqueProfiles(profiles: readonly { id: string; name: string }[]) {
  const seen = new Map<string, { id: string; name: string }>();
  for (const profile of profiles) {
    const id = profilePolicyIdentity(profile.id);
    if (!seen.has(id)) seen.set(id, { id, name: profile.name });
  }
  return [...seen.values()];
}

function nextProjectPolicies(
  snapshot: InstallationSettingsSnapshot,
  key: string,
  patch: ProjectPolicyPatch,
): Record<string, InstallationProjectPolicy> {
  const policies = structuredClone(snapshot.settings?.projectPolicies ?? {});
  const merged: InstallationProjectPolicy = { ...policies[key], ...patch };
  const cleaned: InstallationProjectPolicy = {};
  if (merged.excludedEnvironments?.length)
    cleaned.excludedEnvironments = merged.excludedEnvironments;
  for (const field of LIST_FIELDS) if (merged[field]?.length) cleaned[field] = merged[field];
  if (Object.keys(cleaned).length === 0) delete policies[key];
  else policies[key] = cleaned;
  return policies;
}
