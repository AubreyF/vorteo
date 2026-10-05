import { useFetchQuery } from "@/data/query";
import { useCallback, useMemo, useReducer, useState } from "react";
import { Text, View } from "react-native";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { StyleSheet } from "react-native-unistyles";
import type {
  SkillInstallation,
  SkillInventory,
  SkillLibraryChange,
  SkillLibraryResult,
  SkillPreview,
} from "@getpaseo/protocol/skill-library";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { useHosts, useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useHostFeature } from "@/runtime/host-features";
import { settingsStyles } from "@/styles/settings";
import { useVortonMode } from "@/vorton-mode";
import { copyToClipboard } from "@/utils/copy-to-clipboard";

import { groupSkillLocations, findSkillLocations, type SkillGroup } from "./library-groups";

export function SkillLibraryButton() {
  const vortonMode = useVortonMode();
  const [open, setOpen] = useState(false);
  const show = useCallback(() => setOpen(true), []);
  const hide = useCallback(() => setOpen(false), []);
  if (!vortonMode) return null;
  return (
    <>
      <Button variant="outline" onPress={show}>
        Skill library
      </Button>
      {open ? <Library onClose={hide} /> : null}
    </>
  );
}

function Library({ onClose }: { onClose: () => void }) {
  return (
    <AdaptiveModalSheet visible onClose={onClose} header={libraryHeader}>
      <SkillLibraryContent />
    </AdaptiveModalSheet>
  );
}

export function SkillLibraryContent() {
  const hosts = useHosts();
  const [search, setSearch] = useState("");
  const [cwd, setCwd] = useState("");
  return (
    <View style={styles.content}>
      <Field label="Filter skills">
        <FormTextInput
          initialValue=""
          onChangeText={setSearch}
          placeholder="Name, provider, ownership, or environment"
        />
      </Field>
      <Field label="Project directory (optional)">
        <FormTextInput
          initialValue=""
          onChangeText={setCwd}
          placeholder="Absolute directory on the selected environments"
        />
      </Field>
      {hosts.length === 0 ? (
        <Text style={styles.muted}>Connect an environment to inspect and manage its skills.</Text>
      ) : null}
      {hosts.map((host) => (
        <EnvironmentLibrary
          key={host.serverId}
          serverId={host.serverId}
          label={host.label}
          search={search}
          cwd={cwd}
        />
      ))}
    </View>
  );
}

function EnvironmentLibrary({
  serverId,
  label,
  search,
  cwd,
}: {
  serverId: string;
  label: string;
  search: string;
  cwd: string;
}) {
  const client = useHostRuntimeClient(serverId);
  const online = useHostRuntimeIsConnected(serverId);
  const supported = useHostFeature(serverId, "skillLibrary");
  const queryClient = useQueryClient();
  const key = ["skill-library", serverId, cwd];
  const query = useFetchQuery({
    dataShape: "value",
    staleTimeMs: 30_000,
    queryKey: key,
    enabled: online && supported && client !== null,
    retry: false,
    queryFn: async () => {
      if (!client) throw new Error("Environment is disconnected");
      return client.readSkillLibrary({ kind: "inventory", ...(cwd ? { cwd } : {}) });
    },
  });
  const [detail, setDetail] = useState<SkillInstallation | null>(null);
  const [installing, setInstalling] = useState(false);
  const [auditing, setAuditing] = useState(false);
  const exportAudit = useMutation({
    mutationFn: async () => {
      if (query.data?.kind !== "inventory") throw new Error("Inventory is not loaded");
      await copyToClipboard(JSON.stringify({ serverId, label, ...query.data.inventory }, null, 2));
    },
  });
  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["skill-library", serverId] });
  }, [queryClient, serverId]);
  const refetch = useCallback(() => {
    void query.refetch();
  }, [query]);
  const install = useCallback(() => setInstalling(true), []);
  const history = useCallback(() => setAuditing(true), []);
  const closeInstall = useCallback(() => setInstalling(false), []);
  const closeHistory = useCallback(() => setAuditing(false), []);
  const closeDetail = useCallback(() => setDetail(null), []);
  const copy = useCallback(() => exportAudit.mutate(), [exportAudit]);
  if (!supported && online)
    return (
      <SettingsSection title={label}>
        <Text style={styles.muted}>Update this environment to use the skill library.</Text>
      </SettingsSection>
    );
  const inventory = query.data?.kind === "inventory" ? query.data.inventory : null;
  const groups = groupSkillLocations(inventory?.skills ?? emptySkills);
  const skills = groups.filter((group) =>
    group.locations.some((skill) =>
      `${label} ${skill.name} ${skill.description} ${skill.owner} ${skill.providers.join(" ")} ${skill.issues.join(" ")}`
        .toLowerCase()
        .includes(search.toLowerCase()),
    ),
  );
  return (
    <SettingsSection title={label}>
      <View style={styles.actions}>
        <Button variant="outline" disabled={!online || query.isFetching} onPress={refetch}>
          Refresh
        </Button>
        <Button variant="outline" disabled={!online} onPress={install}>
          Install
        </Button>
        <Button variant="outline" disabled={!online} onPress={history}>
          History
        </Button>
        <Button variant="outline" disabled={!inventory || exportAudit.isPending} onPress={copy}>
          Copy audit
        </Button>
      </View>
      <InventoryStatus
        online={online}
        pending={query.isPending}
        error={query.error}
        exportError={exportAudit.error}
        copied={exportAudit.isSuccess}
        inventory={inventory}
      />
      <View style={settingsStyles.card}>
        {skills.map((skill) => (
          <SkillRow key={skill.id} group={skill} onSelect={setDetail} />
        ))}
        {inventory && skills.length === 0 ? (
          <Text style={styles.muted}>No matching skills in the inspected locations.</Text>
        ) : null}
      </View>
      {inventory?.roots
        .filter((root) => root.status === "error")
        .map((root) => (
          <Text key={root.path} style={styles.error}>
            {root.path}: {root.error}
          </Text>
        ))}
      {detail ? (
        <SkillDetail
          key={detail.id}
          locations={findSkillLocations(groups, detail)}
          onSelectLocation={setDetail}
          serverId={serverId}
          skill={detail}
          cwd={cwd}
          alternatives={inventory?.skills ?? emptySkills}
          onClose={closeDetail}
          onChanged={refresh}
        />
      ) : null}
      {installing ? (
        <InstallSkill serverId={serverId} onClose={closeInstall} onChanged={refresh} />
      ) : null}
      {auditing ? (
        <SkillHistory serverId={serverId} onClose={closeHistory} onChanged={refresh} />
      ) : null}
    </SettingsSection>
  );
}

function useSkillChange(serverId: string, onChanged: () => void) {
  const client = useHostRuntimeClient(serverId);
  return useMutation({
    mutationFn: async (request: SkillLibraryChange) => {
      if (!client) throw new Error("Environment is disconnected");
      return client.changeSkillLibrary(request);
    },
    onSuccess: (result) => {
      if (result.kind === "applied") onChanged();
    },
  });
}

function ChangeResult({
  result,
  pending,
  error,
  apply,
}: {
  result: SkillLibraryResult | undefined;
  pending: boolean;
  error: Error | null;
  apply: (preview: SkillPreview) => void;
}) {
  const applyPreview = useCallback(() => {
    if (result?.kind === "preview") apply(result.preview);
  }, [apply, result]);
  return (
    <View style={styles.content}>
      {pending ? <Text style={styles.muted}>Working...</Text> : null}
      {error ? <Text style={styles.error}>{error.message}</Text> : null}
      {result?.kind === "applied" ? (
        <Text style={styles.muted}>Change applied. Recovery is available in History.</Text>
      ) : null}
      {result?.kind === "preview" ? (
        <>
          <Text style={styles.text}>
            {result.preview.action}: {result.preview.target}
          </Text>
          <Text selectable style={styles.muted}>
            Before: {result.preview.beforeHash ?? "absent"}
            {"\n"}After: {result.preview.afterHash ?? "absent"}
          </Text>
          {result.preview.changes.map((change) => (
            <View key={change.path}>
              <Text style={styles.text}>{change.path}</Text>
              <Text selectable style={styles.muted}>
                Previous content:{"\n"}
                {change.before ?? "New file"}
              </Text>
              <Text selectable style={styles.text}>
                Proposed content:{"\n"}
                {change.after ?? "Removed"}
              </Text>
            </View>
          ))}
          <Button disabled={pending} onPress={applyPreview}>
            Apply reviewed change
          </Button>
        </>
      ) : null}
    </View>
  );
}

function SkillDetail({
  locations,
  onSelectLocation,
  serverId,
  skill,
  cwd,
  alternatives,
  onClose,
  onChanged,
}: {
  locations: SkillInstallation[];
  onSelectLocation: (skill: SkillInstallation) => void;
  serverId: string;
  skill: SkillInstallation;
  cwd: string;
  alternatives: SkillInstallation[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const client = useHostRuntimeClient(serverId);
  const query = useFetchQuery({
    dataShape: "value",
    staleTimeMs: 30_000,
    queryKey: ["skill-detail", serverId, skill.id, cwd],
    retry: false,
    queryFn: async () => {
      if (!client) throw new Error("Environment is disconnected");
      return client.readSkillLibrary({ kind: "detail", id: skill.id, ...(cwd ? { cwd } : {}) });
    },
  });
  const change = useSkillChange(serverId, onChanged);
  const apply = useCallback(
    (preview: SkillPreview) => change.mutate({ kind: "apply", previewId: preview.id }),
    [change],
  );
  const header = useMemo(() => ({ title: skill.name }), [skill.name]);
  const remove = useCallback(
    () => change.mutate({ kind: "preview_remove", id: skill.id }),
    [change, skill.id],
  );
  const linkClaude = useCallback(
    () => change.mutate({ kind: "preview_link", id: skill.id, provider: "claude" }),
    [change, skill.id],
  );
  const linkCodex = useCallback(
    () => change.mutate({ kind: "preview_link", id: skill.id, provider: "codex" }),
    [change, skill.id],
  );
  return (
    <AdaptiveModalSheet visible header={header} onClose={onClose}>
      <View style={styles.content}>
        {locations.length > 1 ? (
          <SettingsSection title="Discovery paths">
            <Text style={styles.muted}>
              One package shared by these providers. Actions apply to the selected path.
            </Text>
            {locations.map((location) => (
              <SkillLocationRow
                key={location.id}
                skill={location}
                selected={location.id === skill.id}
                pending={change.isPending}
                onSelect={onSelectLocation}
              />
            ))}
          </SettingsSection>
        ) : null}
        <Text style={styles.text}>{skill.description}</Text>
        <Text selectable style={styles.muted}>
          {skill.path}
          {"\n"}
          {skill.resolvedPath}
          {"\n"}
          {skill.identity}
          {"\n"}
          {skill.sha256}
        </Text>
        <Text style={styles.muted}>
          Owner: {skill.owner}. Provider discovery, activation, invocation, dependencies, and
          credential readiness are not verified by this scan.
        </Text>
        {skill.source ? (
          <Text selectable style={styles.text}>
            {skill.source.repository} @ {skill.source.revision}
            {"\n"}
            {skill.source.directory}
          </Text>
        ) : (
          <Text style={styles.muted}>Source provenance unknown.</Text>
        )}
        {skill.issues.map((issue) => (
          <Text key={issue} style={styles.error}>
            {issue}
          </Text>
        ))}
        {query.error ? <Text style={styles.error}>{query.error.message}</Text> : null}
        {query.data?.kind === "detail" ? (
          <Text selectable style={styles.text}>
            {query.data.instructions}
          </Text>
        ) : null}
        {skill.files.map((file) => (
          <Text key={file.path} selectable style={styles.muted}>
            {file.path} · {file.bytes} bytes · {file.sha256}
          </Text>
        ))}
        {skill.owner === "personal" ? (
          <View style={styles.actions}>
            <Button variant="outline" disabled={change.isPending} onPress={linkClaude}>
              Preview Claude discovery link
            </Button>
            <Button variant="outline" disabled={change.isPending} onPress={linkCodex}>
              Preview Codex discovery link
            </Button>
          </View>
        ) : null}
        {skill.managed ? (
          <Button variant="outline" disabled={change.isPending} onPress={remove}>
            Preview removal
          </Button>
        ) : null}
        {alternatives
          .filter(
            (other) =>
              other.owner === "personal" &&
              other.id !== skill.id &&
              other.sha256 === skill.sha256 &&
              other.path === other.resolvedPath,
          )
          .map((other) => (
            <ConsolidateButton
              key={other.id}
              skill={skill}
              other={other}
              pending={change.isPending}
              mutate={change.mutate}
            />
          ))}
        <ChangeResult
          result={change.data}
          pending={change.isPending}
          error={change.error}
          apply={apply}
        />
      </View>
    </AdaptiveModalSheet>
  );
}

interface InstallDraft {
  repository: string;
  revision: string;
  directory: string;
}
function InstallSkill({
  serverId,
  onClose,
  onChanged,
}: {
  serverId: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [draft, update] = useReducer(
    (state: InstallDraft, patch: Partial<InstallDraft>) => ({ ...state, ...patch }),
    { repository: "", revision: "", directory: "" },
  );
  const change = useSkillChange(serverId, onChanged);
  const apply = useCallback(
    (preview: SkillPreview) => change.mutate({ kind: "apply", previewId: preview.id }),
    [change],
  );
  const repositoryChanged = useCallback(
    (repository: string) => {
      update({ repository });
      change.reset();
    },
    [change],
  );
  const revisionChanged = useCallback(
    (revision: string) => {
      update({ revision });
      change.reset();
    },
    [change],
  );
  const directoryChanged = useCallback(
    (directory: string) => {
      update({ directory });
      change.reset();
    },
    [change],
  );
  const inspect = useCallback(
    () => change.mutate({ kind: "preview_install", source: draft }),
    [change, draft],
  );
  return (
    <AdaptiveModalSheet visible header={installHeader} onClose={onClose}>
      <View style={styles.content}>
        <Text style={styles.muted}>
          Install a canonical personal package for this environment. After installation, use Details
          to add provider discovery links. Existing copies require a reviewed consolidation.
        </Text>
        <Field label="GitHub repository">
          <FormTextInput
            initialValue=""
            placeholder="owner/repository"
            onChangeText={repositoryChanged}
          />
        </Field>
        <Field label="Commit">
          <FormTextInput
            initialValue=""
            placeholder="Full 40 character commit SHA"
            onChangeText={revisionChanged}
          />
        </Field>
        <Field label="Skill directory">
          <FormTextInput
            initialValue=""
            placeholder="skills/example"
            onChangeText={directoryChanged}
          />
        </Field>
        <Button
          variant="outline"
          disabled={change.isPending || !/^[a-f0-9]{40}$/.test(draft.revision)}
          onPress={inspect}
        >
          Inspect installation
        </Button>
        <ChangeResult
          result={change.data}
          pending={change.isPending}
          error={change.error}
          apply={apply}
        />
      </View>
    </AdaptiveModalSheet>
  );
}

function SkillHistory({
  serverId,
  onClose,
  onChanged,
}: {
  serverId: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const client = useHostRuntimeClient(serverId);
  const query = useFetchQuery({
    dataShape: "value",
    staleTimeMs: 30_000,
    queryKey: ["skill-history", serverId],
    queryFn: async () => {
      if (!client) throw new Error("Environment is disconnected");
      return client.readSkillLibrary({ kind: "audit" });
    },
  });
  const change = useSkillChange(serverId, onChanged);
  const apply = useCallback(
    (preview: SkillPreview) => change.mutate({ kind: "apply", previewId: preview.id }),
    [change],
  );
  return (
    <AdaptiveModalSheet visible header={historyHeader} onClose={onClose}>
      <View style={styles.content}>
        {query.error ? <Text style={styles.error}>{query.error.message}</Text> : null}
        {query.data?.kind === "audit"
          ? query.data.entries.map((entry) => (
              <View key={entry.id}>
                <Text selectable style={styles.text}>
                  {entry.at} · {entry.action}
                  {"\n"}
                  {entry.target}
                </Text>
                {entry.beforeHash ? (
                  <RestoreButton id={entry.id} pending={change.isPending} mutate={change.mutate} />
                ) : null}
              </View>
            ))
          : null}
        <ChangeResult
          result={change.data}
          pending={change.isPending}
          error={change.error}
          apply={apply}
        />
      </View>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  content: { gap: theme.spacing[4], padding: theme.spacing[4] },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[2] },
  text: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  muted: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.base },
}));

const libraryHeader = { title: "Skill library" };
const installHeader = { title: "Install a skill" };
const historyHeader = { title: "Skill history" };
const emptySkills: SkillInstallation[] = [];
function SkillRow({
  group,
  onSelect,
}: {
  group: SkillGroup;
  onSelect: (skill: SkillInstallation) => void;
}) {
  const skill = group.primary;
  const select = useCallback(() => onSelect(skill), [onSelect, skill]);
  return (
    <View style={settingsStyles.row}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>{skill.name}</Text>
        <Text style={settingsStyles.rowHint}>
          {skill.owner}, {group.providers.join(", ")},{" "}
          {skill.issues.length ? "Needs review" : "Inspected"}
        </Text>
      </View>
      <Button variant="outline" onPress={select}>
        Details
      </Button>
    </View>
  );
}
function SkillLocationRow({
  skill,
  selected,
  pending,
  onSelect,
}: {
  skill: SkillInstallation;
  selected: boolean;
  pending: boolean;
  onSelect: (skill: SkillInstallation) => void;
}) {
  const select = useCallback(() => onSelect(skill), [onSelect, skill]);
  return (
    <View style={settingsStyles.row}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>{skill.providers.join(", ")}</Text>
        <Text selectable style={settingsStyles.rowHint}>
          {skill.path}
        </Text>
      </View>
      <Button
        variant="outline"
        disabled={selected || pending}
        onPress={select}
        accessibilityLabel={`Inspect ${skill.providers.join(", ")} path`}
      >
        {selected ? "Selected" : "Inspect"}
      </Button>
    </View>
  );
}
function ConsolidateButton({
  skill,
  other,
  pending,
  mutate,
}: {
  skill: SkillInstallation;
  other: SkillInstallation;
  pending: boolean;
  mutate: (request: SkillLibraryChange) => void;
}) {
  const preview = useCallback(
    () => mutate({ kind: "preview_consolidate", id: skill.id, canonicalId: other.id }),
    [mutate, skill.id, other.id],
  );
  return (
    <Button variant="outline" disabled={pending} onPress={preview}>
      Preview link to {other.path}
    </Button>
  );
}
function RestoreButton({
  id,
  pending,
  mutate,
}: {
  id: string;
  pending: boolean;
  mutate: (request: SkillLibraryChange) => void;
}) {
  const preview = useCallback(() => mutate({ kind: "preview_restore", auditId: id }), [mutate, id]);
  return (
    <Button variant="outline" disabled={pending} onPress={preview}>
      Preview restoration
    </Button>
  );
}

function InventoryStatus({
  online,
  pending,
  error,
  exportError,
  copied,
  inventory,
}: {
  online: boolean;
  pending: boolean;
  error: Error | null;
  exportError: Error | null;
  copied: boolean;
  inventory: SkillInventory | null;
}) {
  return (
    <View>
      {!online ? (
        <Text style={styles.muted}>Offline. Any displayed inventory is the last observation.</Text>
      ) : null}
      {online && pending ? <Text style={styles.muted}>Loading inventory...</Text> : null}
      {error ? <Text style={styles.error}>{error.message}</Text> : null}
      {exportError ? <Text style={styles.error}>{exportError.message}</Text> : null}
      {copied ? <Text style={styles.muted}>Audit copied.</Text> : null}
      {inventory ? (
        <Text style={styles.muted}>
          Observed {inventory.observedAt}. Filesystem inventory; provider activation is not
          verified.
        </Text>
      ) : null}
    </View>
  );
}
