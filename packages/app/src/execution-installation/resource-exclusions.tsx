import { useCallback, useState } from "react";
import { Text, View } from "react-native";
import { Switch } from "@/components/ui/switch";
import { Alert } from "@/components/ui/alert";
import { settingsStyles } from "@/styles/settings";
import { useInstallationSettings } from "./settings";
import { PluginDirectoryBinding } from "./plugin-directory-binding";

type ResourceKind =
  | "browserTools"
  | "terminalProfileIds"
  | "metadataProviderIds"
  | "pluginIds"
  | "skillIdentities"
  | "providerIds";

function ResourceAvailability({
  serverId,
  kind,
  id,
  name,
}: {
  serverId: string;
  kind: ResourceKind;
  id: string;
  name: string;
}) {
  const { data, save } = useInstallationSettings();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const value = data?.settings?.resourceExclusions[serverId]?.[kind];
  const excluded = value === true || (Array.isArray(value) && value.includes(id));
  const change = useCallback(
    async (available: boolean) => {
      if (!data?.settings || saving) return;
      const exclusions = data.settings.resourceExclusions;
      const environment = exclusions[serverId] ?? {
        terminalProfileIds: [],
        metadataProviderIds: [],
      };
      const current = environment[kind];
      const ids = Array.isArray(current) ? current.filter((entry) => entry !== id) : [];
      if (!available) ids.push(id);
      const next = kind === "browserTools" ? !available : ids;
      setSaving(true);
      setError(null);
      try {
        await save({
          expectedRevision: data.revision,
          settings: {
            resourceExclusions: {
              ...exclusions,
              [serverId]: { ...environment, [kind]: next },
            },
          },
        });
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Unable to change availability.");
      } finally {
        setSaving(false);
      }
    },
    [data, saving, serverId, kind, id, save],
  );
  return (
    <View>
      <View style={settingsStyles.row}>
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle}>{name}</Text>
          <Text style={settingsStyles.rowHint}>Available in this environment</Text>
        </View>
        <Switch
          testID={`resource-availability-${serverId}-${kind}-${id}`}
          accessibilityLabel={`${name} availability`}
          value={!excluded}
          onValueChange={change}
          disabled={saving}
        />
      </View>
      {error ? <Alert variant="error" description={error} /> : null}
    </View>
  );
}

export function EnvironmentResourceExclusions({ serverId }: { serverId: string }) {
  const { installation, data } = useInstallationSettings();
  if (!installation?.environments.some((environment) => environment.serverId === serverId))
    return null;
  if (!data?.settings) return null;
  const settings = data.settings;
  return (
    <View>
      <Text style={settingsStyles.rowTitle}>Environment exceptions</Text>
      <Text style={settingsStyles.rowHint}>
        Shared resources are available by default. Turn off only the resources this environment
        should not use. Agent profile availability is configured in each profile.
      </Text>
      {settings.browserTools ? (
        <ResourceAvailability
          serverId={serverId}
          kind="browserTools"
          id="browser"
          name="Browser tools"
        />
      ) : null}
      {settings.providerDefinitions
        ?.filter((provider) => !provider.removed)
        .map((provider) => (
          <ResourceAvailability
            key={`provider-${provider.id}`}
            serverId={serverId}
            kind="providerIds"
            id={provider.id}
            name={`Provider: ${provider.policy.label ?? provider.providerType}`}
          />
        ))}
      {settings.skillLibrary?.map((skill) => (
        <ResourceAvailability
          key={`skill-${skill.identity}`}
          serverId={serverId}
          kind="skillIdentities"
          id={skill.identity}
          name={`Skill: ${skill.name}`}
        />
      ))}
      {data.settings.plugins?.map((plugin) => (
        <View key={`plugin-${plugin.id}`}>
          <ResourceAvailability
            serverId={serverId}
            kind="pluginIds"
            id={plugin.id}
            name={`Plugin: ${plugin.id}`}
          />
          {plugin.source.kind === "directory" ? (
            <PluginDirectoryBinding
              serverId={serverId}
              pluginId={plugin.id}
              enabled={
                plugin.enabled &&
                !(settings.resourceExclusions[serverId]?.pluginIds?.includes(plugin.id) ?? false)
              }
            />
          ) : null}
        </View>
      ))}
      {data.settings.terminalProfiles.map((profile) => (
        <ResourceAvailability
          key={profile.id}
          serverId={serverId}
          kind="terminalProfileIds"
          id={profile.id}
          name={profile.name}
        />
      ))}
      {data.settings.metadataGeneration.providers.map((provider) => (
        <ResourceAvailability
          key={provider.provider}
          serverId={serverId}
          kind="metadataProviderIds"
          id={provider.provider}
          name={`Metadata: ${provider.provider}`}
        />
      ))}
    </View>
  );
}
