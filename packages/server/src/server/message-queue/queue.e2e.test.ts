import { expect, it } from "vitest";
import type { QueueSnapshot } from "@getpaseo/protocol/message-queue";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentPromptInput } from "../agent/agent-sdk-types.js";
import { TaskOwnerEvidenceStore } from "../authorization/task-owner-evidence.js";

it("retains authenticated queued text and edits before delivery without replaying evidence", async () => {
  const daemon = await createTestPaseoDaemon({ agentClients: createTestAgentClients() });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.7.2" });
  try {
    await client.connect();
    const agent = await client.createAgent({
      config: { provider: "codex", cwd: daemon.paseoHome },
    });
    const evidence = new TaskOwnerEvidenceStore(daemon.paseoHome);
    await client.mutateMessageQueue(agent.id, {
      kind: "pause",
      operationId: "pause-evidence",
      expectedRevision: 0,
      paused: true,
    });
    const enqueue = {
      kind: "enqueue" as const,
      operationId: "owner-enqueue",
      messageId: "owner-message",
      text: "Draft only",
      attachments: [],
    };
    expect((await client.mutateMessageQueue(agent.id, enqueue)).error).toBeNull();
    expect((await client.mutateMessageQueue(agent.id, enqueue)).error).toBeNull();
    const edit = {
      kind: "edit" as const,
      operationId: "owner-edit",
      messageId: "owner-message",
      expectedRevision: 0,
      text: "Stop work",
      attachments: [],
    };
    expect((await client.mutateMessageQueue(agent.id, edit)).error).toBeNull();
    expect(
      (
        await client.mutateMessageQueue(agent.id, {
          ...edit,
          operationId: "stale-edit",
          text: "Ship production",
        })
      ).error?.code,
    ).toBe("revision_conflict");
    expect(
      (
        await client.mutateMessageQueue(agent.id, {
          kind: "delete",
          operationId: "owner-delete",
          messageId: "owner-message",
          expectedRevision: 1,
        })
      ).error,
    ).toBeNull();
    const records = await evidence.list(agent.id);
    expect(records.map((record) => [record.text, record.queueOperation?.kind])).toEqual([
      ["", "pause"],
      ["Draft only", "enqueue"],
      ["Stop work", "edit"],
      ["", "delete"],
    ]);
    expect(records.every((record) => record.principalId === "owner")).toBe(true);
    expect(await evidence.list("unrelated-task")).toEqual([]);
  } finally {
    await client.close();
    await daemon.close();
  }
});

it("send now interrupts the observed permission-blocked turn", async () => {
  const received: AgentPromptInput[] = [];
  const daemon = await createTestPaseoDaemon({
    agentClients: createTestAgentClients({ onStartTurn: (prompt) => received.push(prompt) }),
  });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.7.2" });
  try {
    await client.connect();
    const agent = await client.createAgent({
      config: { provider: "codex", cwd: daemon.paseoHome },
    });
    await client.mutateMessageQueue(agent.id, {
      kind: "pause",
      operationId: "pause",
      expectedRevision: 0,
      paused: true,
    });
    await client.mutateMessageQueue(agent.id, {
      kind: "enqueue",
      operationId: "add",
      messageId: "selected",
      text: "selected message",
      attachments: [],
    });
    await client.sendAgentMessage(agent.id, 'printf "ok" > permission.txt');
    await expect
      .poll(() => daemon.daemon.agentManager.getAgent(agent.id)?.pendingPermissions.size)
      .toBe(1);
    const expectedTurnId = daemon.daemon.agentManager.getAgent(agent.id)?.activeTurnId;
    if (!expectedTurnId) throw new Error("Expected a running provider turn");
    expect(
      (
        await client.mutateMessageQueue(agent.id, {
          kind: "send_now",
          operationId: "send",
          messageId: "selected",
          expectedRevision: 0,
          expectedTurnId,
        })
      ).error,
    ).toBeNull();
    await expect.poll(() => received).toEqual(['printf "ok" > permission.txt', "selected message"]);
    await expect
      .poll(async () => (await client.readMessageQueue(agent.id)).snapshot?.items.length)
      .toBe(0);
    expect((await client.readMessageQueue(agent.id)).snapshot?.paused).toBe(true);
  } finally {
    await client.close();
    await daemon.close();
  }
}, 60_000);

it("sends the selected paused message once and rejects an outdated expected turn", async () => {
  const received: AgentPromptInput[] = [];
  const daemon = await createTestPaseoDaemon({
    agentClients: createTestAgentClients({ onStartTurn: (prompt) => received.push(prompt) }),
  });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.7.2" });
  try {
    await client.connect();
    const agent = await client.createAgent({
      config: { provider: "codex", cwd: daemon.paseoHome, modeId: "bypassPermissions" },
    });
    await client.mutateMessageQueue(agent.id, {
      kind: "pause",
      operationId: "pause",
      expectedRevision: 0,
      paused: true,
    });
    for (const id of ["first", "selected"])
      await client.mutateMessageQueue(agent.id, {
        kind: "enqueue",
        operationId: id,
        messageId: id,
        text: id,
        attachments: [],
      });
    const request = {
      kind: "send_now" as const,
      operationId: "send",
      messageId: "selected",
      expectedRevision: 0,
      expectedTurnId: null,
    };
    expect((await client.mutateMessageQueue(agent.id, request)).error).toBeNull();
    await expect.poll(() => received).toEqual(["selected"]);
    await expect.poll(() => daemon.daemon.agentManager.getAgent(agent.id)?.lifecycle).toBe("idle");
    await client.mutateMessageQueue(agent.id, request);
    const snapshot = (await client.readMessageQueue(agent.id)).snapshot;
    expect(snapshot).toMatchObject({ paused: true, items: [{ id: "first" }] });
    expect(snapshot?.items).toHaveLength(1);
    await client.mutateMessageQueue(agent.id, {
      kind: "send_now",
      operationId: "stale",
      messageId: "first",
      expectedRevision: 0,
      expectedTurnId: "old-turn",
    });
    await expect
      .poll(
        async () => (await client.readMessageQueue(agent.id)).snapshot?.items[0].delivery.status,
      )
      .toBe("failed");
    expect(received).toEqual(["selected"]);
  } finally {
    await client.close();
    await daemon.close();
  }
}, 60_000);

it.each([false, true])(
  "synchronizes two devices and retains queues (owned subscriptions: %s)",
  async (owned) => {
    const daemon = await createTestPaseoDaemon();
    const options = {
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      appVersion: "0.9.0-beta.2",
      capabilities: { owned_subscriptions: owned },
    };
    const first = new DaemonClient(options);
    const second = new DaemonClient(options);
    const reloaded = new DaemonClient(options);
    try {
      await first.connect();
      await second.connect();
      const agent = await first.createAgent({
        config: { provider: "codex", cwd: daemon.paseoHome },
      });
      await first.mutateMessageQueue(agent.id, {
        kind: "pause",
        operationId: "pause",
        paused: true,
        expectedRevision: 0,
      });
      const observed: QueueSnapshot[] = [];
      second.subscribe((event) => {
        if (event.type === "agent.queue.changed") observed.push(event.payload);
      });
      expect(
        (await second.subscribeMessageQueue({ agentId: agent.id, subscribed: true })).error,
      ).toBeNull();
      const added = await first.mutateMessageQueue(agent.id, {
        kind: "enqueue",
        operationId: "enqueue",
        messageId: "message",
        text: "Continue after this turn",
        attachments: [],
      });
      expect(added.error).toBeNull();
      await expect.poll(() => observed.length).toBe(1);
      expect(observed[0]).toMatchObject(added.snapshot!);
      const edited = await second.mutateMessageQueue(agent.id, {
        kind: "edit",
        operationId: "edit",
        messageId: "message",
        expectedRevision: 0,
        text: "Updated on the second device",
        attachments: [],
      });
      expect(edited.error).toBeNull();
      const conflict = await first.mutateMessageQueue(agent.id, {
        kind: "edit",
        operationId: "stale-edit",
        messageId: "message",
        expectedRevision: 0,
        text: "stale",
        attachments: [],
      });
      expect(conflict.error?.code).toBe("revision_conflict");
      await first.close();
      await second.close();
      await reloaded.connect();
      const snapshot = await reloaded.readMessageQueue(agent.id);
      expect(snapshot.error).toBeNull();
      expect(snapshot.snapshot?.items).toMatchObject([
        { id: "message", text: "Updated on the second device" },
      ]);
    } finally {
      await Promise.all([first.close(), second.close(), reloaded.close()]);
      await daemon.close();
    }
  },
  60_000,
);

it("restores accepted prompts and their attachment references after a daemon restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "paseo-queue-history-"));
  const settings = { paseoHomeRoot: root, cleanup: false };
  let daemon = await createTestPaseoDaemon(settings);
  const staticDirs = [daemon.staticDir];
  let client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.7.2" });
  try {
    await client.connect();
    const agent = await client.createAgent({
      config: { provider: "codex", cwd: daemon.paseoHome, modeId: "bypassPermissions" },
    });
    const upload = await client.uploadFile({
      fileName: "notes.txt",
      mimeType: "text/plain",
      bytes: Buffer.from("retained notes"),
    });
    if (!upload.file) throw new Error("Expected uploaded notes");
    const attachmentId = upload.file.id;
    const added = await client.mutateMessageQueue(agent.id, {
      kind: "enqueue",
      operationId: "add",
      messageId: "queued-history",
      text: "Remember these notes",
      attachments: [{ ...upload.file, kind: "file" }],
    });
    expect(added.error).toBeNull();
    await expect
      .poll(async () => (await client.readMessageQueue(agent.id)).snapshot?.items.length)
      .toBe(0);
    await expect.poll(() => daemon.daemon.agentManager.getAgent(agent.id)?.lifecycle).toBe("idle");
    const before = await client.fetchAgentTimeline(agent.id);
    expect(
      before.entries.find(
        (entry) =>
          entry.item.type === "user_message" && entry.item.clientMessageId === "queued-history",
      )?.item,
    ).toMatchObject({
      messageId: "queued-history",
      queue: { attachments: [{ id: attachmentId }] },
    });
    await daemon.daemon.agentManager.flush();
    await daemon.daemon.agentStorage.flush();
    await client.close();
    await daemon.close();
    daemon = await createTestPaseoDaemon(settings);
    staticDirs.push(daemon.staticDir);
    client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.7.2" });
    await client.connect();
    const after = await client.fetchAgentTimeline(agent.id);
    expect(after.error).toBeNull();
    const messages = after.entries.filter(
      (entry) =>
        entry.item.type === "user_message" && entry.item.clientMessageId === "queued-history",
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].item).toMatchObject({
      text: "Remember these notes",
      messageId: "queued-history",
      queue: { attachments: [{ id: attachmentId }] },
    });
    const shared = await client.getMessageQueueAttachment({
      agentId: agent.id,
      messageId: "queued-history",
      attachmentId,
    });
    if (!shared.file) throw new Error("Expected retained attachment");
    expect(
      Buffer.from((await client.readFile(shared.file.cwd, shared.file.path)).bytes).toString(),
    ).toBe("retained notes");
  } finally {
    await client.close();
    await daemon.close();
    await Promise.all(
      [root, ...staticDirs].map((directory) => rm(directory, { recursive: true, force: true })),
    );
  }
}, 60_000);

it("shares captured files and images and delivers them after the original uploads are removed", async () => {
  const received: AgentPromptInput[] = [];
  const daemon = await createTestPaseoDaemon({
    agentClients: createTestAgentClients({ onStartTurn: (prompt) => received.push(prompt) }),
  });
  const options = {
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.9.0-beta.2",
    capabilities: { owned_subscriptions: true },
  };
  const first = new DaemonClient(options);
  const second = new DaemonClient(options);
  try {
    await first.connect();
    await second.connect();
    const agent = await first.createAgent({
      config: { provider: "codex", cwd: daemon.paseoHome, modeId: "bypassPermissions" },
    });
    await first.mutateMessageQueue(agent.id, {
      kind: "pause",
      operationId: "pause",
      paused: true,
      expectedRevision: 0,
    });
    const image = await first.uploadFile({
      fileName: "image.png",
      mimeType: "image/png",
      bytes: Buffer.from("image bytes"),
    });
    const notes = await first.uploadFile({
      fileName: "notes.txt",
      mimeType: "text/plain",
      bytes: Buffer.from("saved notes"),
    });
    if (!image.file || !notes.file) throw new Error("Expected uploaded files");
    const queued = await first.mutateMessageQueue(agent.id, {
      kind: "enqueue",
      operationId: "add",
      messageId: "message",
      text: "Inspect these",
      context: [{ type: "text", mimeType: "text/plain", text: "captured context" }],
      attachments: [
        { ...image.file, kind: "image" },
        { ...notes.file, kind: "file" },
      ],
    });
    expect(queued.error).toBeNull();
    await Promise.all([rm(image.file.path), rm(notes.file.path)]);
    await first.close();
    const shared = await second.getMessageQueueAttachment({
      agentId: agent.id,
      messageId: "message",
      attachmentId: notes.file.id,
    });
    if (!shared.file) throw new Error(shared.error?.message ?? "Expected shared attachment");
    const tokenResult = await second.getMessageQueueAttachment({
      agentId: agent.id,
      messageId: "message",
      attachmentId: notes.file.id,
      download: true,
    });
    expect(tokenResult.file?.downloadToken).toBeTruthy();
    const url = `http://127.0.0.1:${daemon.port}/api/files/download?token=${tokenResult.file?.downloadToken}`;
    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toContain(notes.file.fileName);
    expect(response.headers.get("content-type")).toContain(notes.file.mimeType);
    expect(await response.text()).toBe("saved notes");
    expect((await fetch(url)).status).toBe(403);
    const downloaded = await second.readFile(shared.file.cwd, shared.file.path);
    expect(Buffer.from(downloaded.bytes).toString()).toBe("saved notes");
    const snapshot = (await second.readMessageQueue(agent.id)).snapshot;
    if (!snapshot) throw new Error("Expected queue");
    await second.mutateMessageQueue(agent.id, {
      kind: "pause",
      operationId: "resume",
      paused: false,
      expectedRevision: snapshot.revision,
    });
    await expect.poll(() => received.length).toBe(1);
    expect(received[0]).toMatchObject([
      { type: "text", text: "Inspect these" },
      { type: "text", text: "captured context" },
      { type: "image", data: Buffer.from("image bytes").toString("base64") },
      { type: "uploaded_file", fileName: "notes.txt" },
    ]);
    await expect
      .poll(async () => (await second.readMessageQueue(agent.id)).snapshot?.items.length)
      .toBe(0);
    expect(
      (
        await second.getMessageQueueAttachment({
          agentId: agent.id,
          messageId: "message",
          attachmentId: image.file.id,
        })
      ).error,
    ).toBeNull();
    expect(
      (
        await second.getMessageQueueAttachment({
          agentId: agent.id,
          messageId: "unrelated",
          attachmentId: image.file.id,
        })
      ).error?.code,
    ).toBe("missing");
  } finally {
    await Promise.all([first.close(), second.close()]);
    await daemon.close();
  }
}, 60_000);

it.each([false, true])(
  "manual stop preserves queue paused=%s",
  async (paused) => {
    const received: string[] = [];
    const daemon = await createTestPaseoDaemon({
      agentClients: createTestAgentClients({
        onStartTurn: (prompt) => {
          if (typeof prompt === "string") received.push(prompt);
        },
      }),
    });
    const client = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      appVersion: "0.7.2",
    });
    try {
      await client.connect();
      const agent = await client.createAgent({
        config: { provider: "codex", cwd: daemon.paseoHome, modeId: "bypassPermissions" },
      });
      if (paused)
        await client.mutateMessageQueue(agent.id, {
          kind: "pause",
          operationId: "owner-pause",
          paused: true,
          expectedRevision: 0,
        });
      await client.cancelAgent(agent.id);
      const queued = await client.mutateMessageQueue(agent.id, {
        kind: "enqueue",
        operationId: "add",
        messageId: "message",
        text: "after manual stop",
        attachments: [],
      });
      expect(queued.error).toBeNull();
      expect(queued.snapshot?.paused).toBe(paused);
      if (paused) {
        expect(received).toEqual([]);
        const snapshot = queued.snapshot;
        if (!snapshot) throw new Error("Expected queued message");
        const resumed = await client.mutateMessageQueue(agent.id, {
          kind: "pause",
          operationId: "resume",
          paused: false,
          expectedRevision: snapshot.revision,
        });
        expect(resumed.error).toBeNull();
      }
      await expect.poll(() => received).toEqual(["after manual stop"]);
    } finally {
      await client.close();
      await daemon.close();
    }
  },
  60_000,
);

it("continues ordered delivery after the originating client closes", async () => {
  let release!: () => void;
  let signalEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    signalEntered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const received: string[] = [];
  const clients = createTestAgentClients({
    onStartTurn: (prompt) => {
      if (typeof prompt === "string") received.push(prompt);
    },
  });
  const createSession = clients.codex.createSession.bind(clients.codex);
  clients.codex.createSession = async (config) => {
    const session = await createSession(config);
    const startTurn = session.startTurn.bind(session);
    session.startTurn = async (prompt, options) => {
      if (prompt === "first queued message") {
        signalEntered();
        await gate;
      }
      return startTurn(prompt, options);
    };
    return session;
  };
  const daemon = await createTestPaseoDaemon({ agentClients: clients });
  const options = {
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.9.0-beta.2",
    capabilities: { owned_subscriptions: true },
  };
  const first = new DaemonClient(options);
  const reloaded = new DaemonClient(options);
  try {
    await first.connect();
    const agent = await first.createAgent({
      config: { provider: "codex", cwd: daemon.paseoHome, modeId: "bypassPermissions" },
    });
    const added = await first.mutateMessageQueue(agent.id, {
      kind: "enqueue",
      operationId: "add-first",
      messageId: "first",
      text: "first queued message",
      attachments: [],
    });
    expect(added.error).toBeNull();
    await entered;
    expect(
      (
        await first.mutateMessageQueue(agent.id, {
          kind: "enqueue",
          operationId: "add-second",
          messageId: "second",
          text: "second queued message",
          attachments: [],
        })
      ).error,
    ).toBeNull();
    await first.close();
    release();
    await expect
      .poll(() => received, { timeout: 10_000 })
      .toEqual(["first queued message", "second queued message"]);
    await reloaded.connect();
    await expect
      .poll(async () => (await reloaded.readMessageQueue(agent.id)).snapshot?.items.length)
      .toBe(0);
  } finally {
    release();
    await Promise.all([first.close(), reloaded.close()]);
    await daemon.close();
  }
}, 60_000);
