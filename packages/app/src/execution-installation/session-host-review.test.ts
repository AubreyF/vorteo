import { expect, test } from "vitest";
import type { SessionHostStatus } from "@getpaseo/protocol/session-host-maintenance";
import { sessionHostJobFixture, sessionHostStatusFixture } from "./session-host-review.fixture";
import {
  sessionHostActionDisabledReason,
  sessionHostOperationTitle,
  sessionHostPlanLines,
  sessionHostRequestDisabledReason,
  sessionHostReviewSummary,
  sessionHostStatusLines,
  visibleSessionHostJobs,
} from "./session-host-review";

const unlocked = { busy: false, unlocked: true };
const installed: SessionHostStatus = {
  supported: true,
  installed: true,
  detail: {
    ...sessionHostStatusFixture.detail!,
    plist: "matching",
    loaded: true,
    pid: 4242,
    lastExitStatus: 0,
    runs: 2,
    host: { pid: 4242, release: "0.11.0-beta.3.vorteo.707", sessions: 0 },
  },
};

test("operations are named for the owner", () => {
  expect(sessionHostOperationTitle("session-host-install")).toBe("Install the session host job");
  expect(sessionHostOperationTitle("session-host-remove")).toBe("Remove the session host job");
});

test("the plan summary shows every reviewed fact and binds to the plan digest", () => {
  const job = sessionHostJobFixture;
  expect(sessionHostPlanLines(job)).toEqual([
    `Label: ${job.plan.label}`,
    `Plist: ${job.plan.plistPath}`,
    `Node: ${job.plan.node}`,
    `Entrypoint: ${job.plan.entrypoint}`,
    `Working directory: ${job.plan.workingDirectory}`,
    `PASEO_HOME: ${job.plan.paseoHome}`,
    `HOME: ${job.plan.environment.HOME}`,
    `PATH: ${job.plan.environment.PATH}`,
    `Log: ${job.plan.logPath}`,
    `Plist SHA-256: ${job.plan.plistSha256}`,
    `Plan: ${job.planSha256}`,
  ]);
  const removal = { ...job, plan: { ...job.plan, plistSha256: null } };
  expect(sessionHostPlanLines(removal)).toContain("Plist SHA-256: none");
});

test("only a prepared pending request can be approved; cancel lasts until dispatch", () => {
  const pending = { status: "pending", stage: "prepared" } as const;
  expect(sessionHostActionDisabledReason(pending, "approve", unlocked)).toBeNull();
  expect(sessionHostActionDisabledReason(pending, "cancel", unlocked)).toBeNull();
  const approved = { status: "approved", stage: "dispatch_pending" } as const;
  expect(sessionHostActionDisabledReason(approved, "approve", unlocked)).toContain(
    "no longer awaiting approval",
  );
  expect(sessionHostActionDisabledReason(approved, "cancel", unlocked)).toBeNull();
  const running = { status: "running", stage: "applying" } as const;
  expect(sessionHostActionDisabledReason(running, "cancel", unlocked)).toContain("dispatched");
  expect(
    sessionHostActionDisabledReason(pending, "approve", { ...unlocked, busy: true }),
  ).toContain("Wait for the current action");
  expect(
    sessionHostActionDisabledReason(pending, "approve", { ...unlocked, unlocked: false }),
  ).toContain("Unlock Installation controls");
});

test("install and remove explain the coordinator's refusals before the owner asks", () => {
  const absent = { jobs: [], status: sessionHostStatusFixture };
  expect(sessionHostRequestDisabledReason("session-host-install", absent, unlocked)).toBeNull();
  expect(sessionHostRequestDisabledReason("session-host-remove", absent, unlocked)).toBe(
    "The session host job is not installed.",
  );
  expect(
    sessionHostRequestDisabledReason(
      "session-host-install",
      { jobs: [], status: { ...sessionHostStatusFixture, supported: false } },
      unlocked,
    ),
  ).toContain("no session host");

  const present = { jobs: [], status: installed };
  expect(sessionHostRequestDisabledReason("session-host-install", present, unlocked)).toBe(
    "The session host job is already installed.",
  );
  expect(sessionHostRequestDisabledReason("session-host-remove", present, unlocked)).toBeNull();
  const settingOn = {
    jobs: [],
    status: { ...installed, detail: { ...installed.detail!, settingEnabled: true } },
  };
  expect(sessionHostRequestDisabledReason("session-host-remove", settingOn, unlocked)).toContain(
    "Turn off durable sessions first",
  );
  const sessionsRunning = {
    jobs: [],
    status: {
      ...installed,
      detail: { ...installed.detail!, host: { ...installed.detail!.host!, sessions: 2 } },
    },
  };
  expect(
    sessionHostRequestDisabledReason("session-host-remove", sessionsRunning, unlocked),
  ).toContain("Hosted sessions are still running");
  const open = { jobs: [{ ...sessionHostJobFixture }], status: sessionHostStatusFixture };
  expect(sessionHostRequestDisabledReason("session-host-install", open, unlocked)).toContain(
    "already open",
  );
});

test("status lists what the coordinator observed, and only what the token may see", () => {
  expect(sessionHostStatusLines(installed)).toEqual([
    "Installed: yes",
    "Loaded: yes",
    "Process: 4242",
    "Last exit: 0",
    "Runs: 2",
    "Host release: 0.11.0-beta.3.vorteo.707",
    "Hosted sessions: 0",
    "Durable sessions setting: off",
    `Observed: ${installed.detail!.observedAt}`,
  ]);
  expect(sessionHostStatusLines({ supported: false, installed: false })).toEqual([
    "Installed: no",
    "Release support: the installed release has no session host",
    "Details are unavailable to this client.",
  ]);
  expect(
    sessionHostStatusLines({
      ...installed,
      detail: { ...installed.detail!, plist: "different", host: null },
    }),
  ).toEqual(
    expect.arrayContaining([
      "Host release: not answering",
      "Hosted sessions: unknown",
      "Plist: differs from the coordinator's plan. Remove the job and install it again.",
    ]),
  );
});

test("open requests come first, then only the latest finished one", () => {
  const at = (minute: number) => `2026-10-20T00:${String(minute).padStart(2, "0")}:00.000Z`;
  const job = (id: string, status: typeof sessionHostJobFixture.status, minute: number) => ({
    ...sessionHostJobFixture,
    id,
    status,
    createdAt: at(minute),
  });
  const jobs = [
    job("old-failure", "failed", 1),
    job("recent-success", "succeeded", 5),
    job("pending", "pending", 3),
  ];
  expect(visibleSessionHostJobs(jobs).map((item) => item.id)).toEqual([
    "pending",
    "recent-success",
  ]);
});

test("summaries distinguish a forced removal and never suggest the setting is enabled", () => {
  const removal = { ...sessionHostJobFixture, operation: "session-host-remove" as const };
  expect(sessionHostReviewSummary({ ...removal, status: "succeeded", forcedStop: true })).toContain(
    "stopped by force",
  );
  expect(sessionHostReviewSummary(sessionHostJobFixture)).toContain(
    "durable sessions stay off until you enable them",
  );
});

test("without a status the card still offers decisions on jobs but no new requests", () => {
  const job = sessionHostJobFixture;
  const unknown = { jobs: [job], status: null };
  expect(sessionHostStatusLines(null)).toEqual(["Status unavailable"]);
  for (const operation of ["session-host-install", "session-host-remove"] as const)
    expect(sessionHostRequestDisabledReason(operation, unknown, unlocked)).toBe(
      "Session host status is unavailable.",
    );
  expect(
    sessionHostRequestDisabledReason("session-host-install", { jobs: [], status: null }, unlocked),
  ).toBe("Session host status is unavailable.");
  expect(visibleSessionHostJobs(unknown.jobs)).toEqual([job]);
  expect(sessionHostActionDisabledReason(job, "approve", unlocked)).toBeNull();
  expect(sessionHostActionDisabledReason(job, "cancel", unlocked)).toBeNull();
});
