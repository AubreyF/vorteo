import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import test from "node:test";
import { Worker } from "node:worker_threads";

const require = createRequire(import.meta.url);
const expo = createRequire(new URL("../node_modules/@expo/cli/package.json", import.meta.url));

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}

test("Expo's HTTP client preserves JSON responses", async () => {
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ready: true }));
  });
  const url = await listen(server);
  try {
    const response = await expo("undici").fetch(url, { signal: AbortSignal.timeout(3000) });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ready: true });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

for (const [name, client] of [
  ["Expo", expo],
  ["Miniflare", createRequire(new URL("../node_modules/miniflare/package.json", import.meta.url))],
]) {
  test(`${name}: an unrequested WebSocket protocol fails the connection without crashing its worker`, async () => {
    const sockets = new Set();
    const server = createServer();
    server.on("upgrade", (request, socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => {});
      const accept = createHash("sha1")
        .update(request.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
        .digest("base64");
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: unrequested\r\n\r\n`,
      );
    });
    const url = (await listen(server)).replace("http:", "ws:");
    const worker = new Worker(
      `const { parentPort, workerData } = require('node:worker_threads');
     const { WebSocket } = require(workerData.module);
     const socket = new WebSocket(workerData.url);
     socket.addEventListener('open', () => parentPort.postMessage('unexpected-open'));
     socket.addEventListener('error', () => parentPort.postMessage('connection-rejected'));`,
      { eval: true, workerData: { module: client.resolve("undici"), url }, execArgv: [] },
    );
    try {
      const [result] = await once(worker, "message", { signal: AbortSignal.timeout(3000) });
      assert.equal(result, "connection-rejected");
    } finally {
      await worker.terminate();
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
  });
}

test("wait-on retains HEAD and GET readiness checks and rejects unavailable resources", async () => {
  const methods = [];
  const server = createServer((req, res) => {
    methods.push(req.method);
    res.statusCode = req.url === "/missing" ? 503 : 200;
    res.end("ready");
  });
  const url = await listen(server);
  const waitOn = require("wait-on");
  try {
    const options = { timeout: 1000, interval: 20, httpTimeout: 300, proxy: false };
    await waitOn({ ...options, resources: [url] });
    await waitOn({ ...options, resources: [url.replace("http:", "http-get:")] });
    await assert.rejects(waitOn({ ...options, timeout: 150, resources: [url + "/missing"] }));
    assert.ok(methods.includes("HEAD"));
    assert.ok(methods.includes("GET"));
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
