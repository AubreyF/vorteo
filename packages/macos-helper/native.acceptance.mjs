import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { invokeHelper } from "./dispatch.mjs";

// Run explicitly against an installed isolated native preview; never asks for consent.
const root = join(homedir(), ".local/share/vorteo-macos-helper-preview");
const client = join(
  homedir(),
  "Applications/Vorteo Permission Helper Preview.app/Contents/MacOS/vorteo-helper-client",
);
function native(operation, token) {
  const reply = spawnSync(client, [operation], { input: token, encoding: "utf8" });
  return JSON.parse(reply.stdout);
}
describe("packaged native caller boundary", () => {
  it("allows the signed native client with the Host capability", async () => {
    const reply = await invokeHelper("status", { preview: true });
    assert.equal(reply.ok, true);
    assert.match(reply.code, /^safari_permission_-?\d+$/);
  });
  it("rejects a signed client with the wrong capability", () => {
    assert.deepEqual(native("status", "0".repeat(64)), {
      ok: false,
      code: "caller_rejected",
      protocolVersion: 2,
    });
  });
  it("rejects an arbitrary local process even with the valid capability", async () => {
    const config = JSON.parse(await readFile(join(root, "config.json"), "utf8"));
    const reply = await new Promise((resolve, reject) => {
      const socket = createConnection(join(root, "helper.sock"));
      let output = "";
      // Signature rejection precedes request reads, so a direct caller never gets
      // a chance to submit even a valid capability. Do not race the rejection write.
      assert.equal(config.token.length, 64);
      socket.on("data", (data) => {
        output += data;
        if (output.includes("\n")) {
          socket.destroy();
          resolve(JSON.parse(output));
        }
      });
      socket.on("error", reject);
      socket.setTimeout(5000, () => {
        socket.destroy();
        reject(new Error("Timed out"));
      });
    });
    assert.deepEqual(reply, { ok: false, code: "caller_rejected", protocolVersion: 2 });
  });
  it("rejects arbitrary script execution from an authenticated caller", async () => {
    const config = JSON.parse(await readFile(join(root, "config.json"), "utf8"));
    assert.deepEqual(native("execute-applescript", config.token), {
      ok: false,
      code: "unsupported_operation",
      protocolVersion: 2,
    });
  });
  it("enforces the native protocol and rejects caller source fields", async () => {
    const config = JSON.parse(await readFile(join(root, "config.json"), "utf8"));
    const send = (request) =>
      native(request.operation, JSON.stringify({ token: config.token, ...request }));
    assert.equal(
      send({ operation: "status", protocolVersion: 999, parameters: {} }).code,
      "protocol_mismatch",
    );
    assert.equal(
      send({
        operation: "safari.read",
        protocolVersion: 2,
        parameters: { windowId: 1, tabIndex: 1, javascript: "secret" },
      }).code,
      "invalid_request",
    );
  });
  it("rejects unconfigured tabs before requesting Safari access", async () => {
    const { writeFile, rm } = await import("node:fs/promises");
    const policy = join(root, "browser-policy.json");
    await writeFile(
      policy,
      JSON.stringify({
        allowedOrigins: ["https://chatgpt.com", "https://platform.openai.com"],
        tabs: [],
        destinations: [],
        allowedText: [],
        actions: ["read"],
      }),
      { flag: "wx", mode: 0o600 },
    );
    try {
      const reply = await invokeHelper("safari.read", {
        preview: true,
        parameters: { windowId: 1, tabIndex: 1 },
      });
      assert.equal(reply.code, "tab_rejected");
    } finally {
      await rm(policy);
    }
  });
  it("refuses to prompt for consent under the preview identity", async () => {
    assert.deepEqual(await invokeHelper("safari.request-consent", { preview: true }), {
      ok: false,
      code: "preview_consent_disabled",
      protocolVersion: 2,
    });
  });
});

// Lifecycle checks operate only on the isolated preview, never an agent daemon.
describe("native preview lifecycle", () => {
  it("retains capability and requirements through compatible update, rollback and restart", async () => {
    const { cp, mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { fileURLToPath } = await import("node:url");
    const installer = fileURLToPath(new URL("./install.mjs", import.meta.url));
    const app = join(homedir(), "Applications/Vorteo Permission Helper Preview.app");
    const temporary = await mkdtemp(join(tmpdir(), "vorteo-helper-lifecycle-"));
    const candidate = join(temporary, "Vorteo.app");
    const before = createHash("sha256")
      .update(await readFile(join(root, "config.json")))
      .digest("hex");
    function install(args) {
      const result = spawnSync(process.execPath, [installer, ...args, "--preview"], {
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr);
    }
    try {
      await cp(app, candidate, { recursive: true });
      install(["install", candidate]);
      assert.equal(
        createHash("sha256")
          .update(await readFile(join(root, "config.json")))
          .digest("hex"),
        before,
      );
      assert.equal((await invokeHelper("status", { preview: true })).ok, true);
      install(["rollback"]);
      assert.equal(
        createHash("sha256")
          .update(await readFile(join(root, "config.json")))
          .digest("hex"),
        before,
      );
      assert.equal((await invokeHelper("status", { preview: true })).ok, true);
      assert.deepEqual(await invokeHelper("quit", { preview: true }), {
        ok: true,
        code: "quitting",
        protocolVersion: 2,
      });
      install(["launch"]);
      assert.equal((await invokeHelper("status", { preview: true })).ok, true);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
  it("rejects a changed ad hoc requirement before stopping the current preview", async () => {
    const { cp, mkdtemp, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { fileURLToPath } = await import("node:url");
    const installer = fileURLToPath(new URL("./install.mjs", import.meta.url));
    const entitlements = fileURLToPath(new URL("./entitlements.plist", import.meta.url));
    const app = join(homedir(), "Applications/Vorteo Permission Helper Preview.app");
    const temporary = await mkdtemp(join(tmpdir(), "vorteo-helper-requirement-"));
    const candidate = join(temporary, "Vorteo.app");
    const before = createHash("sha256")
      .update(await readFile(join(root, "config.json")))
      .digest("hex");
    try {
      await cp(app, candidate, { recursive: true });
      await writeFile(
        join(candidate, "Contents/Resources/requirement-test.txt"),
        "Changed sealed resource\n",
      );
      const signed = spawnSync(
        "/usr/bin/codesign",
        [
          "--force",
          "--sign",
          "-",
          "--options",
          "runtime",
          "--entitlements",
          entitlements,
          candidate,
        ],
        { encoding: "utf8" },
      );
      assert.equal(signed.status, 0, signed.stderr);
      const result = spawnSync(process.execPath, [installer, "install", candidate, "--preview"], {
        encoding: "utf8",
      });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /code failed to satisfy specified code requirement/);
      assert.equal(
        createHash("sha256")
          .update(await readFile(join(root, "config.json")))
          .digest("hex"),
        before,
      );
      assert.equal((await invokeHelper("status", { preview: true })).ok, true);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
});
