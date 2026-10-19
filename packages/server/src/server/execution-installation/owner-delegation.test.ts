import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RestartJob } from "@getpaseo/protocol/execution-installation";
import { afterEach, expect, test } from "vitest";
import { delegatedHandler, readOwnerDelegation } from "./owner-delegation.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function job(overrides: Partial<RestartJob> = {}): RestartJob {
  return {
    id: "10000000-0000-4000-8000-000000000001",
    revision: "10000000-0000-4000-8000-000000000002",
    target: "host",
    reason: "Routine update",
    requester: "Nova integration",
    requestedBy: "host-agent",
    createdAt: new Date(0).toISOString(),
    expiresAt: new Date(1).toISOString(),
    status: "pending",
    detail: "Waiting",
    ...overrides,
  };
}

const delegation = { delegatedRequesterPrefixes: ["Nova "], graceMinutes: 15 };
const createdAt = Date.parse(job().createdAt);
const minutes = (count: number) => createdAt + count * 60_000;
const handling = { state: "handling", requester: "Nova integration" };
const overdue = { state: "overdue", requester: "Nova integration" };

test("only Host-agent requests with a delegated label are handled by the delegate", () => {
  expect(delegatedHandler(job(), delegation, minutes(1))).toEqual(handling);
  // Requester labels are free text; a Dev agent cannot hide its request from the owner.
  expect(
    delegatedHandler(job({ requestedBy: "container-agent" }), delegation, minutes(1)),
  ).toBeNull();
  expect(delegatedHandler(job({ requester: "Astra worker" }), delegation, minutes(1))).toBeNull();
  expect(delegatedHandler(job({ requester: undefined }), delegation, minutes(1))).toBeNull();
  expect(delegatedHandler(job({ status: "succeeded" }), delegation, minutes(1))).toBeNull();
  expect(
    delegatedHandler(job(), { ...delegation, delegatedRequesterPrefixes: [] }, minutes(1)),
  ).toBeNull();
});

test("an unapproved delegated request prompts the owner again after its grace window", () => {
  expect(delegatedHandler(job(), delegation, minutes(14))).toEqual(handling);
  expect(delegatedHandler(job(), delegation, minutes(15))).toEqual(overdue);
  expect(delegatedHandler(job(), { ...delegation, graceMinutes: 60 }, minutes(59))).toEqual(
    handling,
  );
});

test("an automatic approval or a running request stays handled past the grace window", () => {
  const automaticApproval = {
    policyActivatedAt: new Date(0).toISOString(),
    requestRevision: job().revision,
  };
  expect(
    delegatedHandler(job({ status: "approved", automaticApproval }), delegation, minutes(90)),
  ).toEqual(handling);
  expect(delegatedHandler(job({ status: "running" }), delegation, minutes(90))).toEqual(handling);
  // An owner approval is already decided; it is ordinary queued work, not a delegation.
  expect(delegatedHandler(job({ status: "approved" }), delegation, minutes(1))).toBeNull();
});

test("a source batch is delegated only when every remaining contribution is", () => {
  const contribution = {
    id: "10000000-0000-4000-8000-000000000003",
    update: {
      sourceCommit: "a".repeat(40),
      baseCommit: "b".repeat(40),
      sha256: "c".repeat(64),
      bytes: 1,
    },
    reason: "Update",
    requestedBy: "host-agent" as const,
    requester: "Nova integration",
    createdAt: new Date(0).toISOString(),
    status: "included" as const,
    detail: "Included",
  };
  const batch = (contributions: (typeof contribution)[]) =>
    job({ sourceBatch: { status: "ready", webCommit: "b".repeat(40), contributions } });
  expect(delegatedHandler(batch([contribution]), delegation, minutes(1))).toEqual(handling);
  const other = { ...contribution, requester: "Owner script" };
  expect(delegatedHandler(batch([contribution, other]), delegation, minutes(1))).toBeNull();
  expect(
    delegatedHandler(
      batch([contribution, { ...other, status: "superseded" }]),
      delegation,
      minutes(1),
    ),
  ).toEqual(handling);
});

test("a missing or invalid delegation file delegates nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "owner-delegation-"));
  dirs.push(dir);
  expect(readOwnerDelegation(dir)).toMatchObject({
    delegatedRequesterPrefixes: [],
    hostUpdateServiceRestart: false,
    graceMinutes: 15,
  });
  writeFileSync(
    join(dir, "owner-delegation.json"),
    '{"version":1,"hostUpdateServiceRestart":true}',
  );
  expect(readOwnerDelegation(dir).hostUpdateServiceRestart).toBe(false);
  writeFileSync(join(dir, "owner-delegation.json"), "not json");
  expect(readOwnerDelegation(dir).hostUpdateServiceRestart).toBe(false);
  writeFileSync(
    join(dir, "owner-delegation.json"),
    JSON.stringify({
      version: 1,
      delegatedRequesterPrefixes: ["Nova "],
      hostUpdateServiceRestart: true,
    }),
  );
  expect(readOwnerDelegation(dir)).toMatchObject({
    delegatedRequesterPrefixes: ["Nova "],
    hostUpdateServiceRestart: true,
    graceMinutes: 15,
  });
  writeFileSync(
    join(dir, "owner-delegation.json"),
    JSON.stringify({
      version: 1,
      delegatedRequesterPrefixes: [],
      hostUpdateServiceRestart: false,
      graceMinutes: 61,
    }),
  );
  // The window is capped at an hour; an out-of-range value delegates nothing.
  expect(readOwnerDelegation(dir).graceMinutes).toBe(15);
});
