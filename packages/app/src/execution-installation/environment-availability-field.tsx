import { Text, View } from "react-native";
import { useCallback } from "react";
import type { InstallationEnvironment } from "@getpaseo/protocol/execution-installation";
import { Field } from "@/components/ui/form-field";
import { Switch } from "@/components/ui/switch";
import { settingsStyles } from "@/styles/settings";
import { installationEnvironmentKinds, readExecutionInstallation } from "./policy";

const ENVIRONMENT_LABELS: Record<InstallationEnvironment["kind"], string> = {
  host: "Host",
  container: "Dev container",
};

interface EnvironmentAvailabilityFieldProps {
  excludedEnvironments: readonly InstallationEnvironment["kind"][];
  onChange: (excluded: InstallationEnvironment["kind"][]) => void;
  disabled?: boolean;
}

export function EnvironmentAvailabilityField({
  excludedEnvironments,
  onChange,
  disabled = false,
}: EnvironmentAvailabilityFieldProps) {
  const kinds = installationEnvironmentKinds(readExecutionInstallation());
  // A Host-only installation has nothing to choose: everything runs on the Host.
  if (kinds.length < 2) return null;
  return (
    <Field label="Available in" testID="environment-availability-field">
      <View style={settingsStyles.card}>
        {kinds.map((kind) => (
          <EnvironmentAvailabilityRow
            key={kind}
            kind={kind}
            excludedEnvironments={excludedEnvironments}
            onChange={onChange}
            disabled={disabled}
          />
        ))}
      </View>
    </Field>
  );
}

function EnvironmentAvailabilityRow({
  kind,
  excludedEnvironments,
  onChange,
  disabled,
}: EnvironmentAvailabilityFieldProps & { kind: InstallationEnvironment["kind"] }) {
  const change = useCallback(
    (included: boolean) => {
      const remaining = excludedEnvironments.filter((excluded) => excluded !== kind);
      onChange(included ? remaining : [...remaining, kind]);
    },
    [excludedEnvironments, kind, onChange],
  );
  const label = ENVIRONMENT_LABELS[kind];
  return (
    <View style={settingsStyles.row}>
      <Text style={settingsStyles.rowTitle}>{label}</Text>
      <Switch
        value={!excludedEnvironments.includes(kind)}
        disabled={disabled}
        onValueChange={change}
        accessibilityLabel={`Available in ${label}`}
        testID={`environment-availability-${kind}`}
      />
    </View>
  );
}
