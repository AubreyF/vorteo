import { expect, it } from "vitest";
import { legacyImportOperationId } from "./legacy";
import { QueueOutbox, type QueueOutboxPort } from "./outbox";
import { encodeOutboxKey, type OutboxRecord, type OutboxStorage } from "./outbox-record";
import type { QueueOperation } from "@getpaseo/protocol/message-queue";

function memoryStorage(): OutboxStorage {
  const records = new Map<string, OutboxRecord>();
  return {
    list: async () => structuredClone([...records.values()]),
    read: async (key) => structuredClone(records.get(encodeOutboxKey(key)) ?? null),
    exchange: async (key, revision, value) => {
      const id = encodeOutboxKey(key);
      if ((records.get(id)?.revision ?? null) !== revision) return false;
      if (value) records.set(id, structuredClone(value));
      else records.delete(id);
      return true;
    },
  };
}

const operation: QueueOperation = {
  kind: "enqueue",
  operationId: "op",
  messageId: "message",
  text: "Continue",
  attachments: [],
};
const input = { serverId: "host", agentId: "agent", createdAt: 1, operation, localAttachments: [] };
const snapshot = { agentId: "agent", revision: 1, paused: false, items: [] };
const port: QueueOutboxPort = {
  upload: async () => {
    throw new Error("Unexpected upload");
  },
  mutate: async () => ({ snapshot, error: null }),
  changed: () => {},
};

it("keeps a rejected edit locally while allowing later messages to synchronize", async () => {
  const storage = memoryStorage();
  const outbox = new QueueOutbox(storage, {
    ...port,
    mutate: async (_host, _agent, request) =>
      request.kind === "edit"
        ? {
            snapshot: null,
            error: { code: "revision_conflict", message: "Edited on another device" },
          }
        : { snapshot, error: null },
  });
  const edit: QueueOperation = { ...operation, kind: "edit", expectedRevision: 0 };
  await outbox.commit({ ...input, operation: edit });
  await outbox.commit({
    ...input,
    createdAt: 2,
    operation: { ...operation, operationId: "later" },
  });
  await outbox.flush("host");
  expect(await outbox.list()).toHaveLength(2);
  const key = { serverId: "host", agentId: "agent", operationId: "op" };
  await outbox.keepRejectedCopy(key);
  await outbox.flush("host");
  expect(await outbox.list()).toMatchObject([{ operation: { text: "Continue" }, dismissed: true }]);
  await outbox.retry(key);
  expect((await outbox.list())[0].dismissed).toBe(true);
  await outbox.removeRejectedCopy(key);
  expect(await outbox.list()).toEqual([]);
});

it("does not dismiss a change whose host outcome is uncertain", async () => {
  const outbox = new QueueOutbox(memoryStorage(), {
    ...port,
    mutate: async () => ({
      snapshot: null,
      error: { code: "queue_unavailable", message: "Commit status unknown" },
    }),
  });
  await outbox.commit({ ...input, operation: { ...operation, kind: "edit", expectedRevision: 0 } });
  await outbox.flush("host");
  await expect(
    outbox.keepRejectedCopy({ serverId: "host", agentId: "agent", operationId: "op" }),
  ).rejects.toThrow("Only a rejected change");
  expect(await outbox.list()).toHaveLength(1);
});

it("allows deletion to free a full queue while preserving the rejected enqueue", async () => {
  const sent: string[] = [];
  const outbox = new QueueOutbox(memoryStorage(), {
    ...port,
    mutate: async (_host, _agent, request) => {
      sent.push(request.kind);
      return request.kind === "enqueue"
        ? { snapshot: null, error: { code: "full", message: "Queue full" } }
        : { snapshot, error: null };
    },
  });
  await outbox.commit(input);
  await outbox.commit({
    ...input,
    createdAt: 2,
    operation: {
      kind: "delete",
      operationId: "remove",
      messageId: "existing",
      expectedRevision: 0,
    },
  });
  await outbox.flush("host");
  expect(sent).toEqual(["enqueue", "delete"]);
  expect(await outbox.list()).toMatchObject([{ operation, error: { code: "full" } }]);
});

it.each([operation, { ...operation, operationId: legacyImportOperationId(operation.messageId) }])(
  "retains the exact operation across reload after a lost acknowledgement: %j",
  async (savedOperation) => {
    const storage = memoryStorage();
    const sent: QueueOperation[] = [];
    const cleaned: string[] = [];
    const first = new QueueOutbox(storage, {
      ...port,
      acknowledged: async (record) => {
        cleaned.push(record.operation.operationId);
      },
      mutate: async (_host, _agent, request) => {
        sent.push(request);
        throw new Error("Disconnected after durable host commit");
      },
    });
    await first.commit({ ...input, operation: savedOperation });
    await expect(first.flush("host")).rejects.toThrow("Disconnected");
    expect(await first.list()).toHaveLength(1);
    expect(cleaned).toEqual([]);
    const reloaded = new QueueOutbox(storage, {
      ...port,
      acknowledged: async (record) => {
        expect(await storage.list()).toEqual([]);
        cleaned.push(record.operation.operationId);
      },
      mutate: async (_host, _agent, request) => {
        sent.push(request);
        return { snapshot, error: null };
      },
    });
    await reloaded.flush("host");
    expect(sent).toEqual([savedOperation, savedOperation]);
    expect(await reloaded.list()).toEqual([]);
    expect(cleaned).toEqual([savedOperation.operationId]);
  },
);

it("does not acknowledge a local commit when storage fails", async () => {
  const storage = memoryStorage();
  const outbox = new QueueOutbox(
    {
      ...storage,
      exchange: async () => {
        throw new Error("Storage full");
      },
    },
    port,
  );
  await expect(outbox.commit(input)).rejects.toThrow("Storage full");
  expect(await storage.list()).toEqual([]);
});

it("competing tabs send only the winning persisted attachment IDs", async () => {
  const storage = memoryStorage();
  let uploaded = 0;
  const sent: QueueOperation[] = [];
  let release!: () => void;
  const bothUploading = new Promise<void>((resolve) => {
    release = resolve;
  });
  const sharedPort: QueueOutboxPort = {
    ...port,
    upload: async () => {
      const id = `upload-${++uploaded}`;
      if (uploaded === 2) release();
      await bothUploading;
      return { id, kind: "image", fileName: "image.png", mimeType: "image/png", size: 4 };
    },
    mutate: async (_host, _agent, request) => {
      sent.push(request);
      return { snapshot, error: null };
    },
  };
  const first = new QueueOutbox(storage, sharedPort);
  const second = new QueueOutbox(storage, sharedPort);
  await first.commit({
    ...input,
    localAttachments: [
      {
        kind: "image",
        metadata: {
          id: "local",
          mimeType: "image/png",
          storageType: "web-indexeddb",
          storageKey: "local",
          createdAt: 1,
        },
      },
    ],
  });
  await Promise.all([first.flush("host"), second.flush("host")]);
  expect(uploaded).toBe(2);
  expect(sent).toHaveLength(2);
  expect(sent[0]).toEqual(sent[1]);
  expect(await first.list()).toEqual([]);
});

it("keeps rejected content visible and blocks later operations for the same task", async () => {
  const storage = memoryStorage();
  const rejected = {
    code: "revision_conflict",
    message: "The message was edited on another device",
  };
  const sent: string[] = [];
  const outbox = new QueueOutbox(storage, {
    ...port,
    mutate: async (_host, agentId, request) => {
      sent.push(request.operationId);
      return agentId === "agent"
        ? { snapshot: null, error: rejected }
        : { snapshot: { ...snapshot, agentId }, error: null };
    },
  });
  await outbox.commit(input);
  await outbox.commit({
    ...input,
    createdAt: 2,
    operation: { ...operation, operationId: "later" },
  });
  await outbox.commit({
    ...input,
    agentId: "other",
    createdAt: 3,
    operation: { ...operation, operationId: "other" },
  });
  await outbox.flush("host");
  expect(sent).toEqual(["op", "other"]);
  expect(
    (await outbox.list()).map(({ operation: request, error }) => [request.operationId, error]),
  ).toEqual([
    ["op", rejected],
    ["later", null],
  ]);
});

it("notifies after durable commit and does not request retries for delivery results", async () => {
  const changes: boolean[] = [];
  const storage = memoryStorage();
  const outbox = new QueueOutbox(storage, {
    ...port,
    localChanged: (_server, flush) => {
      changes.push(flush);
    },
  });
  await outbox.commit(input);
  expect(
    await storage.read({ serverId: "host", agentId: "agent", operationId: "op" }),
  ).not.toBeNull();
  expect(changes).toEqual([true]);
  await outbox.flush("host");
  expect(changes).toEqual([true, false]);
  await outbox.flush("host");
  expect(changes).toEqual([true, false]);
});

it("does not report a persisted submission as failed when notification fails", async () => {
  const outbox = new QueueOutbox(memoryStorage(), {
    ...port,
    localChanged: () => {
      throw new Error("Broadcast unavailable");
    },
  });
  await expect(outbox.commit(input)).resolves.toBeUndefined();
  expect(await outbox.list()).toHaveLength(1);
});

it("discards attachment bytes only after explicit removal of a rejected local copy", async () => {
  const cleaned: OutboxRecord[] = [];
  const localAttachments: OutboxRecord["localAttachments"] = [
    {
      kind: "image",
      metadata: {
        id: "image",
        storageType: "web-indexeddb",
        storageKey: "image",
        mimeType: "image/png",
        createdAt: 1,
        byteSize: 3,
      },
    },
  ];
  const outbox = new QueueOutbox(memoryStorage(), {
    ...port,
    upload: async () => ({
      id: "remote",
      kind: "image",
      fileName: "image.png",
      mimeType: "image/png",
      size: 3,
      path: "/tmp/image.png",
    }),
    mutate: async () => ({
      snapshot: null,
      error: { code: "revision_conflict", message: "Another edit won" },
    }),
    discarded: async (record) => {
      cleaned.push(record);
    },
  });
  const key = { serverId: "host", agentId: "agent", operationId: "op" };
  await outbox.commit({
    ...input,
    operation: { ...operation, kind: "edit", expectedRevision: 0 },
    localAttachments,
  });
  await expect(outbox.removeRejectedCopy(key)).rejects.toThrow("unsynchronized");
  expect(cleaned).toEqual([]);
  await outbox.flush("host");
  await outbox.keepRejectedCopy(key);
  expect(cleaned).toEqual([]);
  await outbox.removeRejectedCopy(key);
  expect(await outbox.list()).toEqual([]);
  expect(cleaned[0].localAttachments).toEqual(localAttachments);
});
