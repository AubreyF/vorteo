import assert from "node:assert/strict";
import { once } from "node:events";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(new URL("../packages/server/package.json", import.meta.url));
const { WebSocket, WebSocketServer } = require("ws");

async function receiveFragments(count) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  let receivedBytes = null;
  let errorCode = null;
  server.on("connection", (socket) => {
    socket.on("error", (error) => {
      errorCode = error.code;
    });
    socket.on("message", (message) => {
      receivedBytes = message.length;
      socket.close(1000);
    });
  });
  const client = new WebSocket(`ws://127.0.0.1:${server.address().port}`);
  try {
    await once(client, "open");
    const closed = once(client, "close");
    for (let index = 0; index < count; index++) {
      client.send(Buffer.from("a"), { fin: index === count - 1 });
    }
    const [closeCode] = await closed;
    return { closeCode, receivedBytes, errorCode };
  } finally {
    client.terminate();
    for (const socket of server.clients) socket.terminate();
    await new Promise((resolve) => server.close(resolve));
  }
}

test("ordinary fragmented messages remain compatible", async () => {
  assert.deepEqual(await receiveFragments(3), {
    closeCode: 1000,
    receivedBytes: 3,
    errorCode: null,
  });
});

test("default transport rejects excessive fragments before message delivery", async () => {
  // A finite 128 KiB payload crosses the upstream fragment-count limit without
  // approaching the payload-byte limit or stressing the installed daemon.
  assert.deepEqual(await receiveFragments(131073), {
    closeCode: 1008,
    receivedBytes: null,
    errorCode: "WS_ERR_TOO_MANY_BUFFERED_PARTS",
  });
});
