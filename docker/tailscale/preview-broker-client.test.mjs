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
      `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2))); console.log('[]');`,
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
