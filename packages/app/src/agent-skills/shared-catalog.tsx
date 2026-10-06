import { Buffer } from "buffer";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Text, View } from "react-native";
import { useMutation } from "@tanstack/react-query";
import { StyleSheet } from "react-native-unistyles";
import type { InstallationSkill, SkillPackage } from "@getpaseo/protocol/skill-library";
import type { InstallationSettingsUpdate } from "@getpaseo/protocol/installation-settings";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { SettingsCard, SettingsRow, SettingsSection } from "@/components/settings";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useFetchQuery } from "@/data/query";
import { useInstallationSettings } from "@/execution-installation/settings";
import {
  prepareInstallationSkill,
  readInstallationSkillPackage,
} from "@/execution-installation/skills";
import { settingsStyles } from "@/styles/settings";
import { confirmDialog } from "@/utils/confirm-dialog";
import { openSharedSkillForm } from "./shared-form-model";

function useSharedSkillForm(skill?: InstallationSkill) {
  const { save } = useInstallationSettings();
  const [model] = useState(() =>
    openSharedSkillForm(
      { prepare: prepareInstallationSkill, read: readInstallationSkillPackage, save },
      skill,
    ),
  );
  useEffect(() => () => model.close(), [model]);
  const state = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  return { model, state };
}
function SharedSkillForm({ skill, onClose }: { skill?: InstallationSkill; onClose(): void }) {
  const { data } = useInstallationSettings();
  const { model, state } = useSharedSkillForm(skill);
  const compact = useIsCompactFormFactor();
  const size = compact ? "md" : "sm";
  const busy = state.phase === "preparing" || state.phase === "saving";
  const header = useMemo(
    () => ({ title: skill ? "Update shared skill" : "Add shared skill" }),
    [skill],
  );
  const repository = useCallback((value: string) => model.setSource("repository", value), [model]);
  const directory = useCallback((value: string) => model.setSource("directory", value), [model]);
  const revision = useCallback((value: string) => model.setSource("revision", value), [model]);
  const prepare = useCallback(() => {
    if (data) void model.prepare(data);
  }, [data, model]);
  const submit = useCallback(async () => {
    if (await model.submit()) onClose();
  }, [model, onClose]);
  return (
    <AdaptiveModalSheet visible header={header} onClose={onClose} testID="shared-skill-form">
      <View style={styles.content}>
        <Field label="Repository">
          <FormTextInput
            size={size}
            initialValue={state.source.repository}
            onChangeText={repository}
            editable={!busy && !skill}
            placeholder="owner/repository"
            accessibilityLabel="Repository"
          />
        </Field>
        <Field label="Skill directory">
          <FormTextInput
            size={size}
            initialValue={state.source.directory}
            onChangeText={directory}
            editable={!busy && !skill}
            placeholder="skills/example"
            accessibilityLabel="Skill directory"
          />
        </Field>
        <Field label="Commit SHA">
          <FormTextInput
            size={size}
            initialValue={state.source.revision}
            onChangeText={revision}
            editable={!busy}
            accessibilityLabel="Commit SHA"
          />
        </Field>
        {state.review ? (
          <PackageReview current={state.review.current} next={state.review.next} />
        ) : null}
        {state.error ? <Alert variant="error" description={state.error} /> : null}
        <View style={styles.actions}>
          <Button
            size={size}
            variant="outline"
            onPress={prepare}
            disabled={busy || !data}
            testID="shared-skill-prepare"
          >
            {state.phase === "preparing" ? "Preparing..." : "Review package"}
          </Button>
          <Button
            size={size}
            onPress={submit}
            disabled={state.phase !== "review"}
            testID="shared-skill-save"
          >
            {state.phase === "saving" ? "Saving..." : "Save shared skill"}
          </Button>
        </View>
      </View>
    </AdaptiveModalSheet>
  );
}

type PackageFile = SkillPackage["files"][number];
function FileReview({
  name,
  before,
  after,
}: {
  name: string;
  before?: PackageFile;
  after?: PackageFile;
}) {
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((value) => !value), []);
  let status = "Unchanged";
  if (!before) status = "Added";
  else if (!after) status = "Removed";
  else if (before.content !== after.content || before.executable !== after.executable)
    status = "Changed";
  return (
    <SettingsCard testID={`shared-skill-file-${name}`}>
      <SettingsRow label={name} hint={status}>
        <Button size="sm" variant="outline" onPress={toggle}>
          {open ? "Hide file" : "Inspect file"}
        </Button>
      </SettingsRow>
      {open ? (
        <View style={styles.content}>
          {before ? <FileContents label="Before" file={before} /> : null}
          {after ? <FileContents label="After" file={after} /> : null}
        </View>
      ) : null}
    </SettingsCard>
  );
}
function FileContents({ label, file }: { label: string; file: PackageFile }) {
  const bytes = Buffer.from(file.content, "base64");
  const decoded = bytes.toString("utf8");
  const text =
    !bytes.includes(0) && Buffer.from(decoded, "utf8").equals(bytes)
      ? decoded
      : `Binary content (base64):\n${file.content}`;
  return (
    <View style={styles.content}>
      <Text style={settingsStyles.rowHint}>
        {label}: {bytes.length} bytes, {file.executable ? "executable" : "not executable"}
      </Text>
      <Text selectable style={styles.code}>
        {text}
      </Text>
    </View>
  );
}
function PackageReview({ current, next }: { current: SkillPackage | null; next: SkillPackage }) {
  const names = [
    ...new Set([
      ...(current?.files.map((file) => file.path) ?? []),
      ...next.files.map((file) => file.path),
    ]),
  ].sort();
  return (
    <View style={styles.content} testID="shared-skill-package-review">
      <Text selectable style={settingsStyles.rowHint}>
        {next.sha256}
      </Text>
      {names.map((name) => (
        <FileReview
          key={name}
          name={name}
          before={current?.files.find((file) => file.path === name)}
          after={next.files.find((file) => file.path === name)}
        />
      ))}
    </View>
  );
}
function SkillDetails({ skill, onClose }: { skill: InstallationSkill; onClose(): void }) {
  const header = useMemo(() => ({ title: skill.name }), [skill.name]);
  const query = useFetchQuery({
    queryKey: ["shared-skill-package", skill.identity, skill.sha256],
    queryFn: () => readInstallationSkillPackage(skill),
    dataShape: "value",
    retry: false,
    staleTimeMs: 30_000,
  });
  const retry = useCallback(() => {
    void query.refetch();
  }, [query]);
  return (
    <AdaptiveModalSheet visible header={header} onClose={onClose}>
      <View style={styles.content}>
        {query.isPending ? <Text style={settingsStyles.rowHint}>Loading package...</Text> : null}
        {query.error ? (
          <>
            <Alert variant="error" description={query.error.message} />
            <Button variant="outline" onPress={retry}>
              Retry
            </Button>
          </>
        ) : null}
        {query.data ? <PackageReview current={query.data} next={query.data} /> : null}
      </View>
    </AdaptiveModalSheet>
  );
}
function SharedSkillRow({
  skill,
  pending,
  onEdit,
  onDetails,
  onRemove,
}: {
  skill: InstallationSkill;
  pending: boolean;
  onEdit(skill: InstallationSkill): void;
  onDetails(skill: InstallationSkill): void;
  onRemove(skill: InstallationSkill): void;
}) {
  const edit = useCallback(() => onEdit(skill), [onEdit, skill]);
  const details = useCallback(() => onDetails(skill), [onDetails, skill]);
  const remove = useCallback(() => onRemove(skill), [onRemove, skill]);
  return (
    <SettingsRow
      label={skill.name}
      hint={
        skill.source
          ? `${skill.source.repository}/${skill.source.directory}`
          : "Imported personal skill"
      }
      testID={`shared-skill-${skill.name}`}
    >
      <View style={styles.actions}>
        <Button size="sm" variant="outline" onPress={details}>
          Details
        </Button>
        {skill.source ? (
          <Button size="sm" variant="outline" onPress={edit} disabled={pending}>
            Update
          </Button>
        ) : null}
        <Button size="sm" variant="outline" onPress={remove} disabled={pending}>
          Remove
        </Button>
      </View>
    </SettingsRow>
  );
}
export function SharedSkillCatalog() {
  const { data, error, save, installation } = useInstallationSettings();
  const [form, setForm] = useState<{ skill?: InstallationSkill } | null>(null);
  const [details, setDetails] = useState<InstallationSkill | null>(null);
  const mutation = useMutation({
    mutationFn: (update: InstallationSettingsUpdate) => save(update),
  });
  const add = useCallback(() => setForm({}), []);
  const edit = useCallback((skill: InstallationSkill) => setForm({ skill }), []);
  const close = useCallback(() => setForm(null), []);
  const closeDetails = useCallback(() => setDetails(null), []);
  const remove = useCallback(
    async (skill: InstallationSkill) => {
      const settings = data?.settings;
      if (!data || !settings?.skillLibrary) return;
      if (
        !(await confirmDialog({
          title: `Remove ${skill.name}?`,
          message:
            "Remove this shared definition from new tasks in every environment. Installed files and existing task selections are retained.",
          confirmLabel: "Remove",
          destructive: true,
        }))
      )
        return;
      const exclusions = structuredClone(settings.resourceExclusions);
      for (const environment of Object.values(exclusions))
        if (environment.skillIdentities)
          environment.skillIdentities = environment.skillIdentities.filter(
            (id) => id !== skill.identity,
          );
      mutation.mutate({
        expectedRevision: data.revision,
        settings: {
          skillLibrary: settings.skillLibrary.filter((entry) => entry.identity !== skill.identity),
          resourceExclusions: exclusions,
        },
      });
    },
    [data, mutation],
  );
  const addButton = useMemo(
    () => (
      <Button
        variant="outline"
        size="sm"
        onPress={add}
        disabled={!data?.settings?.skillLibrary}
        testID="shared-skill-add"
      >
        Add skill
      </Button>
    ),
    [add, data],
  );
  return (
    <View testID="shared-skill-catalog">
      <SettingsSection title="Personal skills" trailing={addButton}>
        {error ? <Alert variant="error" description={error.message} /> : null}
        {mutation.error ? <Alert variant="error" description={mutation.error.message} /> : null}
        {!data?.settings?.skillLibrary ? (
          <Text style={settingsStyles.rowHint}>Reading shared skills...</Text>
        ) : (
          <SettingsCard>
            {data.settings.skillLibrary.map((skill) => (
              <SharedSkillRow
                key={skill.identity}
                skill={skill}
                pending={mutation.isPending}
                onEdit={edit}
                onDetails={setDetails}
                onRemove={remove}
              />
            ))}
            {data.settings.skillLibrary.length === 0 ? (
              <SettingsRow label="No personal skills" />
            ) : null}
          </SettingsCard>
        )}
        {installation?.environments.map((environment) => (
          <Text key={environment.serverId} style={settingsStyles.rowHint}>
            {environment.kind === "host" ? "Host" : "Dev container"}:{" "}
            {environmentStatus(data?.sources[environment.serverId])}
          </Text>
        ))}
      </SettingsSection>
      {form ? (
        <SharedSkillForm key={form.skill?.identity ?? "new"} skill={form.skill} onClose={close} />
      ) : null}
      {details ? (
        <SkillDetails key={details.identity} skill={details} onClose={closeDetails} />
      ) : null}
    </View>
  );
}
const styles = StyleSheet.create((theme) => ({
  content: { gap: theme.spacing[3] },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[2], alignItems: "center" },
  code: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontFamily: theme.fontFamily.mono,
  },
}));

function environmentStatus(
  source:
    | { pendingRevision: number | null; appliedRevision: number | null; error: string | null }
    | undefined,
) {
  if (source?.error) return "Needs attention";
  if (source?.pendingRevision != null) return "Changes pending";
  if (source?.appliedRevision != null) return "Synchronized";
  return "Waiting for environment";
}
