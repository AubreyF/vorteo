import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BridgeStore } from "./store.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});

describe("durable operation receipts", () => {
  it("retains completed writes and rejects reuse for a different action", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "nova-bridge-"));
    directories.push(directory);
    const file = path.join(directory, "bridge.sqlite");
    const store = new BridgeStore(file);
    const input = { operationId: "one", tool: "send_thread_message", arguments: { text: "hello" } };
    expect(store.claim(input)).toMatchObject({
      claimed: true,
      operation: {
        id: "one",
        status: "running",
        result: null,
        tool: "send_thread_message",
        request: { text: "hello" },
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      },
    });
    store.finish("one", { sent: true });
    store.close();
    const reopened = new BridgeStore(file);
    expect(reopened.claim(input)).toMatchObject({
      claimed: false,
      operation: { id: "one", status: "succeeded", result: { sent: true } },
    });
    expect(() => reopened.claim({ ...input, arguments: { text: "different" } })).toThrow(
      "Operation ID already belongs to another request",
    );
    reopened.close();
  });

  it("refuses a concurrent writer instead of invalidating its in-flight operation", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "nova-bridge-"));
    directories.push(directory);
    const file = path.join(directory, "bridge.sqlite");
    const store = new BridgeStore(file);
    store.claim({ operationId: "running", tool: "create_thread", arguments: {} });
    expect(() => new BridgeStore(file)).toThrow("locked");
    expect(store.operation("running").status).toBe("running");
    store.close();
  });

  it("marks interrupted writes unknown and never dispatches them again", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "nova-bridge-"));
    directories.push(directory);
    const file = path.join(directory, "bridge.sqlite");
    const input = {
      operationId: "two",
      tool: "create_thread",
      arguments: { workspaceId: "workspace" },
    };
    const store = new BridgeStore(file);
    store.claim(input);
    store.close();
    const reopened = new BridgeStore(file);
    expect(reopened.claim(input)).toMatchObject({
      claimed: false,
      operation: { id: "two", status: "unknown", result: null },
    });
    reopened.close();
  });
});
