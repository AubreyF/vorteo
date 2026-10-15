import React from "react";
import Constants from "expo-constants";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { readExecutionInstallation } from "./policy";
import { connectionEndpointLabel, type ConnectionSession } from "./connection-check";
import { InstallationConnectionCheckSection } from "./connection-check-section";

function currentSession(serverId: string): ConnectionSession {
  const state = getHostRuntimeStore().getSnapshot(serverId);
  return {
    state: state?.connectionStatus ?? "uninitialized",
    authentication: state?.authFailureReason ?? null,
    endpoint: connectionEndpointLabel(state?.activeConnection?.endpoint),
  };
}

export function InstallationConnectionCheck() {
  const installation = readExecutionInstallation();
  const source: unknown = Constants.expoConfig?.extra?.vortonBuildCommit;
  const build = typeof source === "string" && /^[a-f0-9]{40}$/.test(source) ? source : null;
  return installation ? (
    <InstallationConnectionCheckSection
      installation={installation}
      sessionFor={currentSession}
      build={build}
    />
  ) : null;
}
