import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("native helper selects the pinned daemon and retains a shell-safe wrapper", () => {
  const home = mkdtempSync(join(tmpdir(), "native-preview-helper-"));
  try {
    const channel = join(home, ".local/share/paseo-preview/https");
    mkdirSync(channel, { recursive: true });
    const cli = join(home, "fixture-cli.mjs");
    const calls = join(home, "calls.json");
    writeFileSync(
      cli,
      `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(
        calls,
      )}, JSON.stringify(process.argv.slice(2))); console.log('[]');`,
    );
    writeFileSync(
      join(channel, "installed.json"),
      JSON.stringify({
        version: 1,
        cliCommand: [process.execPath, cli],
        daemonHome: join(home, "daemon home"),
      }),
    );
    const entry = fileURLToPath(new URL("./paseo-preview.mjs", import.meta.url));
    const result = spawnSync(process.execPath, [entry, "list", "--workspace", "wks_native"], {
      env: { ...process.env, HOME: home },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(calls, "utf8")), [
      "--home",
      join(home, "daemon home"),
      "script",
      "ls",
      "--workspace",
      "wks_native",
      "--json",
    ]);
    const refused = spawnSync(
      process.execPath,
      [entry, "env", "../../escape", "--workspace", "wks_native", "--", process.execPath],
      {
        env: { ...process.env, HOME: home },
        encoding: "utf8",
      },
    );
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /Invalid preview identity/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("preview wrapper goes to paseo.local.json when the daemon merges it", async () => {
  const { wrapPreviewCommand } = await import("./preview-broker-client.mjs");
  const cwd = mkdtempSync(join(tmpdir(), "preview-local-config-"));
  try {
    const project = JSON.stringify({
      scripts: { web: { type: "service", command: "npm run dev" } },
    });
    writeFileSync(join(cwd, "paseo.json"), project);
    const prefix = "helper env 'web' --workspace 'wks_x' -- ";

    wrapPreviewCommand(cwd, "web", prefix, true);
    wrapPreviewCommand(cwd, "web", prefix, true);

    assert.equal(readFileSync(join(cwd, "paseo.json"), "utf8"), project);
    assert.deepEqual(JSON.parse(readFileSync(join(cwd, "paseo.local.json"), "utf8")), {
      scripts: { web: { command: `${prefix}/bin/sh -lc 'npm run dev'` } },
    });

    rmSync(join(cwd, "paseo.local.json"));
    wrapPreviewCommand(cwd, "web", prefix, false);
    assert.equal(
      JSON.parse(readFileSync(join(cwd, "paseo.json"), "utf8")).scripts.web.command,
      `${prefix}/bin/sh -lc 'npm run dev'`,
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a service declared only in paseo.local.json is wrapped in place", async () => {
  const { wrapPreviewCommand } = await import("./preview-broker-client.mjs");
  const cwd = mkdtempSync(join(tmpdir(), "preview-local-only-"));
  try {
    const project = JSON.stringify({ scripts: {} });
    writeFileSync(join(cwd, "paseo.json"), project);
    writeFileSync(
      join(cwd, "paseo.local.json"),
      JSON.stringify({
        scripts: { mock: { type: "service", command: "node serve.mjs" } },
      }),
    );
    const prefix = "helper env 'mock' --workspace 'wks_x' -- ";

    wrapPreviewCommand(cwd, "mock", prefix, true);

    assert.equal(readFileSync(join(cwd, "paseo.json"), "utf8"), project);
    assert.deepEqual(JSON.parse(readFileSync(join(cwd, "paseo.local.json"), "utf8")), {
      scripts: {
        mock: {
          type: "service",
          command: `${prefix}/bin/sh -lc 'node serve.mjs'`,
        },
      },
    });
    assert.throws(
      () => wrapPreviewCommand(cwd, "absent", prefix, true),
      /configuration is missing/,
    );

    // An older pinned CLI may not report local config support; the listed
    // local-only service still proves the daemon merges paseo.local.json.
    writeFileSync(
      join(cwd, "paseo.local.json"),
      JSON.stringify({
        scripts: { mock: { type: "service", command: "node serve.mjs" } },
      }),
    );
    wrapPreviewCommand(cwd, "mock", prefix, false);
    assert.equal(readFileSync(join(cwd, "paseo.json"), "utf8"), project);
    assert.equal(
      JSON.parse(readFileSync(join(cwd, "paseo.local.json"), "utf8")).scripts.mock.command,
      `${prefix}/bin/sh -lc 'node serve.mjs'`,
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
