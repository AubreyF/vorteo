import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { once } from "node:events";
import { promisify } from "node:util";

const website = createRequire(new URL("../packages/website/package.json", import.meta.url));
const framework = createRequire(website.resolve("@tanstack/start-server-core/package.json"));
const { toJSON, fromJSON, fromCrossJSON } = framework("seroval");
const server = createRequire(new URL("../packages/server/package.json", import.meta.url));
const express = createRequire(server.resolve("express"));
const proxyaddr = express("proxy-addr");

test("HTTP query parsers preserve repeated values without accepting prototype keys", () => {
  const sdk = createRequire(server.resolve("@modelcontextprotocol/sdk/server/mcp.js"));
  const sdkExpress = createRequire(sdk.resolve("express"));
  for (const consumer of [express, sdkExpress]) {
    const qs = consumer("qs");
    const parsed = qs.parse(
      "tag=one&tag=two&__proto__[polluted]=yes&constructor[prototype][polluted]=yes",
    );
    assert.deepEqual(parsed, { tag: ["one", "two"] });
    assert.equal({}.polluted, undefined);
    assert.equal(
      qs.stringify(
        { tags: [null, undefined, "one"] },
        { arrayFormat: "comma", encodeValuesOnly: true },
      ),
      "tags=,,one",
    );
  }
});

test("Express rejects invalid body limits and enforces valid limits", async () => {
  const createApp = server("express");
  assert.throws(() => createApp.json({ limit: "invalid" }), /limit.*invalid/);
  const app = createApp();
  app.use(createApp.json({ limit: "1kb" }));
  app.post("/", (req, res) => res.json(req.body));
  app.use((error, _req, res, _next) => res.status(error.status || 500).end());
  const listener = app.listen(0, "127.0.0.1");
  await once(listener, "listening");
  try {
    const url = `http://127.0.0.1:${listener.address().port}/`;
    const post = (body) =>
      fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(3000),
      });
    const good = await post(JSON.stringify({ text: "hello" }));
    assert.equal(good.status, 200);
    assert.deepEqual(await good.json(), { text: "hello" });
    assert.equal((await post(JSON.stringify({ text: "x".repeat(2048) }))).status, 413);
    assert.equal((await post("{broken")).status, 400);
  } finally {
    await promisify(listener.close).call(listener);
  }
});

test("website serialization rejects an object masquerading as a typed-array buffer", () => {
  const payload = toJSON(new Uint8Array([1, 2, 3]));
  // A tiny bound distinguishes the vulnerable constructor path without trying
  // to exhaust memory. Older Seroval silently allocates 64 elements here.
  payload.t.f = toJSON({ length: 64 }).t;
  assert.throws(() => fromJSON(payload));
  assert.throws(() => fromCrossJSON(payload.t));
});

test("website serialization retains legitimate typed values and references", () => {
  const shared = { label: "shared" };
  const value = {
    bytes: new Uint8Array([1, 2, 3]),
    time: new Date("2026-10-13T00:00:00Z"),
    shared,
    alias: shared,
  };
  const decoded = fromJSON(toJSON(value));
  assert.deepEqual(decoded.bytes, value.bytes);
  assert.deepEqual(decoded.time, value.time);
  assert.equal(decoded.shared, decoded.alias);
});

test("Express does not trust arbitrary IPv4 peers through a short mapped IPv6 subnet", () => {
  const badTrust = proxyaddr.compile("::ffff:10.0.0.0/8");
  assert.equal(badTrust("203.0.113.10"), false);
  const request = {
    socket: { remoteAddress: "203.0.113.10" },
    headers: { "x-forwarded-for": "127.0.0.1" },
  };
  assert.equal(proxyaddr(request, badTrust), "203.0.113.10");
  for (const subnet of ["10.0.0.0/8", "::ffff:10.0.0.0/104"]) {
    const trust = proxyaddr.compile(subnet);
    assert.equal(trust("10.2.3.4"), true);
    assert.equal(trust("203.0.113.10"), false);
  }
  assert.equal(proxyaddr.compile("loopback")("127.0.0.1"), true);
  assert.equal(proxyaddr.compile("loopback")("203.0.113.10"), false);
});
