import { helperReviewFixture } from "./helper-review.fixture";
import { expect, test } from "vitest";
import { OwnerAccessExpired } from "./client";
import {
  InstallationPanelModel,
  restartExplanation,
  restartRequestSummary,
  restartBannerTitle,
  restartBlockingReason,
  restartActionDisabledReason,
} from "./panel-model";
import type { RestartJob } from "@getpaseo/protocol/execution-installation";

test("saved connections skip setup on reload without unlocking owner controls", async () => {
  let queries = 0;
  const model = new InstallationPanelModel(
    {
      restartSummary: async () => null,
      restoreSession: async () => false,
      lock: async () => {},
      passwordFile: null,
      sessionsSupported: false,
      profileSharingStatus: async () => null,
      resolveProfileConflict: async () => {},
      unlock: async () => {},
      listHelpers: async () => [],
      decideHelper: async () => {
        throw new Error("Unexpected helper decision");
      },
      listRestarts: async () => {
        queries++;
        return [];
      },
      decide: async () => {
        throw new Error("Unexpected approval");
      },
    },
    { connectionsRegistered: true },
  );
  expect(model.getState()).toMatchObject({ visible: false, unlocked: false, password: "" });
  await model.refresh();
  expect(queries).toBe(0);
  model.open();
  expect(model.getState()).toMatchObject({ visible: true, unlocked: false });
});

test("opening or observing a request never approves it", async () => {
  let approvals = 0;
  const job: RestartJob = {
    id: "request",
    revision: "revision",
    target: "host",
    requestedBy: "container-agent",
    reason: "Update",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    status: "pending",
    detail: "Approval required",
  };
  const model = new InstallationPanelModel({
    restartSummary: async () => null,
    restoreSession: async () => false,
    lock: async () => {},
    passwordFile: null,
    sessionsSupported: false,
    profileSharingStatus: async () => null,
    resolveProfileConflict: async () => {},
    unlock: async () => {},
    listHelpers: async () => [],
    decideHelper: async () => {
      throw new Error("Unexpected helper decision");
    },
    listRestarts: async () => [job],
    decide: async () => {
      approvals++;
    },
  });
  model.setPassword("owner-password");
  await model.unlock();
  expect(model.getState().password).toBe("");
  expect(model.getState().visible).toBe(false);
  model.close();
  await model.refresh();
  expect(model.getState().visible).toBe(false);
  model.open();
  expect(approvals).toBe(0);
  await model.decide(job, "approve");
  expect(approvals).toBe(1);
});

test("failed unlock remains visible and can be retried without granting authority", async () => {
  let attempts = 0;
  const model = new InstallationPanelModel({
    restartSummary: async () => null,
    restoreSession: async () => false,
    lock: async () => {},
    passwordFile: null,
    sessionsSupported: false,
    profileSharingStatus: async () => null,
    resolveProfileConflict: async () => {},
    unlock: async () => {
      if (++attempts === 1) throw new Error("Incorrect installation password");
    },
    listHelpers: async () => [],
    decideHelper: async () => {
      throw new Error("Unexpected helper decision");
    },
    listRestarts: async () => [],
    decide: async () => {
      throw new Error("Unexpected approval");
    },
  });
  model.setPassword("incorrect");
  await model.unlock();
  expect(model.getState()).toMatchObject({
    unlocked: false,
    busy: false,
    visible: true,
    error: "Incorrect installation password",
  });
  model.setPassword("correct");
  await model.unlock();
  expect(model.getState()).toMatchObject({
    unlocked: true,
    busy: false,
    visible: false,
    error: null,
    password: "",
  });
});

test("restoring a browser session retains owner access and locking never approves requests", async () => {
  let approvals = 0;
  let locks = 0;
  const model = new InstallationPanelModel({
    restartSummary: async () => null,
    restoreSession: async () => true,
    passwordFile: "/installation/owner-password",
    sessionsSupported: true,
    lock: async () => {
      locks++;
    },
    unlock: async () => {},
    profileSharingStatus: async () => null,
    resolveProfileConflict: async () => {},
    listHelpers: async () => [],
    decideHelper: async () => {
      throw new Error("Unexpected helper decision");
    },
    listRestarts: async () => [],
    decide: async () => {
      approvals++;
    },
  });
  await model.initialize();
  expect(model.getState()).toMatchObject({
    unlocked: true,
    visible: false,
    password: "",
    passwordFile: "/installation/owner-password",
    sessionsSupported: true,
  });
  await model.lock();
  expect(model.getState()).toMatchObject({ unlocked: false, password: "", jobs: [] });
  expect(locks).toBe(1);
  expect(approvals).toBe(0);
});

test("the approval queue retains old requests, excludes completed requests and keeps only the newest per target", async () => {
  const base: RestartJob = {
    id: "host-old",
    revision: "revision",
    target: "host",
    requestedBy: "host-agent",
    reason: "Prepared",
    createdAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
    status: "pending",
    detail: "Approval required",
  };
  let jobs: RestartJob[] = [
    base,
    { ...base, id: "expired", target: "container-daemon", expiresAt: "2020-01-01T00:00:00.000Z" },
    { ...base, id: "completed", status: "succeeded" },
    { ...base, id: "host-new", requestedBy: "owner" },
    { ...base, id: "container", target: "container-daemon" },
  ];
  const model = new InstallationPanelModel({
    restartSummary: async () => null,
    restoreSession: async () => true,
    lock: async () => {},
    passwordFile: null,
    sessionsSupported: true,
    profileSharingStatus: async () => null,
    resolveProfileConflict: async () => {},
    unlock: async () => {},
    listHelpers: async () => [],
    decideHelper: async () => {
      throw new Error("Unexpected helper decision");
    },
    listRestarts: async () => jobs,
    decide: async () => {},
  });
  await model.initialize();
  expect(model.getState().pendingJobs.map((job) => job.id)).toEqual(["container", "host-new"]);
  expect(model.getState().jobs).toEqual(jobs);
  expect(model.getState().visible).toBe(false);
  expect(model.getState().lastUpdatedAt).not.toBeNull();
  jobs = jobs.map((job) => (job.id === "container" ? { ...job, status: "running" as const } : job));
  await model.refresh();
  expect(model.getState().jobs.find((job) => job.id === "container")?.status).toBe("running");
  expect(model.getState().pendingJobs.map((job) => job.id)).toEqual(["host-new"]);
  jobs = structuredClone(jobs);
  for (const job of jobs) job.expiresAt = "2020-01-01T00:00:00.000Z";
  await model.refresh();
  expect(model.getState().pendingJobs.map((job) => job.id)).toEqual(["host-new"]);
});

test("owner expiry during session restoration does not navigate away from an open editor", async () => {
  const model = new InstallationPanelModel({
    restartSummary: async () => null,
    restoreSession: async () => {
      throw new OwnerAccessExpired("Unlock controls to continue.");
    },
    passwordFile: null,
    sessionsSupported: true,
    lock: async () => {},
    unlock: async () => {},
    profileSharingStatus: async () => null,
    resolveProfileConflict: async () => {},
    listHelpers: async () => [],
    decideHelper: async () => {
      throw new Error("Unexpected helper decision");
    },
    listRestarts: async () => [],
    decide: async () => {},
  });
  await model.initialize();
  expect(model.getState()).toMatchObject({
    initialized: true,
    busy: false,
    unlocked: false,
    visible: false,
    error: "Unlock controls to continue.",
  });
});

test("restart explanations lead with the authored change and keep technical detail separate", () => {
  expect(
    restartExplanation(
      "(AI Generated).\n\nRestart Host to activate protected workspaces.\n\nValidation passed.\n\nRollback is prepared.",
    ),
  ).toEqual({
    summary: "Restart Host to activate protected workspaces.",
    details: "Validation passed.\n\nRollback is prepared.",
  });
  expect(restartExplanation("Restart Dev to activate shared profiles.")).toEqual({
    summary: "Restart Dev to activate shared profiles.",
    details: "",
  });
});

test("restart summaries omit build hashes", () => {
  expect(
    restartExplanation(
      "Restart Host to activate release 0123456789abcdef0123456789abcdef01234567 with protected workspaces.",
    ).summary,
  ).toBe("Restart Host to activate release with protected workspaces.");
});

test("legacy restart paragraphs show one sentence about the change", () => {
  const reason =
    "The owner requested another restart. The previous request was cancelled. Host already restarted. Dev remains on v139, worker 12345; this request activates v153 for Standing and Protected workspaces. It does not reload the coordinator.\n\nValidation passed.";
  expect(restartExplanation(reason)).toEqual({
    summary: "This restart activates v153 for Standing and Protected workspaces.",
    details: reason,
  });
  expect(
    restartExplanation("Maintenance was requested. Review the details. Wait until idle.").summary,
  ).toBe("Maintenance was requested.");
});

test("restart summaries omit version and source metadata without dangling labels", () => {
  expect(
    restartExplanation(
      "Activate task environments, version 0.11.0-beta.3.vorteo.175, source 0123456789abcdef0123456789abcdef01234567.",
    ).summary,
  ).toBe("Activate task environments.");
});

test("pending supervisor repair remains visible alongside an active source update", async () => {
  const base: RestartJob = {
    id: "source",
    revision: "revision",
    target: "container-daemon",
    requestedBy: "host-agent",
    reason: "Source update",
    createdAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
    status: "running",
    detail: "Installing",
  };
  const jobs: RestartJob[] = [
    base,
    { ...base, id: "supervisor", status: "pending", supervisorPlanSha256: "a".repeat(64) },
    { ...base, id: "factory", status: "pending", factoryRuntimePlanSha256: "c".repeat(64) },
  ];
  const model = new InstallationPanelModel({
    restartSummary: async () => null,
    restoreSession: async () => true,
    lock: async () => {},
    passwordFile: null,
    sessionsSupported: true,
    profileSharingStatus: async () => null,
    resolveProfileConflict: async () => {},
    unlock: async () => {},
    listHelpers: async () => [],
    decideHelper: async () => {
      throw new Error("Unexpected helper decision");
    },
    listRestarts: async () => jobs,
    decide: async () => {},
  });
  await model.initialize();
  expect(model.getState().pendingJobs.map((job) => job.id)).toEqual(["factory", "supervisor"]);
  expect(model.getState().jobs).toEqual(jobs);
  expect(restartBannerTitle(jobs[2]!)).toBe("Factory startup adoption needs review");
  expect(restartBannerTitle({ ...jobs[2]!, status: "running" })).toBe(
    "Adopting Factory startup on Dev",
  );
});

test("sidebar distinguishes blocked source updates from owner approval", () => {
  const job: RestartJob = {
    id: "request",
    revision: "revision",
    target: "host",
    requestedBy: "container-agent",
    reason: "Install features",
    createdAt: new Date().toISOString(),
    expiresAt: "9999-12-31T23:59:59.999Z",
    status: "pending",
    detail: "Contributions need correction",
    sourceBatch: { status: "conflict", contributions: [] },
  };
  expect(restartBannerTitle(job)).toBe("Host daemon update awaiting agent repair");
  expect(restartBlockingReason(job)).toBe("Contributions need correction");
  for (const [status, title] of [
    ["preparing", "update is being checked"],
    ["waiting", "update is waiting"],
    ["ready", "restart needs approval"],
  ] as const) {
    const changed = { ...job, sourceBatch: { ...job.sourceBatch!, status } };
    expect(restartBannerTitle(changed)).toBe(`Host daemon ${title}`);
    expect(restartBlockingReason(changed)).toBeNull();
  }
  expect(restartBannerTitle({ ...job, target: "container-daemon" })).toBe(
    "Dev daemon update awaiting agent repair",
  );
});

test("disabled restart actions explain their blocker and recovery without enabling approval", () => {
  const job: RestartJob = {
    id: "request",
    revision: "revision",
    target: "host",
    requestedBy: "container-agent",
    reason: "Install features",
    createdAt: new Date().toISOString(),
    expiresAt: "9999-12-31T23:59:59.999Z",
    status: "pending",
    detail: "Existing release notes were edited; resolve explicitly",
    sourceBatch: { status: "conflict", contributions: [] },
  };
  expect(restartActionDisabledReason(job, "install", false)).toContain(
    "reconcile the release-note history and resubmit",
  );
  expect(restartActionDisabledReason(job, "install", false)).toContain(
    "The requesting agent must repair",
  );
  expect(restartActionDisabledReason(job, "install", false)).toContain(
    "Cancel update if you no longer want it",
  );
  expect(restartActionDisabledReason(job, "install", true)).toContain("Wait for it to finish");
  expect(restartActionDisabledReason(job, "finish", false, false)).toContain(
    "Restore its connection",
  );
  expect(restartActionDisabledReason(job, "finish", false, true)).toBeNull();
  expect(
    restartActionDisabledReason(
      { ...job, sourceBatch: { status: "preparing", contributions: [] } },
      "install",
      false,
    ),
  ).toContain("Wait for preparation");
  expect(
    restartActionDisabledReason(
      { ...job, sourceBatch: { status: "waiting", contributions: [] } },
      "install",
      false,
    ),
  ).toContain("earlier installation");
  const ready = { ...job, sourceBatch: { status: "ready" as const, contributions: [] } };
  expect(restartActionDisabledReason(ready, "install", false)).toContain(
    "No validated installation artifact",
  );
  expect(
    restartActionDisabledReason(
      {
        ...ready,
        update: {
          sourceCommit: "a".repeat(40),
          baseCommit: "b".repeat(40),
          sha256: "c".repeat(64),
          bytes: 100,
        },
      },
      "install",
      false,
    ),
  ).toBeNull();
});

test("restart summaries identify Dev requests and durable Host automatic approval", () => {
  const job: RestartJob = {
    id: "request",
    revision: "revision",
    target: "host",
    requestedBy: "container-agent",
    reason: "Install checklist recovery.",
    createdAt: new Date(0).toISOString(),
    expiresAt: new Date(60_000).toISOString(),
    status: "pending",
    detail: "Approval required",
  };
  expect(restartRequestSummary(job)).toBe(
    "Requested by a Dev container; your approval is required. Install checklist recovery.",
  );
  expect(restartRequestSummary({ ...job, status: "succeeded" })).not.toContain(
    "approval is required",
  );
  expect(
    restartRequestSummary({
      ...job,
      requestedBy: "host-agent",
      status: "approved",
      automaticApproval: {
        policyActivatedAt: new Date(0).toISOString(),
        requestRevision: "revision",
      },
    }),
  ).toBe("Automatically approved for a trusted Host thread. Install checklist recovery.");
});

test("helper model observes without approving and refuses stale decisions", async () => {
  let decisions = 0;
  const model = new InstallationPanelModel({
    restartSummary: async () => null,
    restoreSession: async () => false,
    lock: async () => {},
    passwordFile: null,
    sessionsSupported: false,
    profileSharingStatus: async () => null,
    resolveProfileConflict: async () => {},
    unlock: async () => {},
    listRestarts: async () => [],
    decide: async () => {
      throw new Error("Unexpected restart");
    },
    listHelpers: async () => [helperReviewFixture],
    decideHelper: async () => {
      decisions++;
      throw new Error("Decision unconfirmed; refresh before retrying");
    },
  });
  await model.unlock();
  expect(model.getState().helperJobs).toEqual([helperReviewFixture]);
  expect(decisions).toBe(0);
  await model.decideHelper({ ...helperReviewFixture, planSha256: "b".repeat(64) }, "approve");
  expect(decisions).toBe(0);
  expect(model.getState().helperError).toBe(
    "Helper request changed. Refresh and review the current artifact.",
  );
  await model.decideHelper(helperReviewFixture, "approve");
  expect(decisions).toBe(1);
  expect(model.getState()).toMatchObject({
    busy: false,
    error: null,
    helperError: "Decision unconfirmed; refresh before retrying",
    helperJobs: [helperReviewFixture],
  });
  await model.refresh();
  expect(model.getState().helperError).toBe("Decision unconfirmed; refresh before retrying");
  model.dismissHelperError();
  expect(model.getState().helperError).toBeNull();
  await model.lock();
  expect(model.getState().helperJobs).toEqual([]);
});
