import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { BridgeStore } from "./store.js";
import { BridgeEvents } from "./events.js";
import {
  WorkspaceObserver,
  type Cursor,
  type HistoryPage,
  type ObservationSource,
  type ObservedThread,
} from "./observer.js";
import type { WebhookRequest } from "./webhook.js";

const start = "2026-10-11T12:00:00.000Z";
const later = "2026-10-11T12:01:00.000Z";
const old = "2026-10-01T12:00:00.000Z";
function thread(id = "thread", patch: Partial<ObservedThread> = {}): ObservedThread {
  return {
    id,
    status: "idle",
    title: id,
    workspaceId: "workspace",
    createdAt: old,
    updatedAt: old,
    attentionReason: null,
    attentionTimestamp: null,
    pendingPermissions: [],
    ...patch,
  };
}
class Source implements ObservationSource {
  agents: ObservedThread[] = [];
  histories = new Map<string, HistoryPage>();
  offline = false;
  brokenThread: string | null = null;
  pages: (string | undefined)[] = [];
  cursors: (Cursor | undefined)[] = [];
  watches = 0;
  changed: (agent: ObservedThread) => void = () => {};
  error: () => void = () => {};
  async list(cursor?: string) {
    if (this.offline) throw new Error("fixture disconnected");
    this.pages.push(cursor);
    const index = Number(cursor ?? 0);
    return {
      agents: this.agents.slice(index, index + 200),
      next: index + 200 < this.agents.length ? String(index + 200) : undefined,
    };
  }
  async history(id: string, cursor?: Cursor): Promise<HistoryPage> {
    this.cursors.push(cursor);
    if (id === this.brokenThread) throw new Error("fixture history failure");
    const page = this.histories.get(id) ?? {
      entries: [],
      endCursor: null,
      hasNewer: false,
      gap: false,
      staleCursor: false,
      reset: false,
    };
    return {
      ...page,
      entries: page.entries.filter(
        (entry) => !cursor || page.endCursor?.epoch !== cursor.epoch || entry.seqEnd > cursor.seq,
      ),
    };
  }
  async watch(changed: (agent: ObservedThread) => void, error: () => void) {
    this.watches++;
    this.changed = changed;
    this.error = error;
    return async () => {};
  }
  historyRows(id: string, types: string[], timestamp = later) {
    this.histories.set(id, {
      entries: types.map((type, index) => ({ seqEnd: index + 1, timestamp, item: { type } })),
      endCursor: { epoch: "epoch", seq: types.length },
      hasNewer: false,
      gap: false,
      staleCursor: false,
      reset: false,
    });
  }
}
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "nova-observation-"));
  const file = join(directory, "state.sqlite");
  const store = new BridgeStore(file);
  const requests: WebhookRequest[] = [];
  const now = () => Date.parse(start);
  const events = new BridgeEvents(
    store,
    async (request) => {
      const body = JSON.parse(request.body);
      if (body.type === "verification")
        return { status: 200, body: JSON.stringify({ challenge: body.challenge }) };
      requests.push(request);
      return { status: 200, body: "" };
    },
    now,
  );
  const source = new Source();
  const observer = new WorkspaceObserver("dev", "dev-server", source, store, events, now);
  cleanups.push(async () => {
    await observer.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  function activity() {
    return store.db
      .prepare("SELECT body FROM events ORDER BY seq")
      .all()
      .map((row) => JSON.parse(String(row.body)))
      .filter((event) => event.data.threadId !== null);
  }
  return { store, events, source, observer, requests, activity, now };
}
const subscription = {
  name: "vorteo.attention",
  arguments: { environments: ["dev"], workspaceIds: [] },
  delivery: {
    mode: "webhook",
    url: "https://receiver.example/events",
    secret: `whsec_${Buffer.alloc(32, 1).toString("base64")}`,
  },
};

it("catches changed older threads first seen after startup without announcing old history", async () => {
  const test = fixture();
  test.source.agents = [
    thread("old"),
    thread("changed", { updatedAt: later, attentionReason: "finished", attentionTimestamp: later }),
  ];
  test.source.historyRows("old", ["assistant_message"], old);
  test.source.historyRows("changed", ["assistant_message"]);
  await test.observer.reconcile();
  expect(test.activity().map((event) => event.data.threadId)).not.toContain("old");
  expect(test.activity().map((event) => event.data.kind)).toContain("completed");
  expect(test.activity().map((event) => event.data.kind)).toContain("changed");
});

it("observes more than 200 threads including a newly created workspace", async () => {
  const test = fixture();
  test.source.agents = Array.from({ length: 205 }, (_, index) => thread(String(index)));
  await test.observer.reconcile();
  test.source.agents[204] = thread("204", {
    workspaceId: "new-workspace",
    updatedAt: later,
    attentionReason: "permission",
    attentionTimestamp: later,
  });
  await test.observer.reconcile();
  expect(test.source.pages).toEqual([undefined, "200", undefined, "200"]);
  expect(test.activity()).toContainEqual(
    expect.objectContaining({
      data: expect.objectContaining({
        threadId: "204",
        workspaceId: "new-workspace",
        kind: "permission",
      }),
    }),
  );
});

it("retains an error followed by resumed work while disconnected and recreates a failed subscription", async () => {
  const test = fixture();
  test.source.agents = [thread()];
  await test.observer.reconcile();
  test.source.offline = true;
  test.source.error();
  await test.observer.reconcile();
  test.source.offline = false;
  test.source.historyRows("thread", ["error", "user_message", "assistant_message"]);
  test.source.agents = [thread("thread", { updatedAt: later })];
  await test.observer.reconcile();
  const activity = test.activity();
  expect(activity.map((event) => event.data.kind)).toContain("failed");
  expect(activity.map((event) => event.data.kind)).toContain("changed");
  expect(activity.map((event) => event.data.kind)).not.toContain("completed");
  expect(test.source.watches).toBe(2);
  expect(activity.find((event) => event.data.kind === "failed").data.sourceCursor).toEqual({
    epoch: "epoch",
    seq: 1,
  });
});

it("keeps a completion ID stable when unrelated snapshot fields change", async () => {
  const test = fixture();
  test.source.agents = [
    thread("thread", { updatedAt: later, attentionReason: "finished", attentionTimestamp: later }),
  ];
  await test.events.subscribe(subscription);
  await test.observer.reconcile();
  test.source.agents[0].updatedAt = "2026-10-11T12:02:00.000Z";
  await test.observer.reconcile();
  await test.events.flush();
  const completed = test.requests.filter(
    (request) => JSON.parse(request.body).data.kind === "completed",
  );
  expect(completed).toHaveLength(1);
});

it("reports history failures per thread, retries them, and continues observing other threads", async () => {
  const test = fixture();
  test.source.agents = [
    thread("broken"),
    thread("healthy", { updatedAt: later, attentionReason: "finished", attentionTimestamp: later }),
  ];
  test.source.brokenThread = "broken";
  await test.observer.reconcile();
  expect(test.activity().map((event) => event.data.kind)).toEqual(["gap", "completed"]);
  expect(test.store.db.prepare("SELECT * FROM observation_errors").all()).toHaveLength(1);
  test.source.brokenThread = null;
  await test.observer.reconcile();
  expect(test.store.db.prepare("SELECT * FROM observation_errors").all()).toHaveLength(0);
});

it("reports timeline reset without claiming a completion and retains its replacement cursor", async () => {
  const test = fixture();
  test.source.agents = [thread()];
  test.source.historyRows("thread", ["assistant_message"], old);
  await test.observer.reconcile();
  test.source.agents[0].updatedAt = later;
  test.source.histories.set("thread", {
    entries: [],
    endCursor: { epoch: "new", seq: 5 },
    gap: true,
    reset: true,
    staleCursor: true,
    hasNewer: false,
  });
  await test.observer.reconcile();
  expect(test.activity().map((event) => event.data.kind)).toEqual(["gap"]);
  const saved = test.store.db.prepare("SELECT state FROM observations").get();
  expect(JSON.parse(String(saved?.state)).cursor).toEqual({ epoch: "new", seq: 5 });
});

it("rolls back event insertion when cursor commit fails, then safely retries", async () => {
  const test = fixture();
  test.source.agents = [
    thread("thread", { updatedAt: later, attentionReason: "finished", attentionTimestamp: later }),
  ];
  test.store.db.exec(
    "CREATE TRIGGER fixture_interrupt BEFORE INSERT ON observations BEGIN SELECT RAISE(ABORT, 'interrupted'); END;",
  );
  await test.observer.reconcile();
  expect(test.store.db.prepare("SELECT * FROM observations").all()).toHaveLength(0);
  expect(test.activity().map((event) => event.data.kind)).toEqual(["gap"]);
  test.store.db.exec("DROP TRIGGER fixture_interrupt");
  await test.observer.reconcile();
  expect(test.activity().filter((event) => event.data.kind === "completed")).toHaveLength(1);
  expect(test.store.db.prepare("SELECT * FROM observations").all()).toHaveLength(1);
});

it("correlates Nova operations and reports native checklist/journal changes without executing follow-ups", async () => {
  const test = fixture();
  test.store.claim({
    operationId: "fixture-operation",
    tool: "send_agent_prompt",
    arguments: { environment: "dev", serverId: "dev-server", input: { agentId: "thread" } },
  });
  test.source.agents = [thread()];
  await test.observer.reconcile();
  test.source.agents[0].updatedAt = later;
  test.source.agents[0].journal = [
    {
      id: "00000000-0000-4000-8000-000000000001",
      sequence: 1,
      timestamp: later,
      text: "Blocked on required owner setup",
    },
  ];
  await test.observer.reconcile();
  expect(test.activity()).toHaveLength(1);
  expect(test.activity()[0].data.operationIds).toEqual(["fixture-operation"]);
  expect(test.activity()[0].data.kind).toBe("changed");
  expect(test.store.operation("fixture-operation").status).toBe("running");
});

it("catches settled timeline work beyond the live window without replaying it", async () => {
  const test = fixture();
  test.source.agents = Array.from({ length: 205 }, (_, index) => thread(String(index)));
  await test.observer.reconcile();
  test.source.agents[204] = thread("204", { updatedAt: later });
  test.source.historyRows("204", ["assistant_message"]);
  await test.observer.reconcile();
  expect(test.activity().filter((event) => event.data.threadId === "204")).toHaveLength(1);
  await test.observer.reconcile();
  expect(test.activity().filter((event) => event.data.threadId === "204")).toHaveLength(1);
});

it("delivers factual evidence summaries without behavioral instructions", async () => {
  const test = fixture();
  await test.events.subscribe(subscription);
  test.source.agents = [
    thread("complete", {
      updatedAt: later,
      attentionReason: "finished",
      attentionTimestamp: later,
    }),
    thread("permission", {
      updatedAt: later,
      attentionReason: "permission",
      attentionTimestamp: later,
    }),
    thread("error", { updatedAt: later }),
    thread("gap", { updatedAt: later }),
  ];
  test.source.historyRows("error", ["error"]);
  test.source.histories.set("gap", {
    entries: [],
    endCursor: { epoch: "new", seq: 3 },
    hasNewer: false,
    gap: true,
    staleCursor: true,
    reset: true,
  });
  await test.observer.reconcile();
  await test.events.flush();
  const summaries = test.requests.map((request) => JSON.parse(request.body).data.summary);
  expect(summaries).toEqual(
    expect.arrayContaining([
      "Thread has completed activity.",
      "Thread has permission activity.",
      "Retained timeline contains an error. Current task state may have changed.",
      "Retained timeline has a gap or reset. Missed transitions are unknown.",
    ]),
  );
  for (const summary of summaries)
    expect(summary).not.toMatch(/\b(read|inspect|use|act|follow|deduplicate)\b/i);
});
