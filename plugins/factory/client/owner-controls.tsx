import { useCallback, useEffect, useRef } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useRpc } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsRow,
  SettingsSection,
} from "@getpaseo/plugin/client/ui";
import { factoryControls, factoryControl, type FactoryControlInput } from "../shared/operations.js";
import { createFactoryOperationId } from "./installation.js";
import { dispatchFactoryControl } from "./owner-control-dispatch.js";

export function FactoryOwnerControls({ hostId, projectId }: { hostId: string; projectId: string }) {
  const read = useRpc(factoryControls);
  const execute = useRpc(factoryControl);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const query = useQuery({
    queryKey: ["factory.controls", hostId, projectId],
    queryFn: async () => {
      const state = await read({ projectId });
      if (state.serverId !== hostId || state.projectId !== projectId)
        throw new Error("Factory controls do not match the selected host and project.");
      return state;
    },
    retry: false,
    refetchInterval: 15000,
  });
  const action = useMutation({
    mutationFn: (command: FactoryControlInput["action"]) =>
      dispatchFactoryControl({
        hostId,
        projectId,
        observed: query.data,
        action: command,
        operationId: createFactoryOperationId(),
        read,
        execute,
        assertCurrent() {
          if (!mounted.current) throw new Error("Factory control view changed before dispatch.");
        },
      }),
    retry: false,
    onSettled: () => {
      if (mounted.current) void query.refetch();
    },
  });
  const { mutate } = action;
  const { refetch } = query;
  const pause = useCallback(() => mutate("pause"), [mutate]);
  const resume = useCallback(() => mutate("resume"), [mutate]);
  const stop = useCallback(() => mutate("stop"), [mutate]);
  const refresh = useCallback(() => {
    void refetch();
  }, [refetch]);
  const state = query.data;
  const blockingAction = action.isPending && action.variables !== "resume";
  let status = "Reading Factory controls...";
  if (query.isError) status = "Factory controls unavailable";
  else if (state) status = `Factory ${state.state}`;
  let message = state?.reason ?? undefined;
  if (action.isPending) message = "Applying Factory control. Do not repeat this request.";
  else if (action.isSuccess) message = "Factory control applied. Current state is shown below.";
  const error = (action.error ?? query.error)?.message;
  return (
    <SettingsSection title="Factory controls">
      <SettingsCard>
        <SettingsRow label={status} hint={message} error={error} />
        <SettingsAction
          label="Pause intake"
          hint="Stop admitting new work. Admitted work can finish."
          actionLabel="Pause"
          disabled={query.isError || blockingAction || !state?.operations.pause}
          onPress={pause}
        />
        <SettingsAction
          label="Resume Factory"
          hint="Continue through the current account and recovery checks."
          actionLabel="Resume"
          disabled={query.isError || action.isPending || !state?.operations.resume}
          onPress={resume}
        />
        <SettingsAction
          label="Stop Factory"
          hint="Block new work and freeze active work, retaining recovery state."
          actionLabel="Stop"
          disabled={query.isError || blockingAction || !state?.operations.stop}
          onPress={stop}
        />
        <SettingsAction
          label="Read current state"
          actionLabel="Refresh"
          disabled={query.isFetching || action.isPending}
          onPress={refresh}
        />
      </SettingsCard>
    </SettingsSection>
  );
}
