import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import type { LoadedReleaseIdentity } from "./release-manifest.js";
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

async function start(release?: LoadedReleaseIdentity) {
  const server = createBridgeServer({
    token: "test-token",
    release,
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

it("keeps readiness authenticated and identifies legacy startup without release claims", async () => {
  const url = (await start()).replace("/mcp", "/health");
  expect((await fetch(url)).status).toBe(401);
  expect((await fetch(url, { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
  expect(
    (await fetch(url, { headers: { ...headers, origin: "https://example.com" } })).status,
  ).toBe(403);
  const response = await fetch(url, { headers });
  expect(response.headers.get("cache-control")).toBe("no-store");
  const ready = await response.json();
  expect(ready).toMatchObject({
    status: "ready",
    draining: false,
    release: null,
    pid: process.pid,
  });
  expect(ready.startupInstance).toMatch(/^[a-f0-9-]{36}$/);
  expect(Number.isNaN(Date.parse(ready.startedAt))).toBe(false);
  expect(await (await fetch(url, { headers })).json()).toEqual(ready);
  const second = (await start()).replace("/mcp", "/health");
  expect((await (await fetch(second, { headers })).json()).startupInstance).not.toBe(
    ready.startupInstance,
  );
});

it("reports the startup release snapshot and draining state without weakening authentication", async () => {
  const release: LoadedReleaseIdentity = {
    version: 1,
    installationId: "11111111-1111-4111-8111-111111111111",
    sourceCommit: "a".repeat(40),
    manifestSha256: "b".repeat(64),
    artifactSha256: "c".repeat(64),
    configSha256: "d".repeat(64),
  };
  const expected = structuredClone(release);
  const url = await start(release);
  release.configSha256 = "e".repeat(64);
  const ready = await (await fetch(url.replace("/mcp", "/health"), { headers })).json();
  expect(ready.release).toEqual(expected);
  const server = servers.at(-1);
  if (!server) throw new Error("Missing test server");
  server.beginDrain();
  const response = await fetch(url.replace("/mcp", "/health"), { headers });
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ ...ready, status: "draining", draining: true });
  expect(
    (await fetch(url, { method: "POST", headers, body: message("server/discover") })).status,
  ).toBe(503);
  expect((await fetch(url.replace("/mcp", "/health"))).status).toBe(401);
  await server.drain();
});

it("drains an admitted tool call while refusing later calls", async () => {
  let enter = () => {};
  let finish = () => {};
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let calls = 0;
  const server = createBridgeServer({
    token: "test-token",
    tools: {
      list: () => [],
      call: async () => {
        calls++;
        enter();
        await finished;
        return { done: true };
      },
    },
    events: { list: () => [], subscribe: async () => ({}), unsubscribe: () => {} },
  });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test listener");
  const url = `http://127.0.0.1:${address.port}/mcp`;
  const body = JSON.parse(message("tools/call"));
  body.params.name = "fixture";
  body.params.arguments = {};
  const request = {
    method: "POST",
    headers: { ...headers, "mcp-method": "tools/call", "mcp-name": "fixture" },
    body: JSON.stringify(body),
  };
  const pending = fetch(url, request);
  await entered;
  const drained = server.drain();
  expect((await fetch(url, request)).status).toBe(503);
  finish();
  expect((await pending).status).toBe(200);
  await drained;
  expect(calls).toBe(1);
});
