import { expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import type {
  CoordinatorBootstrapRequest,
  CoordinatorBootstrapDecision,
} from "@getpaseo/protocol/coordinator-bootstrap";
import {
  BootstrapPanelModel,
  bootstrapDecisionDisabledReason,
  bootstrapNeedsAttention,
  bootstrapStatus,
} from "./bootstrap-model";

function request(): CoordinatorBootstrapRequest {
  const file = { path: "/protected/file", sha256: "a".repeat(64) };
  const release = {
    sourceCommit: "b".repeat(40),
    directory: "/protected/release",
    artifactSha256: "c".repeat(64),
    node: file,
    entrypoint: file,
    configuration: file,
    launcher: file,
  };
  return {
    id: randomUUID(),
    revision: randomUUID(),
    requestedBy: "host-agent",
    reason: "Fixture update",
    createdAt: new Date().toISOString(),
    status: "pending",
    planSha256: "d".repeat(64),
    plan: {
      version: 1,
      operation: "coordinator-bootstrap",
      installationId: randomUUID(),
      service: "gui/501/local.vorteo.fixture.installation",
      expectedProcess: {
        pid: 123,
        bootId: randomUUID(),
        startIdentity: "1:2",
        argumentsSha256: "e".repeat(64),
      },
      previous: release,
      candidate: release,
      state: {
        directory: "/protected/state",
        restartJournal: "/protected/state/restart-jobs.json",
        ownerSessions: "/protected/state/owner-sessions.json",
      },
      hostRequestsAfter: null,
    },
  };
}

test("bootstrap approval submits exact identity and clears password; unsupported hosts stay hidden", async () => {
  const unsupported = new BootstrapPanelModel(() => null);
  await unsupported.refresh();
  expect(unsupported.getState().available).toBe(false);
  const item = request();
  const approved: CoordinatorBootstrapRequest = {
    ...item,
    status: "approved",
    revision: randomUUID(),
  };
  const sent: Array<{ input: CoordinatorBootstrapDecision; password: string }> = [];
  const model = new BootstrapPanelModel(() => ({
    listCoordinatorBootstrapRequests: async () => [item],
    decideCoordinatorBootstrap: async (input, password) => {
      sent.push({ input, password });
      return [approved];
    },
  }));
  await model.refresh();
  expect(bootstrapDecisionDisabledReason(item, model.getState())).toContain("owner password");
  model.setPassword("owner-fixture");
  await model.decide(item, "approve");
  expect(sent).toEqual([
    {
      input: {
        id: item.id,
        revision: item.revision,
        planSha256: item.planSha256,
        decision: "approve",
      },
      password: "owner-fixture",
    },
  ]);
  expect(model.getState().requests).toEqual([approved]);
  expect(model.getState().hasPassword).toBe(false);
  expect(model.getState().passwordEpoch).toBe(1);
  expect(bootstrapStatus(approved)).toBe("Approved; awaiting dispatch");
});

test("bootstrap rejects stale review, retains known status on disconnect and reports failed decisions", async () => {
  const item = request();
  let connected = true;
  let current = item;
  let calls = 0;
  const client = {
    listCoordinatorBootstrapRequests: async () => [current],
    decideCoordinatorBootstrap: async () => {
      calls++;
      throw new Error("Lost response");
    },
  };
  const model = new BootstrapPanelModel(() => (connected ? client : null));
  await model.refresh();
  current = { ...item, revision: randomUUID() };
  await model.refresh();
  model.setPassword("owner-fixture");
  await model.decide(item, "approve");
  expect(calls).toBe(0);
  expect(model.getState().error).toContain("request changed");
  await model.decide(current, "approve");
  expect(calls).toBe(1);
  expect(model.getState().error).toContain("Decision unconfirmed");
  expect(model.getState().busy).toBe(false);
  expect(model.getState().hasPassword).toBe(false);
  connected = false;
  await model.refresh();
  expect(model.getState().requests).toEqual([current]);
  expect(model.getState().error).toContain("Last known");
  connected = true;
  await model.refresh(true);
  expect(model.getState().error).toContain("Last known");
  await model.refresh();
  expect(model.getState().error).toBeNull();
});

test("late status cannot overwrite a cancellation decision", async () => {
  const item = request();
  const canceled: CoordinatorBootstrapRequest = {
    ...item,
    status: "canceled",
    revision: randomUUID(),
  };
  let finish!: (items: CoordinatorBootstrapRequest[]) => void;
  const delayed = new Promise<CoordinatorBootstrapRequest[]>((resolve) => {
    finish = resolve;
  });
  let reads = 0;
  const model = new BootstrapPanelModel(() => ({
    listCoordinatorBootstrapRequests: async () => (++reads === 1 ? [item] : delayed),
    decideCoordinatorBootstrap: async () => [canceled],
  }));
  await model.refresh();
  const refresh = model.refresh();
  model.setPassword("owner-fixture");
  await model.decide(item, "cancel");
  finish([item]);
  await refresh;
  expect(model.getState().requests).toEqual([canceled]);
  expect(bootstrapNeedsAttention(canceled)).toBe(false);
  const recovery: CoordinatorBootstrapRequest = {
    ...item,
    execution: {
      generation: randomUUID(),
      stage: "recovery_required",
      updatedAt: new Date().toISOString(),
    },
  };
  expect(bootstrapNeedsAttention(recovery)).toBe(true);
  expect(bootstrapStatus(recovery)).toBe("Recovery required");
  expect(bootstrapDecisionDisabledReason(recovery, { busy: false, hasPassword: true })).toContain(
    "separate reviewed request",
  );
});
