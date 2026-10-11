import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { createBridgeServer, PROTOCOL_VERSION } from "./server.js";

const servers: ReturnType<typeof createBridgeServer>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      }),
    );
  }
});

async function start() {
  const server = createBridgeServer({
    token: "test-token",
    tools: { list: () => [], call: async () => ({ observed: true }) },
    events: { list: () => [], subscribe: async () => ({}), unsubscribe: () => {} },
  });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test listener");
  return `http://127.0.0.1:${address.port}/mcp`;
}

function message(method: string) {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method,
    params: {
      _meta: {
        "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  });
}
const headers = {
  authorization: "Bearer test-token",
  "content-type": "application/json",
  "mcp-protocol-version": PROTOCOL_VERSION,
  "mcp-method": "server/discover",
};

describe("private MCP endpoint", () => {
  it("advertises modern tools and events on an authenticated connection", async () => {
    const url = await start();
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: message("server/discover"),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        resultType: "complete",
        supportedVersions: [PROTOCOL_VERSION],
        capabilities: { tools: {}, events: {} },
      },
    });
  });

  it("rejects missing authentication and mismatched method headers before executing tools", async () => {
    const url = await start();
    const unauthorized = await fetch(url, { method: "POST", body: message("tools/list") });
    expect(unauthorized.status).toBe(401);
    const mismatch = await fetch(url, { method: "POST", headers, body: message("tools/list") });
    expect(mismatch.status).toBe(400);
    expect(await mismatch.json()).toMatchObject({ error: { code: -32602 } });
  });
});
