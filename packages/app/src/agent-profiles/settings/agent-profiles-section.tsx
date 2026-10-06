import { useCallback, useMemo, useState, type ReactElement } from "react";
import { Alert, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { AgentProfile } from "@getpaseo/protocol/messages";
import { SelectField } from "@/components/ui/select-field";
import { Button } from "@/components/ui/button";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { settingsStyles } from "@/styles/settings";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { confirmDialog } from "@/utils/confirm-dialog";
import { useAgentProfiles } from "../internal/use-agent-profiles";
import { generateAgentProfileId } from "../internal/profile-id";
import type { AgentProfileValue } from "../internal/profile-form-model";
import { AgentProfileEditModal } from "./agent-profile-edit-modal";
import { AgentProfileRow } from "./agent-profile-row";
import { defaultProfile } from "../internal/default-profile";
import { SharedProviderSection } from "./shared-provider-section";

const ThemedPlus = withUnistyles(Plus);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const addIcon = <ThemedPlus size={ICON_SIZE.sm} uniProps={mutedColorMapping} />;

interface EditTarget {
  mode: "create" | "edit";
  profile?: AgentProfile;
}

export function AgentProfilesSection({
  serverId,
  provider,
}: {
  serverId: string;
  provider?: string;
}): ReactElement {
  const { supportsSharedPreferences } = useAgentProfiles(serverId);
  if (supportsSharedPreferences && provider) {
    return <SharedProviderSection serverId={serverId} provider={provider} />;
  }
  return <LegacyAgentProfilesSection serverId={serverId} provider={provider} />;
}

function LegacyAgentProfilesSection({
  serverId,
  provider,
}: {
  serverId: string;
  provider?: string;
}): ReactElement {
  const { t } = useTranslation();
  const isConnected = useHostRuntimeIsConnected(serverId);
  const { legacyProfiles: profiles, isSupported, saveProfiles } = useAgentProfiles(serverId);
  const { entries } = useProvidersSnapshot(serverId, { cwd: null });
  const visibleProfiles = useMemo(
    () => (profiles ?? []).filter((profile) => !provider || profile.provider === provider),
    [profiles, provider],
  );
  const seed = useMemo(() => (provider ? { provider } : undefined), [provider]);
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null);

  const handleAddOpen = useCallback(() => setEditTarget({ mode: "create" }), []);
  const handleEditClose = useCallback(() => setEditTarget(null), []);

  const handleEditOpen = useCallback(
    (id: string) => {
      const profile = profiles?.find((entry) => entry.id === id);
      if (!profile) {
        return;
      }
      setEditTarget({ mode: "edit", profile });
    },
    [profiles],
  );

  const handleSave = useCallback(
    async (value: AgentProfileValue) => {
      const current = profiles ?? [];
      const editing = editTarget?.mode === "edit" ? editTarget.profile : undefined;
      if (
        editing &&
        JSON.stringify(current.find((entry) => entry.id === editing.id)) !== JSON.stringify(editing)
      ) {
        throw new Error(
          "This preset changed while you were editing. Close and reopen it before saving.",
        );
      }
      // The edited profile is replaced, not merged: `value` omits the fields the
      // user cleared, so spreading it over the stored record would silently keep
      // the old model, mode, thinking option or notes.
      const next: AgentProfile[] = editing
        ? current.map((entry) =>
            entry.id === editing.id
              ? { id: entry.id, isDefault: entry.isDefault, ...value }
              : entry,
          )
        : [...current, { id: generateAgentProfileId(), ...value }];
      await saveProfiles(next);
    },
    [editTarget, profiles, saveProfiles],
  );

  const reorder = useCallback(
    async (id: string, offset: -1 | 1) => {
      if (!profiles) {
        return;
      }
      const index = visibleProfiles.findIndex((entry) => entry.id === id);
      const target = index + offset;
      if (index < 0 || target < 0 || target >= visibleProfiles.length) {
        return;
      }
      const next = [...profiles];
      const sourceIndex = profiles.findIndex((entry) => entry.id === id);
      const targetIndex = profiles.findIndex((entry) => entry.id === visibleProfiles[target].id);
      [next[sourceIndex], next[targetIndex]] = [next[targetIndex], next[sourceIndex]];
      try {
        await saveProfiles(next);
      } catch (error) {
        Alert.alert(
          t("common.errors.unableToSave"),
          error instanceof Error ? error.message : String(error),
        );
      }
    },
    [profiles, visibleProfiles, saveProfiles, t],
  );

  const handleMoveUp = useCallback((id: string) => void reorder(id, -1), [reorder]);
  const handleMoveDown = useCallback((id: string) => void reorder(id, 1), [reorder]);

  const handleRemove = useCallback(
    (id: string) => {
      const profile = profiles?.find((entry) => entry.id === id);
      if (!profile) {
        return;
      }
      void confirmDialog({
        title: t("settings.host.agentProfiles.removeConfirmTitle"),
        message: t("settings.host.agentProfiles.removeConfirmMessage", { name: profile.name }),
        confirmLabel: t("settings.host.agentProfiles.remove"),
        cancelLabel: t("common.actions.cancel"),
        destructive: true,
      }).then(async (confirmed) => {
        if (!confirmed || !profiles) {
          return;
        }
        try {
          await saveProfiles(profiles.filter((entry) => entry.id !== id));
        } catch (error) {
          Alert.alert(
            t("common.errors.unableToSave"),
            error instanceof Error ? error.message : String(error),
          );
        }
        return;
      });
    },
    [profiles, saveProfiles, t],
  );

  const defaultOptions = useMemo(
    () =>
      (profiles ?? []).map((profile) => ({
        id: profile.id,
        value: profile.id,
        label: profile.name,
      })),
    [profiles],
  );
  const defaultId = defaultProfile(profiles)?.id ?? "";
  const [savingDefault, setSavingDefault] = useState(false);
  const selectDefault = useCallback(
    async (id: string | null) => {
      if (!profiles?.some((profile) => profile.id === id)) return;
      setSavingDefault(true);
      try {
        await saveProfiles(
          profiles.map((profile) => ({ ...profile, isDefault: profile.id === id })),
        );
      } catch (error) {
        Alert.alert(
          "Unable to save default configuration",
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        setSavingDefault(false);
      }
    },
    [profiles, saveProfiles],
  );

  const addButton = useMemo(
    () => (
      <Button
        variant="ghost"
        size="sm"
        leftIcon={addIcon}
        onPress={handleAddOpen}
        disabled={!profiles}
        accessibilityLabel={t("settings.host.agentProfiles.addProfileTitle")}
        testID="agent-profiles-add-button"
      />
    ),
    [handleAddOpen, profiles, t],
  );

  if (!isConnected || !isSupported) {
    return (
      <SettingsSection
        title={t("settings.host.agentProfiles.sectionTitle")}
        testID="agent-profiles-section"
      >
        <View style={settingsStyles.card} testID="agent-profiles-unavailable">
          <View style={styles.emptyCard}>
            <Text style={styles.emptyText}>
              {isConnected
                ? t("settings.host.agentProfiles.unsupported")
                : t("settings.host.agentProfiles.unavailable")}
            </Text>
          </View>
        </View>
      </SettingsSection>
    );
  }

  return (
    <>
      <SettingsSection
        title={t("settings.host.agentProfiles.sectionTitle")}
        trailing={addButton}
        testID="agent-profiles-section"
      >
        <>
          <SelectField
            label="Default configuration"
            value={defaultId}
            selectedDisplay={defaultOptions.find((option) => option.value === defaultId) ?? null}
            options={defaultOptions}
            onChange={selectDefault}
            disabled={!profiles?.length || savingDefault}
            placeholder="No configurations available"
            emptyText="No configurations available"
          />
          <Text style={styles.emptyText}>
            Used for new Vorteo chats on this host. Existing chats and their accounts stay
            unchanged. The first available configuration is selected when no default is set.
          </Text>
        </>
        <View style={settingsStyles.card} testID="agent-profiles-card">
          {visibleProfiles.length > 0 ? (
            visibleProfiles.map((profile, index) => (
              <AgentProfileRow
                key={profile.id}
                profile={profile}
                entries={entries}
                isFirst={index === 0}
                isLast={index === visibleProfiles.length - 1}
                onEdit={handleEditOpen}
                onRemove={handleRemove}
                onMoveUp={handleMoveUp}
                onMoveDown={handleMoveDown}
              />
            ))
          ) : (
            <View style={styles.emptyCard}>
              <Text style={styles.emptyText} testID="agent-profiles-empty">
                {t("settings.host.agentProfiles.emptyState")}
              </Text>
              <Button size="sm" leftIcon={addIcon} onPress={handleAddOpen} disabled={!profiles}>
                {t("settings.host.agentProfiles.newProfile")}
              </Button>
            </View>
          )}
        </View>
      </SettingsSection>

      <AgentProfileEditModal
        serverId={serverId}
        seed={seed}
        visible={editTarget !== null}
        mode={editTarget?.mode ?? "create"}
        {...(editTarget?.profile ? { profile: editTarget.profile } : {})}
        onClose={handleEditClose}
        onSave={handleSave}
      />
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  emptyCard: {
    paddingVertical: theme.spacing[6],
    paddingHorizontal: theme.spacing[4],
    alignItems: "center",
    gap: theme.spacing[3],
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
}));
