import { Text, View } from "react-native";
import { useCallback } from "react";
import type { InstallationEnvironment } from "@getpaseo/protocol/execution-installation";
import { Field } from "@/components/ui/form-field";
import { Switch } from "@/components/ui/switch";
import { settingsStyles } from "@/styles/settings";

const ENVIRONMENTS = [
  { kind: "host", label: "Host" },
  { kind: "container", label: "Dev container" },
] as const;

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
  return (
    <Field label="Available in" testID="environment-availability-field">
      <View style={settingsStyles.card}>
        {ENVIRONMENTS.map((environment) => (
          <EnvironmentAvailabilityRow
            key={environment.kind}
            environment={environment}
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
  environment,
  excludedEnvironments,
  onChange,
  disabled,
}: EnvironmentAvailabilityFieldProps & { environment: (typeof ENVIRONMENTS)[number] }) {
  const change = useCallback(
    (included: boolean) => {
      const remaining = excludedEnvironments.filter((kind) => kind !== environment.kind);
      onChange(included ? remaining : [...remaining, environment.kind]);
    },
    [excludedEnvironments, environment.kind, onChange],
  );
  return (
    <View style={settingsStyles.row}>
      <Text style={settingsStyles.rowTitle}>{environment.label}</Text>
      <Switch
        value={!excludedEnvironments.includes(environment.kind)}
        disabled={disabled}
        onValueChange={change}
        accessibilityLabel={`Available in ${environment.label}`}
        testID={`environment-availability-${environment.kind}`}
      />
    </View>
  );
}
