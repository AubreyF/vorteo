import type { FactorySnapshot } from "../shared/contracts.js";
import { FactorySetupSchema } from "../shared/operations.js";

export const fixtureSetup = FactorySetupSchema.parse({
  schemaVersion: 1,
  serverId: "fixture-host",
  projectId: "fixture-project",
  installationId: null,
  revision: null,
  observedAt: null,
  state: "unavailable",
  reason: "Example only. A native installation adapter has not been connected.",
  operations: { install: false, pause: false, resume: false, stop: false, disable: false },
});

// Synthetic examples are confined to the explicitly selected fixture source.
export const fixtureSnapshot: FactorySnapshot = {
  schemaVersion: 1,
  serverId: "fixture-host",
  projectId: "fixture-project",
  installationId: "fixture-installation",
  revision: null,
  observedAt: null,
  freshness: { state: "unknown", reason: "Example data. The runtime is not connected." },
  admission: { state: "held", reason: "Example: execution custody needs reconciliation." },
  account: { usagePoints: null, limitPoints: 10, observedAt: null, unit: "allowance-points" },
  coordinators: [
    { role: "factory", workspaceId: null, agentId: null, status: "recovery" },
    { role: "builds", workspaceId: null, agentId: null, status: "paused" },
  ],
  work: [
    {
      id: "fixture-review",
      title: "Preserve changes through takeover",
      phase: "executing",
      issueUrl: null,
      workspaceId: null,
      agentId: null,
      prUrl: null,
      ciUrl: null,
      blocker: "Independent review in progress. Example only.",
    },
    {
      id: "fixture-ci",
      title: "Improve issue qualification",
      phase: "awaiting_ci",
      issueUrl: null,
      workspaceId: null,
      agentId: null,
      prUrl: null,
      ciUrl: null,
      blocker: "Required checks pending. Example only.",
    },
  ],
  issues: [
    {
      id: "fixture-issue-1",
      number: 42,
      title: "Explain admission holds",
      url: "https://example.com/issues/42",
      qualification: "ready",
      reason: "Example qualification. Admission still requires fresh evidence.",
    },
    {
      id: "fixture-issue-2",
      number: 43,
      title: "Clarify release ownership",
      url: "https://example.com/issues/43",
      qualification: "held",
      reason: "An owner decision is required. Example only.",
    },
    {
      id: "fixture-issue-3",
      number: 44,
      title: "Retain recovery evidence",
      url: "https://example.com/issues/44",
      qualification: "pending",
      reason: "Qualification has not completed. Example only.",
    },
  ],
  builds: {
    active: null,
    pending: [{ id: "fixture-build", sourceRef: "example immutable source", status: "scheduled" }],
    latestRelease: null,
  },
  exceptions: [
    {
      id: "fixture-custody",
      title: "Execution custody unresolved",
      detail:
        "This example demonstrates a retained recovery hold. A recorded phase does not prove a worker is running.",
    },
    {
      id: "fixture-usage",
      title: "Account measurement unavailable",
      detail: "Usage is unknown. Missing allowance measurements are never displayed as zero.",
    },
  ],
  coverage: {
    work: { complete: true, gaps: [] },
    issues: {
      complete: false,
      gaps: ["A small example queue is shown; this is not the complete GitHub queue."],
    },
    builds: { complete: true, gaps: [] },
  },
  capabilities: {
    install: false,
    pause: false,
    resume: false,
    stop: false,
    takeover: false,
    disable: false,
    cleanup: false,
  },
};
