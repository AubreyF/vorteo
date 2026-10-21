import type {
  SessionHostJob,
  SessionHostStatus,
} from "@getpaseo/protocol/session-host-maintenance";

export const sessionHostJobFixture: SessionHostJob = {
  target: "session-host",
  operation: "session-host-install",
  id: "00000000-0000-4000-8000-000000000011",
  revision: "00000000-0000-4000-8000-000000000012",
  requestedBy: "owner",
  reason: "Install the durable session host job.",
  createdAt: "2026-10-20T00:00:00.000Z",
  planSha256: "a".repeat(64),
  status: "pending",
  stage: "prepared",
  detail: "Waiting for owner approval.",
  plan: {
    version: 1,
    operation: "session-host-install",
    installationId: "00000000-0000-4000-8000-000000000001",
    label: "local.vorteo.00000000-0000-4000-8000-000000000001.session-host",
    serviceDomain: "gui/501",
    plistPath:
      "/Users/owner/Library/LaunchAgents/local.vorteo.00000000-0000-4000-8000-000000000001.session-host.plist",
    plistSha256: "b".repeat(64),
    node: "/Users/owner/.local/share/vorteo-host/runtime/node/bin/node",
    entrypoint:
      "/Users/owner/.local/share/vorteo-host/current/packages/server/dist/scripts/session-host-entrypoint.js",
    paseoHome: "/Users/owner/.local/share/vorteo-host/state/host",
    logPath: "/Users/owner/.local/share/vorteo-host/state/host/session-host/launchd.log",
    workingDirectory: "/Users/owner/.local/share/vorteo-host/current",
    environment: { HOME: "/Users/owner", PATH: "/usr/bin:/bin" },
  },
};

export const sessionHostStatusFixture: SessionHostStatus = {
  supported: true,
  installed: false,
  detail: {
    label: sessionHostJobFixture.plan.label,
    plist: "absent",
    loaded: false,
    pid: null,
    lastExitStatus: null,
    runs: null,
    host: null,
    settingEnabled: false,
    observedAt: "2026-10-20T00:00:05.000Z",
  },
};
