import { useMemo } from "react";
import { SelectField } from "@/components/ui/select-field";
import { readExecutionInstallation } from "@/execution-installation/policy";

export function NewWorkspaceEnvironment({
  hosts,
  serverId,
  onChange,
  disabled,
}: {
  hosts: { serverId: string; label: string }[];
  serverId: string;
  onChange: (serverId: string) => void;
  disabled: boolean;
}) {
  const installation = readExecutionInstallation();
  const options = useMemo(
    () =>
      hosts.map((host) => {
        const environment = installation?.environments.find(
          (item) => item.serverId === host.serverId,
        );
        let label = host.label;
        if (environment) label = environment.kind === "host" ? "Host" : "Dev container";
        return { id: host.serverId, value: host.serverId, label };
      }),
    [hosts, installation],
  );
  const display = useMemo(
    () => ({
      label: options.find((option) => option.value === serverId)?.label ?? "Choose environment",
    }),
    [options, serverId],
  );
  return (
    <SelectField
      selectedDisplay={display}
      label="Environment"
      value={serverId}
      options={options}
      onChange={onChange}
      disabled={disabled}
      placeholder="Choose environment"
      emptyText="No environments"
      testID="new-workspace-environment"
    />
  );
}
