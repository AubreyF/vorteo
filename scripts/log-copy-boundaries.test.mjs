import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const fromPretty = createRequire(require.resolve("pino-pretty/package.json"));
const filterLog = fromPretty("./lib/utils/filter-log.js");

test("pretty log filtering preserves nested values without mutating its input", () => {
  const log = { pid: 123, hostname: "fixture", msg: "ready", detail: { state: "active" } };
  const filtered = filterLog({ log, context: { ignoreKeys: new Set(["pid", "hostname"]) } });
  assert.deepEqual(filtered, { msg: "ready", detail: { state: "active" } });
  filtered.detail.state = "changed";
  assert.equal(log.detail.state, "active");
  assert.equal(log.pid, 123);
});

test("pretty log copying rejects excessive depth with the library's explicit limit", () => {
  let log = { value: "fixture" };
  for (let i = 0; i < 1500; i++) log = { child: log };
  assert.throws(
    () => filterLog({ log, context: { ignoreKeys: new Set(["pid", "hostname"]) } }),
    (error) => error.name === "MaxDepthExceededError" && /Maximum copy depth/.test(error.message),
  );
});
