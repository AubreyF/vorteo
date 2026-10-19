import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, get } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import zlib from "node:zlib";

const require = createRequire(import.meta.url);

test("YAML merge limits count empty sources in both supported major versions", () => {
  const readers = [require("js-yaml"), require("../node_modules/@oclif/core/node_modules/js-yaml")];
  const input = "empty: &empty [{}, {}, {}, {}]\ntarget:\n  <<: *empty\n";
  for (const yaml of readers) {
    assert.throws(() => yaml.load(input, { maxTotalMergeKeys: 2 }), /maxTotalMergeKeys/);
    assert.deepEqual(yaml.load("base: &base {enabled: true}\ncopy: {<<: *base}"), {
      base: { enabled: true },
      copy: { enabled: true },
    });
  }
});

test("the desktop updater preserves valid metadata and rejects excessive YAML nesting", () => {
  const { parseUpdateInfo } = require("electron-updater/out/providers/Provider.js");
  const parsed = parseUpdateInfo(
    "version: 1.2.3\nfiles:\n  - url: update.zip\n    sha512: example\n",
    "latest.yml",
    "https://example.invalid/latest.yml",
  );
  assert.equal(parsed.version, "1.2.3");
  assert.equal(parsed.files[0].url, "update.zip");
  assert.throws(
    () =>
      parseUpdateInfo(
        "value: " + "[".repeat(150) + "0" + "]".repeat(150),
        "latest.yml",
        "https://example.invalid/latest.yml",
      ),
    /nesting exceeded/,
  );
});

test("Knip's actual TOML loader reads ordinary configuration and rejects malformed values", async () => {
  const { loadTOML } = await import("../node_modules/knip/dist/util/fs.js");
  const directory = await mkdtemp(path.join(tmpdir(), "toml-boundary-"));
  const file = path.join(directory, "config.toml");
  try {
    await writeFile(file, '# comment\n[project]\nname = "fixture"\nenabled = true\n');
    const parsed = await loadTOML(file);
    assert.equal(parsed.project.name, "fixture");
    assert.equal(parsed.project.enabled, true);
    assert.equal(Object.getPrototypeOf(parsed), null);
    await writeFile(file, 'value = "unterminated');
    await assert.rejects(loadTOML(file));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  "compression releases its native stream when a client disconnects",
  { timeout: 5000 },
  async () => {
    const descriptor = Object.getOwnPropertyDescriptor(zlib, "createGzip");
    let stream;
    // Observe the real native stream without replacing compression behavior.
    Object.defineProperty(zlib, "createGzip", {
      ...descriptor,
      value: (...args) => {
        stream = descriptor.value(...args);
        return stream;
      },
    });
    const compression = require("compression")({ threshold: 0 });
    let closed;
    const responseClosed = new Promise((resolve) => {
      closed = resolve;
    });
    const server = createServer((req, res) => {
      res.on("close", closed);
      compression(req, res, () => {
        res.setHeader("content-type", "text/plain");
        res.write("bounded data".repeat(100));
        res.flush();
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    let request;
    try {
      request = get(
        `http://127.0.0.1:${server.address().port}`,
        { headers: { "accept-encoding": "gzip" } },
        (response) => {
          response.once("data", () => request.destroy());
        },
      );
      request.on("error", () => {});
      await responseClosed;
      await new Promise((resolve) => setImmediate(resolve));
      assert.ok(stream, "the response must create a real gzip stream");
      assert.equal(stream.destroyed, true);
      assert.equal(stream._handle, null);
    } finally {
      request?.destroy();
      stream?.destroy();
      Object.defineProperty(zlib, "createGzip", descriptor);
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  },
);
