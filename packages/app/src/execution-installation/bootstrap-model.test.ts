import { expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import type {
  CoordinatorBootstrapRequest,
  CoordinatorBootstrapDecision,
  BootstrapPreclaimRecoveryRequest,
} from "@getpaseo/protocol/coordinator-bootstrap";
import {
  BootstrapPanelModel,
  bootstrapDecisionDisabledReason,
  bootstrapNeedsAttention,
  bootstrapStatus,
  currentBootstrapRequests,
  preclaimRecoveryStatus,
  preclaimRecoveryNeedsAttention,
  preclaimDispatchDescription,
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

function recoveryRequest(): BootstrapPreclaimRecoveryRequest {
  const original = { ...request(), status: "approved" as const };
  const file = original.plan.candidate.configuration;
  const process = {
    ...original.plan.expectedProcess,
    parentPid: 1,
    uid: 501,
    executable: file.path,
  };
  return {
    ...request(),
    plan: {
      version: 1,
      operation: "bootstrap-preclaim-recovery",
      original,
      canceled: { ...original, revision: randomUUID(), status: "canceled" },
      executor: { identity: process, auditToken: [501, 501, 20, 501, 20, process.pid, 1, 2] },
      hostProcess: process,
      coordinatorProcess: process,
      setup: file,
      ownerLauncher: file,
      runner: original.plan.candidate,
      executorEntrypoint: file,
      selectedLauncher: file,
      selectedConfiguration: file,
      executionLock: { path: "/protected/state/lock", device: "1", inode: "2" },
      signalPolicy: { terminate: "SIGTERM", escalation: "none", graceSeconds: 10 },
    },
    execution: undefined,
  };
}

test("recovery exposes cancellation after recorded approval while the old response remains unresolved", async () => {
  const pending = recoveryRequest();
  const approved = { ...pending, status: "approved" as const, revision: randomUUID() };
  const canceled = { ...approved, status: "canceled" as const, revision: randomUUID() };
  let listed = [pending];
  const waiting = Promise.withResolvers<BootstrapPreclaimRecoveryRequest[]>();
  const sent: CoordinatorBootstrapDecision[] = [];
  const model = new BootstrapPanelModel<BootstrapPreclaimRecoveryRequest>(() => ({
    listCoordinatorBootstrapRequests: async () => listed,
    decideCoordinatorBootstrap: async (input) => {
      sent.push(input);
      return input.decision === "approve" ? waiting.promise : [canceled];
    },
  }));
  await model.refresh();
  model.setPassword("fixture");
  const decision = model.decide(pending, "approve");
  expect(model.getState()).toMatchObject({ busy: true, hasPassword: false });
  listed = [approved];
  await model.refresh(true);
  expect(model.getState()).toMatchObject({ busy: false, requests: [approved] });
  expect(preclaimRecoveryStatus(approved)).toBe("Approved; awaiting recorded claim");
  model.setPassword("fixture");
  await model.decide(approved, "cancel");
  waiting.resolve([approved]);
  await decision;
  expect(model.getState()).toMatchObject({ requests: [canceled], busy: false, hasPassword: false });
  expect(sent).toEqual(
    [pending, approved].map((item, index) => ({
      id: item.id,
      revision: item.revision,
      planSha256: item.planSha256,
      decision: index === 0 ? "approve" : "cancel",
    })),
  );
  expect(preclaimRecoveryNeedsAttention(canceled)).toBe(false);
});

test("recovery keeps uncertain effects visible and only a verified receipt reports success", () => {
  const item = recoveryRequest();
  item.execution = {
    generation: randomUUID(),
    stage: "effect_pending",
    updatedAt: new Date().toISOString(),
  };
  expect(preclaimRecoveryNeedsAttention(item)).toBe(true);
  expect(preclaimRecoveryStatus(item)).toBe("Stopping the reviewed executor");
  expect(bootstrapDecisionDisabledReason(item, { busy: false, hasPassword: true })).toContain(
    "dispatched",
  );
  item.execution.stage = "recovery_required";
  expect(preclaimRecoveryStatus(item)).toBe("Outcome requires inspection");
  expect(preclaimRecoveryNeedsAttention(item)).toBe(true);
  item.execution.stage = "succeeded";
  expect(preclaimRecoveryStatus(item)).toBe("Recovery verified");
  expect(preclaimRecoveryNeedsAttention(item)).toBe(false);
});

test("retained recovery birth is described as historical evidence without inferring an outcome", () => {
  const item = recoveryRequest();
  item.status = "approved";
  const observed = {
    ...item,
    dispatch: {
      state: "birth_retained" as const,
      approvedRevision: item.revision,
      attemptId: randomUUID(),
      executor: item.plan.executor.identity,
    },
  };
  expect(preclaimDispatchDescription(observed)).toContain(
    "Current liveness and completion still require verification",
  );
  expect(preclaimRecoveryStatus(observed)).toBe("Approved; awaiting recorded claim");
  expect(preclaimRecoveryNeedsAttention(observed)).toBe(true);
  expect(preclaimDispatchDescription({ ...item, dispatch: { state: "no_receipt" } })).toBe(
    "No launch receipt recorded.",
  );
  expect(preclaimDispatchDescription({ ...item, dispatch: { state: "unavailable" } })).toContain(
    "do not replay approval",
  );
});

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

test("recorded approval unlocks status and cancellation while a late decision response is ignored", async () => {
  const item = request();
  const approved: CoordinatorBootstrapRequest = {
    ...item,
    revision: randomUUID(),
    status: "approved",
  };
  const canceled: CoordinatorBootstrapRequest = {
    ...approved,
    revision: randomUUID(),
    status: "canceled",
  };
  let current = item;
  let reject!: (error: Error) => void;
  let calls = 0;
  const pending = new Promise<CoordinatorBootstrapRequest[]>((_, fail) => {
    reject = fail;
  });
  const model = new BootstrapPanelModel(() => ({
    listCoordinatorBootstrapRequests: async () => [current],
    decideCoordinatorBootstrap: async () => (++calls === 1 ? pending : [canceled]),
  }));
  await model.refresh();
  model.setPassword("fixture");
  const decision = model.decide(item, "approve");
  await model.refresh(true);
  expect(model.getState().busy).toBe(true);
  await model.decide(item, "approve");
  expect(calls).toBe(1);
  current = approved;
  await model.refresh(true);
  expect(model.getState().requests).toEqual([approved]);
  expect(model.getState().busy).toBe(false);
  model.setPassword("fixture");
  expect(bootstrapDecisionDisabledReason(approved, model.getState())).toBeNull();
  await model.decide(approved, "cancel");
  reject(new Error("Late transport timeout"));
  await decision;
  expect(model.getState().requests).toEqual([canceled]);
  expect(model.getState().error).toBeNull();
  expect(model.getState().busy).toBe(false);
});

test("rollback outcome is distinct from success and fresh review replaces only its recovered callout", () => {
  const failed = request();
  failed.status = "approved";
  failed.execution = {
    generation: randomUUID(),
    stage: "rolled_back",
    updatedAt: new Date().toISOString(),
  };
  expect(bootstrapStatus(failed)).toBe("Previous coordinator restored; update not installed");
  expect(bootstrapNeedsAttention(failed)).toBe(false);
  const next = request();
  next.plan.recoveredFrom = {
    id: failed.id,
    revision: failed.revision,
    planSha256: failed.planSha256,
    generation: failed.execution.generation,
  };
  expect(currentBootstrapRequests([failed, next])).toEqual([next]);
  next.status = "canceled";
  expect(currentBootstrapRequests([failed, next])).toEqual([failed, next]);
});

test("unavailable maintenance shows its diagnosis and removes stale approvals until recovery", async () => {
  const item = request();
  let reason: string | null = null;
  let decisions = 0;
  let reads = 0;
  const model = new BootstrapPanelModel(
    () => ({
      listCoordinatorBootstrapRequests: async () => {
        reads++;
        return [item];
      },
      decideCoordinatorBootstrap: async () => {
        decisions++;
        return [item];
      },
    }),
    () => reason,
  );
  await model.refresh();
  model.setPassword("fixture");
  reason = "Coordinator maintenance is unavailable: retained history is incompatible.";
  await model.decide(item, "approve");
  expect(decisions).toBe(0);
  expect(reads).toBe(1);
  expect(model.getState()).toMatchObject({
    available: true,
    requests: [],
    busy: false,
    hasPassword: false,
    error: reason,
  });
  reason = null;
  await model.refresh(true);
  expect(reads).toBe(2);
  expect(model.getState()).toMatchObject({ requests: [item], error: null, hasPassword: false });
});

test.each(["success", "error"] as const)(
  "recovery replaces an unresolved list and ignores its stale %s and finalizer",
  async (outcome) => {
    const old = Promise.withResolvers<CoordinatorBootstrapRequest[]>();
    const next = Promise.withResolvers<CoordinatorBootstrapRequest[]>();
    const latest = Promise.withResolvers<CoordinatorBootstrapRequest[]>();
    const recovered = request();
    const newest = request();
    let reason: string | null = null;
    let reads = 0;
    let list = () => old.promise;
    const model = new BootstrapPanelModel(
      () => ({
        listCoordinatorBootstrapRequests: () => {
          reads++;
          return list();
        },
        decideCoordinatorBootstrap: async () => [],
      }),
      () => reason,
    );
    const oldRefresh = model.refresh();
    reason = "Maintenance unavailable";
    await model.refresh();
    reason = null;
    list = () => next.promise;
    const nextRefresh = model.refresh();
    expect(reads).toBe(2);
    next.resolve([recovered]);
    await nextRefresh;
    expect(model.getState()).toMatchObject({ requests: [recovered], error: null });
    list = () => latest.promise;
    const latestRefresh = model.refresh();
    expect(reads).toBe(3);
    if (outcome === "success") old.resolve([request()]);
    else old.reject(new Error("stale failure"));
    await oldRefresh;
    expect(model.getState()).toMatchObject({ requests: [recovered], error: null });
    await model.refresh();
    expect(reads).toBe(3);
    latest.resolve([newest]);
    await latestRefresh;
    expect(model.getState()).toMatchObject({ requests: [newest], error: null });
    await model.refresh();
    expect(reads).toBe(4);
  },
);

test("outcome verification carries exact generation without an owner decision", async () => {
  const item = request();
  item.status = "approved";
  item.execution = {
    generation: randomUUID(),
    stage: "recovery_required",
    updatedAt: new Date().toISOString(),
  };
  const inputs: unknown[] = [];
  let decisions = 0;
  const model = new BootstrapPanelModel(() => ({
    listCoordinatorBootstrapRequests: async () => [item],
    decideCoordinatorBootstrap: async () => {
      decisions++;
      return [];
    },
    verifyRetainedOutcome: async (input) => {
      inputs.push(input);
      return [item];
    },
  }));
  await model.refresh();
  await model.reconcile(item);
  expect(inputs).toEqual([
    {
      id: item.id,
      revision: item.revision,
      planSha256: item.planSha256,
      generation: item.execution.generation,
    },
  ]);
  expect(decisions).toBe(0);
  expect(model.getState().busy).toBe(false);
  await model.reconcile({ ...item, revision: randomUUID() });
  expect(inputs).toHaveLength(1);
});
