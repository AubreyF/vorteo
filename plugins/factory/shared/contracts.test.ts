import { expect, test } from "vitest";
import {
  FactorySetupSchema,
  FactoryInstallInputSchema,
  FactoryInstallResultSchema,
  type FactorySetup,
} from "./operations.js";
import {
  ActivityReceiptSchema,
  ActivityReceiptsSchema,
  FactorySnapshotSchema,
  type ActivityReceipt,
  type ActivityReceipts,
  type FactorySnapshot,
} from "./contracts.js";

const at = "2026-10-07T20:00:00.000Z";
const verifiedAt = "2026-10-07T20:05:00.000Z";
const setup: FactorySetup = {
  schemaVersion: 1,
  serverId: "srv_test",
  projectId: "prj_test",
  installationId: null,
  revision: "setup-revision",
  observedAt: at,
  state: "ready",
  reason: null,
  operations: { install: true, pause: false, resume: false, stop: false, disable: false },
};

test("setup only enables installation with an observed ready initial precondition", () => {
  expect(FactorySetupSchema.parse(setup)).toEqual(setup);
  for (const change of [
    { revision: null },
    { observedAt: null },
    { installationId: "existing-installation" },
    { state: "held", reason: "Reconciliation required" },
    { state: "unavailable", reason: "Native adapter unavailable" },
    { state: "installed", installationId: "installation-test" },
  ])
    expect(FactorySetupSchema.safeParse({ ...setup, ...change }).success).toBe(false);
});

test("unavailable and installed setup stay explicit with all deferred operations disabled", () => {
  const operations = { ...setup.operations, install: false };
  const unavailable = {
    ...setup,
    state: "unavailable",
    revision: null,
    observedAt: null,
    operations,
    reason: "Native adapter unavailable",
  };
  expect(FactorySetupSchema.parse(unavailable)).toEqual(unavailable);
  expect(FactorySetupSchema.safeParse({ ...unavailable, reason: null }).success).toBe(false);
  expect(FactorySetupSchema.safeParse({ ...unavailable, reason: "   " }).success).toBe(false);
  expect(FactorySetupSchema.safeParse({ ...setup, state: "installed", operations }).success).toBe(
    false,
  );
  for (const action of ["pause", "resume", "stop", "disable"])
    expect(
      FactorySetupSchema.safeParse({
        ...unavailable,
        operations: { ...operations, [action]: true },
      }).success,
    ).toBe(false);
});

test("installation requests require exact preconditions and reject caller-selected native identities", () => {
  const input = {
    projectId: "prj_test",
    expectedServerId: "srv_test",
    expectedInstallationId: null,
    expectedRevision: "setup-revision",
    operationId: "attempt-1",
  };
  expect(FactoryInstallInputSchema.parse(input)).toEqual(input);
  expect(FactoryInstallInputSchema.safeParse({ ...input, expectedRevision: " " }).success).toBe(
    false,
  );
  const { expectedInstallationId: _removed, ...omitted } = input;
  expect(FactoryInstallInputSchema.safeParse(omitted).success).toBe(false);
  for (const field of ["accountId", "profileId", "workspaceId", "agentId", "path", "ownerId"])
    expect(
      FactoryInstallInputSchema.safeParse({ ...input, [field]: "caller-choice" }).success,
    ).toBe(false);
});

test("applied installation results require matching installed native identities", () => {
  const installed = {
    ...setup,
    state: "installed",
    installationId: "installation-test",
    operations: { ...setup.operations, install: false },
  };
  const applied = {
    schemaVersion: 1,
    serverId: "srv_test",
    projectId: "prj_test",
    operationId: "attempt-1",
    outcome: "applied",
    installationId: "installation-test",
    observedAt: at,
    setup: installed,
  };
  expect(FactoryInstallResultSchema.parse(applied)).toEqual(applied);
  for (const change of [
    { serverId: "srv_other" },
    { projectId: "prj_other" },
    { installationId: "installation-other" },
    { state: "ready" },
  ])
    expect(
      FactoryInstallResultSchema.safeParse({ ...applied, setup: { ...installed, ...change } })
        .success,
    ).toBe(false);
});

test("partial installation remains uncertain rather than an applied or replayable result", () => {
  const uncertain = {
    schemaVersion: 1,
    serverId: "srv_test",
    projectId: "prj_test",
    operationId: "attempt-1",
    outcome: "uncertain",
    installationId: "installation-test",
    reason: "Native binding persisted; observation attachment requires reconciliation",
    reconciliationRequired: true,
  };
  expect(FactoryInstallResultSchema.parse(uncertain)).toEqual(uncertain);
  expect(
    FactoryInstallResultSchema.safeParse({ ...uncertain, reconciliationRequired: false }).success,
  ).toBe(false);
  expect(FactoryInstallResultSchema.safeParse({ ...uncertain, reason: " " }).success).toBe(false);
  expect(FactoryInstallResultSchema.safeParse({ ...uncertain, outcome: "applied" }).success).toBe(
    false,
  );
});
const receipt: ActivityReceipt = {
  id: "publication-1",
  projectId: "prj_test",
  workspaceId: null,
  agentId: null,
  installationId: "installation-test",
  kind: "publication",
  status: "completed",
  occurredAt: at,
  observedAt: verifiedAt,
  verifiedAt,
  provenance: { source: "factory_controller", sourceId: "release-1", sourceRevision: "1" },
  delivery: {
    repository: "example/repository",
    sourceCommit: "a".repeat(40),
    deliveryId: "release-1",
    url: "https://github.com/example/repository/releases/tag/v1",
  },
  verification: { state: "verified", reason: "Independent publication evidence retained" },
  summary: "Published v1",
  url: "https://github.com/example/repository/releases/tag/v1",
};
const envelope: ActivityReceipts = {
  schemaVersion: 1,
  producer: { serverId: "srv_test", pluginId: "factory" },
  observedAt: verifiedAt,
  availability: "available",
  receipts: [receipt],
  nextCursor: null,
  coverage: { from: at, to: verifiedAt, complete: true, gaps: [], cursorState: "initial" },
};
const snapshot: FactorySnapshot = {
  schemaVersion: 1,
  serverId: "srv_test",
  revision: null,
  installationId: null,
  projectId: "prj_test",
  observedAt: at,
  freshness: { state: "unknown", reason: "Not adopted" },
  admission: { state: "unavailable", reason: "Not adopted" },
  account: { usagePoints: null, limitPoints: null, observedAt: null, unit: "allowance-points" },
  coordinators: [],
  work: [],
  issues: [],
  builds: { active: null, pending: [], latestRelease: null },
  exceptions: [],
  coverage: {
    work: { complete: false, gaps: ["Unknown"] },
    issues: { complete: false, gaps: ["Unknown"] },
    builds: { complete: false, gaps: ["Unknown"] },
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

test("publication and verification timestamps remain distinct", () => {
  expect(ActivityReceiptSchema.parse(receipt)).toEqual(receipt);
  expect(ActivityReceiptsSchema.parse(envelope)).toEqual(envelope);
});

test.each(["javascript:alert(1)", "file:///tmp/private", "ftp://example.com/release", "not-a-url"])(
  "rejects unsafe receipt link %s",
  (url) => {
    expect(ActivityReceiptSchema.safeParse({ ...receipt, url }).success).toBe(false);
  },
);

test("rejects delivery claims missing identity or verification evidence", () => {
  expect(ActivityReceiptSchema.safeParse({ ...receipt, delivery: null }).success).toBe(false);
  expect(ActivityReceiptSchema.safeParse({ ...receipt, verifiedAt: null }).success).toBe(false);
  expect(ActivityReceiptSchema.safeParse({ ...receipt, kind: "thread_status" }).success).toBe(
    false,
  );
  expect(
    ActivityReceiptSchema.safeParse({
      ...receipt,
      provenance: { ...receipt.provenance, source: "native_agent" },
    }).success,
  ).toBe(false);
  expect(
    ActivityReceiptSchema.safeParse({
      ...receipt,
      verifiedAt: null,
      verification: { state: "observed", reason: "Not independently verified" },
    }).success,
  ).toBe(true);
});

test("unavailable differs from an empty observed page", () => {
  const unavailable = {
    ...envelope,
    availability: "unavailable",
    receipts: null,
    coverage: { ...envelope.coverage, complete: false },
  };
  expect(ActivityReceiptsSchema.safeParse(unavailable).success).toBe(true);
  expect(ActivityReceiptsSchema.safeParse({ ...unavailable, receipts: [] }).success).toBe(false);
  expect(ActivityReceiptsSchema.safeParse({ ...unavailable, nextCursor: "cursor" }).success).toBe(
    false,
  );
  expect(
    ActivityReceiptsSchema.safeParse({ ...unavailable, coverage: envelope.coverage }).success,
  ).toBe(false);
  expect(ActivityReceiptsSchema.safeParse({ ...envelope, receipts: null }).success).toBe(false);
  expect(ActivityReceiptsSchema.safeParse({ ...envelope, receipts: [] }).success).toBe(true);
});

test("expired cursors disclose gaps and reversed coverage is rejected", () => {
  const expired = { ...envelope.coverage, cursorState: "expired" };
  expect(ActivityReceiptsSchema.safeParse({ ...envelope, coverage: expired }).success).toBe(false);
  expect(
    ActivityReceiptsSchema.safeParse({ ...envelope, coverage: { ...expired, complete: false } })
      .success,
  ).toBe(false);
  expect(
    ActivityReceiptsSchema.safeParse({
      ...envelope,
      coverage: { ...expired, complete: false, gaps: ["Cursor expired"] },
    }).success,
  ).toBe(true);
  expect(
    ActivityReceiptsSchema.safeParse({
      ...envelope,
      coverage: { ...envelope.coverage, from: verifiedAt, to: at },
    }).success,
  ).toBe(false);
});

test("snapshot preserves unknown allowance and rejects duplicate coordinators or oversized lists", () => {
  expect(FactorySnapshotSchema.parse(snapshot).account).toEqual(snapshot.account);
  const coordinator = { role: "factory", workspaceId: null, agentId: null, status: "unknown" };
  expect(
    FactorySnapshotSchema.safeParse({ ...snapshot, coordinators: [coordinator, coordinator] })
      .success,
  ).toBe(false);
  expect(
    FactorySnapshotSchema.safeParse({
      ...snapshot,
      account: { ...snapshot.account, usagePoints: Infinity },
    }).success,
  ).toBe(false);
  const issue = {
    id: "issue-1",
    number: 1,
    title: "Issue",
    url: "https://github.com/example/repository/issues/1",
    qualification: "pending",
    reason: null,
  };
  expect(
    FactorySnapshotSchema.safeParse({
      ...snapshot,
      issues: Array.from({ length: 101 }, () => issue),
    }).success,
  ).toBe(false);
});
