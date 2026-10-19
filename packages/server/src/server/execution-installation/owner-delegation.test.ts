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

test("only Host-agent requests with a delegated label are handled by the delegate", () => {
  expect(delegatedHandler(job(), ["Nova "])).toBe("Nova integration");
  // Requester labels are free text; a Dev agent cannot hide its request from the owner.
  expect(delegatedHandler(job({ requestedBy: "container-agent" }), ["Nova "])).toBeNull();
  expect(delegatedHandler(job({ requester: "Astra worker" }), ["Nova "])).toBeNull();
  expect(delegatedHandler(job({ requester: undefined }), ["Nova "])).toBeNull();
  expect(delegatedHandler(job({ status: "succeeded" }), ["Nova "])).toBeNull();
  expect(delegatedHandler(job(), [])).toBeNull();
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
  expect(delegatedHandler(batch([contribution]), ["Nova "])).toBe("Nova integration");
  const other = { ...contribution, requester: "Owner script" };
  expect(delegatedHandler(batch([contribution, other]), ["Nova "])).toBeNull();
  expect(
    delegatedHandler(batch([contribution, { ...other, status: "superseded" }]), ["Nova "]),
  ).toBe("Nova integration");
});

test("a missing or invalid delegation file delegates nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "owner-delegation-"));
  dirs.push(dir);
  expect(readOwnerDelegation(dir)).toMatchObject({
    delegatedRequesterPrefixes: [],
    hostUpdateServiceRestart: false,
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
  });
});
