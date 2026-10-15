import React from "react";
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
  return installation ? (
    <InstallationConnectionCheckSection installation={installation} sessionFor={currentSession} />
  ) : null;
}
