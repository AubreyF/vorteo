import { expect, it } from "vitest";
import { DaemonConnection, type DaemonPorts, type ReadClient, type ToolSession } from "./daemon.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

function unavailable(): never {
  throw new Error("Unused read method");
}
const read: ReadClient = {
  fetchAgents: unavailable,
  fetchWorkspaces: unavailable,
  fetchAgentTimeline: unavailable,
  searchAgentTimeline: unavailable,
  readFile: unavailable,
  getCheckoutDiff: unavailable,
  observeAgents: unavailable,
};
class Ports implements DaemonPorts {
  read = read;
  online = true;
  identity: string | null = "server";
  attempts = 0;
  opened = 0;
  closed = 0;
  connectFails = false;
  repeatCursor = false;
  writeFails = false;
  cursors: (string | undefined)[] = [];
  inputs: unknown[] = [];
  async connect() {
    this.attempts++;
    if (this.connectFails) throw new Error("offline");
  }
  connected() {
    return this.online;
  }
  serverId() {
    return this.identity;
  }
  async close() {}
  async openTools(): Promise<ToolSession> {
    this.opened++;
    return {
      list: async (cursor) => {
        this.cursors.push(cursor);
        const tools: Tool[] = [
          {
            name: cursor ? "send_agent_prompt" : "get_agent_status",
            inputSchema: { type: "object" },
          },
        ];
        return { tools, nextCursor: !cursor || this.repeatCursor ? "next" : undefined };
      },
      call: async (name, input) => {
        this.inputs.push({ name, input });
        if (this.writeFails) throw new Error("lost response");
        return { content: [], isError: false };
      },
      close: async () => {
        this.closed++;
      },
    };
  }
}
function connection(ports: Ports) {
  return new DaemonConnection(
    { endpoint: "127.0.0.1:1", password: "fixture", serverId: "server" },
    ports,
  );
}

it("checks connection and exact identity before opening the native tool session", async () => {
  const ports = new Ports();
  const daemon = connection(ports);
  ports.identity = "other";
  await expect(daemon.callTool("send_agent_prompt", {})).rejects.toThrow("identity");
  ports.identity = "server";
  ports.online = false;
  await expect(daemon.listTools()).rejects.toThrow("disconnected");
  expect(ports.opened).toBe(0);
});
it("retries initial connection failures and observes automatic socket reconnection", async () => {
  const ports = new Ports();
  const daemon = connection(ports);
  ports.connectFails = true;
  await expect(daemon.readClient()).rejects.toThrow("offline");
  ports.connectFails = false;
  expect(await daemon.readClient()).toBe(read);
  ports.online = false;
  await expect(daemon.readClient()).rejects.toThrow("disconnected");
  ports.online = true;
  expect(await daemon.readClient()).toBe(read);
  expect(ports.attempts).toBe(2);
});
it("pages the native catalog, refuses nonprogress, and always closes the session", async () => {
  const ports = new Ports();
  const daemon = connection(ports);
  expect((await daemon.listTools()).map((tool) => tool.name)).toEqual([
    "get_agent_status",
    "send_agent_prompt",
  ]);
  expect(ports.cursors).toEqual([undefined, "next"]);
  ports.repeatCursor = true;
  await expect(daemon.listTools()).rejects.toThrow("Repeated");
  expect(ports.closed).toBe(2);
});
it("forwards the native write once and leaves transport uncertainty to the durable receipt layer", async () => {
  const ports = new Ports();
  ports.writeFails = true;
  await expect(
    connection(ports).callTool("send_agent_prompt", { agentId: "thread", prompt: "fixture" }),
  ).rejects.toThrow("lost response");
  expect(ports.inputs).toEqual([
    { name: "send_agent_prompt", input: { agentId: "thread", prompt: "fixture" } },
  ]);
  expect(ports.closed).toBe(1);
});

it("uses current paginated inventory and canonical after-cursor contracts for observation", async () => {
  const { daemonObservationSource } = await import("./observer.js");
  const ports = new Ports();
  const queries: unknown[] = [];
  ports.read = {
    ...read,
    fetchAgents: async (options) => {
      queries.push(options);
      return {
        requestId: "fixture",
        entries: [],
        pageInfo: { hasMore: true, nextCursor: "page-2", prevCursor: null },
      };
    },
    fetchAgentTimeline: async (agentId, options) => {
      queries.push({ agentId, options });
      return {
        requestId: "fixture",
        agentId,
        agent: null,
        direction: "after",
        projection: "canonical",
        epoch: "epoch",
        reset: false,
        staleCursor: false,
        gap: false,
        window: { minSeq: 1, maxSeq: 2, nextSeq: 3 },
        startCursor: null,
        endCursor: { epoch: "epoch", seq: 2 },
        hasOlder: false,
        hasNewer: false,
        entries: [],
        error: null,
      };
    },
  };
  const source = daemonObservationSource(connection(ports));
  expect(await source.list("page-1")).toEqual({ agents: [], next: "page-2" });
  await source.history("thread", { epoch: "epoch", seq: 1 });
  expect(queries).toEqual([
    { filter: { includeArchived: true }, page: { limit: 200, cursor: "page-1" } },
    {
      agentId: "thread",
      options: {
        projection: "canonical",
        limit: 100,
        direction: "after",
        cursor: { epoch: "epoch", seq: 1 },
      },
    },
  ]);
});
