import { readExecutionInstallation } from "@/execution-installation/policy";
import { replaceProviderDefaults, editSharedProfile } from "./shared-profile-edits";
import { useInstallationProfiles } from "@/execution-installation/profiles";
import { PreferredChoicesField } from "./preferred-choices-field";
import { sharedChoiceState } from "../shared-choices";
import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import type {
  AgentProfile,
  MutableDaemonConfig,
  ProviderPreferences,
  SharedProviderPreferences,
} from "@getpaseo/protocol/messages";
import { resolveProviderType } from "@getpaseo/protocol/provider-preferences";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { settingsStyles } from "@/styles/settings";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { SelectField } from "@/components/ui/select-field";
import { AgentProfileEditModal } from "./agent-profile-edit-modal";
import { AgentProfileRow } from "./agent-profile-row";
import type { AgentProfileValue } from "../internal/profile-form-model";
import { generateAgentProfileId } from "../internal/profile-id";
import { toErrorMessage } from "@/utils/error-messages";

interface EditTarget {
  serverId: string;
  kind: "defaults" | "workflow";
  profile: AgentProfile;
  snapshot: SharedProviderPreferences;
  providers: MutableDaemonConfig["providers"];
}

export function SharedProviderSection({
  serverId,
  provider,
}: {
  serverId: string;
  provider: string;
}) {
  const { config, patchConfig } = useDaemonConfig(serverId);
  const {
    installation,
    data: sharedSnapshot,
    save: saveInstallation,
    error: installationError,
  } = useInstallationProfiles();
  const { entries } = useProvidersSnapshot(serverId, { cwd: null });
  const [editor, setEditor] = useState<EditTarget | null>(null);
  const [operation, setOperation] = useState<
    { status: "idle" } | { status: "saving" } | { status: "error"; message: string }
  >({ status: "idle" });
  const shared = useMemo(() => {
    const local = config?.sharedProviderPreferences;
    if (!installation) return local;
    if (!sharedSnapshot) return undefined;
    return {
      ...local,
      version: 1 as const,
      revision: sharedSnapshot.revision,
      providers: sharedSnapshot.providers,
      legacyProfiles: local?.legacyProfiles ?? {},
    };
  }, [config, installation, sharedSnapshot]);
  const providerType = resolveProviderType(provider, config?.providers ?? {});
  const group = shared?.providers[providerType];
  const close = useCallback(() => setEditor(null), []);

  const saveGroup = useCallback(
    async (snapshot: SharedProviderPreferences, next: ProviderPreferences) => {
      if (installation) {
        await saveInstallation({
          expectedRevision: snapshot.revision,
          providers: { ...snapshot.providers, [providerType]: next },
        });
        return;
      }
      const saved = await patchConfig({
        expectedProviderPreferencesRevision: snapshot.revision,
        sharedProviderPreferences: {
          ...snapshot,
          providers: { ...snapshot.providers, [providerType]: next },
        },
      }).catch((error: unknown) => {
        if (
          error instanceof Error &&
          "userMessage" in error &&
          typeof error.userMessage === "string"
        ) {
          throw new Error(error.userMessage.replace(/^Request failed: /, ""));
        }
        throw error;
      });
      if (!saved) throw new Error("Reconnect to the host before saving.");
    },
    [patchConfig, providerType, installation, saveInstallation],
  );

  const openDefaults = useCallback(() => {
    if (!shared) return;
    setEditor({
      serverId,
      kind: "defaults",
      snapshot: shared,
      providers: config?.providers ?? {},
      profile: { ...group?.defaults, id: "provider-defaults", name: "Provider defaults", provider },
    });
  }, [shared, group, provider, serverId, config?.providers]);
  const openWorkflow = useCallback(
    (id?: string) => {
      if (!shared) return;
      const workflow = group?.workflows.find((item) => item.id === id);
      const profile = workflow ?? {
        id: generateAgentProfileId(),
        name: "",
        provider: providerType,
        workerProfileId: "",
        maxWorkers: 2,
      };
      setEditor({
        serverId,
        kind: "workflow",
        snapshot: shared,
        providers: config?.providers ?? {},
        profile: { ...group?.defaults, ...profile, provider },
      });
    },
    [shared, group, provider, providerType, serverId, config?.providers],
  );
  const add = useCallback(() => openWorkflow(), [openWorkflow]);

  const save = useCallback(
    async (value: AgentProfileValue) => {
      if (!editor) return;
      const previous = editor.snapshot.providers[providerType] ?? {
        defaults: {},
        preferredModels: [],
        preferredThinkingOptions: [],
        workflows: [],
        defaultWorkflowId: null,
      };
      let next = structuredClone(previous);
      if (editor.kind === "defaults") {
        const {
          name: _name,
          provider: _account,
          nickname: _nickname,
          icon: _icon,
          color: _color,
          notes: _notes,
          excludedEnvironments: _excludedEnvironments,
          ...defaults
        } = value;
        next = replaceProviderDefaults(next, defaults);
      } else {
        const workflow = editSharedProfile(
          next,
          editor.profile.id,
          providerType,
          value,
          editor.providers,
          Boolean(installation),
        );
        const index = next.workflows.findIndex((item) => item.id === workflow.id);
        if (index < 0) next.workflows.push(workflow);
        else next.workflows[index] = workflow;
        next.defaultWorkflowId ??= workflow.id;
      }
      await saveGroup(editor.snapshot, next);
    },
    [editor, providerType, saveGroup, installation],
  );

  const changeDefault = useCallback(
    async (id: string) => {
      if (!shared || !group) return;
      setOperation({ status: "saving" });
      try {
        await saveGroup(shared, { ...group, defaultWorkflowId: id });
        setOperation({ status: "idle" });
      } catch (error) {
        setOperation({ status: "error", message: toErrorMessage(error) });
      }
    },
    [shared, group, saveGroup],
  );

  // Deleting a migrated workflow must retain its legacy launch and worker bindings.
  const remove = useCallback(
    async (id: string) => {
      if (!shared || !group) return;
      const referenced = Object.values(shared.legacyProfiles).some(
        (binding) => binding.workflowId === id && binding.providerType === providerType,
      );
      if (referenced) {
        setOperation({
          status: "error",
          message:
            "This workflow has legacy profile references. Keep it available for legacy launches and workers.",
        });
        return;
      }
      setOperation({ status: "saving" });
      try {
        const workflows = group.workflows.filter((workflow) => workflow.id !== id);
        const defaultWorkflowId =
          group.defaultWorkflowId === id ? (workflows[0]?.id ?? null) : group.defaultWorkflowId;
        await saveGroup(shared, { ...group, workflows, defaultWorkflowId });
        setOperation({ status: "idle" });
      } catch (error) {
        setOperation({ status: "error", message: toErrorMessage(error) });
      }
    },
    [shared, group, providerType, saveGroup],
  );
  const reorder = useCallback(
    async (id: string, offset: number) => {
      if (!shared || !group) return;
      const index = group.workflows.findIndex((workflow) => workflow.id === id);
      const destination = index + offset;
      if (index < 0 || destination < 0 || destination >= group.workflows.length) return;
      const workflows = [...group.workflows];
      [workflows[index], workflows[destination]] = [workflows[destination], workflows[index]];
      setOperation({ status: "saving" });
      try {
        await saveGroup(shared, { ...group, workflows });
        setOperation({ status: "idle" });
      } catch (error) {
        setOperation({ status: "error", message: toErrorMessage(error) });
      }
    },
    [shared, group, saveGroup],
  );
  const moveUp = useCallback(
    (id: string) => {
      void reorder(id, -1);
    },
    [reorder],
  );
  const moveDown = useCallback(
    (id: string) => {
      void reorder(id, 1);
    },
    [reorder],
  );
  const togglePreferred = useCallback(
    async (field: "preferredModels" | "preferredThinkingOptions", id: string) => {
      if (!shared || !group) return;
      const selected = group[field];
      const values = selected.includes(id)
        ? selected.filter((value) => value !== id)
        : [...selected, id];
      setOperation({ status: "saving" });
      try {
        await saveGroup(shared, { ...group, [field]: values });
        setOperation({ status: "idle" });
      } catch (error) {
        setOperation({ status: "error", message: toErrorMessage(error) });
      }
    },
    [shared, group, saveGroup],
  );
  const toggleModel = useCallback(
    (id: string) => {
      void togglePreferred("preferredModels", id);
    },
    [togglePreferred],
  );
  const toggleThinking = useCallback(
    (id: string) => {
      void togglePreferred("preferredThinkingOptions", id);
    },
    [togglePreferred],
  );
  const catalog = useMemo(() => {
    const family = (entries ?? []).filter(
      (entry) => resolveProviderType(entry.provider, config?.providers ?? {}) === providerType,
    );
    const entry = family.find((candidate) => candidate.provider === provider);
    return sharedChoiceState({
      profile: { ...group?.defaults, id: "defaults", name: "Defaults", provider },
      choices: {},
      entry,
      family,
      preferences: group,
    });
  }, [entries, config, providerType, provider, group]);
  const reasoningOptions = useMemo(
    () => catalog.thinkingOptions.filter((option) => option.value !== ""),
    [catalog],
  );
  const workflows = useMemo(
    () =>
      (group?.workflows ?? []).map((workflow) =>
        Object.assign({}, group?.defaults, workflow, { provider }),
      ),
    [group, provider],
  );
  const providerLabel =
    entries?.find((entry) => entry.provider === providerType)?.label ?? providerType;
  const sharedScope = useMemo(() => {
    if (!editor) return undefined;
    const accountLabel =
      entries?.find((entry) => entry.provider === editor.profile.provider)?.label ??
      editor.profile.provider;
    const environment = readExecutionInstallation()?.environments.find(
      (entry) => entry.serverId === editor.serverId,
    );
    return {
      providerType,
      providerLabel,
      kind: editor.kind,
      catalogLabel: environment ? `${accountLabel} (${environment.kind})` : accountLabel,
    };
  }, [editor, entries, providerType, providerLabel]);
  const defaultOptions = (group?.workflows ?? []).map((workflow) => ({
    id: workflow.id,
    value: workflow.id,
    label: workflow.name,
  }));
  const pending = operation.status === "saving";

  const addButton = useMemo(
    () => (
      <Button variant="ghost" size="sm" onPress={add} disabled={!shared || pending}>
        Add profile
      </Button>
    ),
    [add, shared, pending],
  );
  return (
    <>
      <SettingsSection title={`${providerLabel} defaults`} testID="shared-provider-settings">
        {installation ? (
          <Text style={settingsStyles.rowHint}>
            Profiles belong to this installation and are available in every environment unless
            excluded. Account credentials and available models remain local.
          </Text>
        ) : null}
        {installationError ? (
          <Alert variant="error" description={installationError.message} />
        ) : null}
        <View style={settingsStyles.card}>
          <View style={settingsStyles.row}>
            <Text style={settingsStyles.rowHint}>Applies to all {providerLabel} accounts</Text>
            <Button
              variant="outline"
              size="sm"
              onPress={openDefaults}
              disabled={!shared || pending}
            >
              Edit defaults
            </Button>
          </View>
        </View>
        {group ? (
          <>
            <PreferredChoicesField
              label="Preferred models"
              options={catalog.modelOptions}
              preferred={group.preferredModels}
              onToggle={toggleModel}
              disabled={pending}
            />
            <PreferredChoicesField
              label="Preferred reasoning"
              options={reasoningOptions}
              preferred={group.preferredThinkingOptions}
              onToggle={toggleThinking}
              disabled={pending}
            />
          </>
        ) : null}
        {operation.status === "error" ? (
          <Alert variant="error" title="Unable to save" description={operation.message} />
        ) : null}
      </SettingsSection>
      <SettingsSection title="Profiles" trailing={addButton}>
        <SelectField
          label="Default profile"
          value={group?.defaultWorkflowId ?? null}
          selectedDisplay={
            defaultOptions.find((option) => option.value === group?.defaultWorkflowId) ?? null
          }
          options={defaultOptions}
          onChange={changeDefault}
          placeholder="Choose a profile"
          emptyText="No profiles"
          disabled={pending}
        />
        <View style={settingsStyles.card}>
          {workflows.map((workflow, index) => {
            const availability = sharedChoiceState({
              profile: workflow,
              choices: {},
              entry: entries?.find((entry) => entry.provider === provider),
            });
            return (
              <AgentProfileRow
                key={workflow.id}
                profile={workflow}
                availabilityReason={availability.modelError ?? availability.thinkingError}
                entries={entries}
                isFirst={index === 0}
                isLast={index === workflows.length - 1}
                disabled={pending}
                onEdit={openWorkflow}
                onRemove={remove}
                onMoveUp={moveUp}
                onMoveDown={moveDown}
              />
            );
          })}
        </View>
      </SettingsSection>
      {editor ? (
        <AgentProfileEditModal
          serverId={editor.serverId}
          visible
          mode="edit"
          profile={editor.profile}
          sharedScope={sharedScope}
          onSave={save}
          onClose={close}
        />
      ) : null}
    </>
  );
}
