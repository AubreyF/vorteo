import { useCallback } from "react";
import { useFetchQuery } from "@/data/query";
import { Text, View } from "react-native";

import { StyleSheet } from "react-native-unistyles";
import type { SkillPolicy } from "@getpaseo/protocol/skill-library";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/form-field";
import { Switch } from "@/components/ui/switch";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient } from "@/runtime/host-runtime";

export function ProfileSkillPolicy({
  serverId,
  value,
  onChange,
}: {
  serverId: string;
  value: SkillPolicy | undefined;
  onChange: (value: SkillPolicy | undefined) => void;
}) {
  const supported = useHostFeature(serverId, "skillLibrary");
  const client = useHostRuntimeClient(serverId);
  const query = useFetchQuery({
    dataShape: "value",
    staleTimeMs: 30_000,
    queryKey: ["skill-library", serverId, ""],
    enabled: supported && client !== null,
    queryFn: async () => {
      if (!client) throw new Error("Environment disconnected");
      return client.readSkillLibrary({ kind: "inventory" });
    },
  });
  const inherit = useCallback(() => onChange(undefined), [onChange]);
  const select = useCallback(() => onChange({ mode: "selected", skills: [] }), [onChange]);
  const none = useCallback(() => onChange({ mode: "none" }), [onChange]);
  const policy = value ?? inheritedPolicy;
  const skills = query.data?.kind === "inventory" ? query.data.inventory.skills : [];
  const unique = [...new Map(skills.map((skill) => [skill.identity, skill])).values()];
  const toggle = useCallback(
    (identity: string, enabled: boolean) => {
      if (policy.mode === "none") return;
      if (policy.mode === "selected") {
        onChange({
          mode: "selected",
          skills: enabled
            ? [...policy.skills, identity]
            : policy.skills.filter((item) => item !== identity),
        });
      } else {
        onChange({
          ...policy,
          exclude: enabled
            ? policy.exclude.filter((item) => item !== identity)
            : [...policy.exclude, identity],
        });
      }
    },
    [policy, onChange],
  );
  if (!supported) return null;
  return (
    <Field label="Skills">
      <View style={styles.actions}>
        <Button variant={policy.mode === "inherit" ? "secondary" : "outline"} onPress={inherit}>
          Inherit defaults
        </Button>
        <Button variant={policy.mode === "selected" ? "secondary" : "outline"} onPress={select}>
          Selected only
        </Button>
        <Button variant={policy.mode === "none" ? "secondary" : "outline"} onPress={none}>
          No optional skills
        </Button>
      </View>
      <Text style={styles.hint}>
        Session filtering is supported for Claude and Codex. Other providers refuse restrictive
        policies. Skills do not control tool permissions. Existing tasks retain their launch
        selection.
      </Text>
      {query.error ? <Text style={styles.hint}>{query.error.message}</Text> : null}
      {policy.mode !== "none"
        ? unique.map((skill) => {
            const enabled =
              policy.mode === "selected"
                ? policy.skills.includes(skill.identity)
                : !policy.exclude.includes(skill.identity);
            return (
              <PolicyRow
                key={skill.identity}
                identity={skill.identity}
                label={`${skill.name} (${skill.owner}, ${skill.providers.join(", ")})`}
                enabled={enabled}
                toggle={toggle}
              />
            );
          })
        : null}
    </Field>
  );
}

const styles = StyleSheet.create((theme) => ({
  actions: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[2] },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: theme.spacing[2],
  },
  label: { flex: 1, color: theme.colors.foreground, fontSize: theme.fontSize.base },
  hint: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));

function PolicyRow({
  identity,
  label,
  enabled,
  toggle,
}: {
  identity: string;
  label: string;
  enabled: boolean;
  toggle: (identity: string, enabled: boolean) => void;
}) {
  const change = useCallback((next: boolean) => toggle(identity, next), [toggle, identity]);
  return (
    <View style={styles.row}>
      <Text style={styles.label}>{label}</Text>
      <Switch value={enabled} onValueChange={change} accessibilityLabel={`Enable ${label}`} />
    </View>
  );
}

const inheritedPolicy: SkillPolicy = { mode: "inherit", include: [], exclude: [] };
