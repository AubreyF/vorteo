import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createRenderer, exitStatus } from "./progress.mjs";

const progressScript = path.join(path.dirname(fileURLToPath(import.meta.url)), "progress.mjs");

function render(lines, options = {}) {
  let output = "";
  const renderer = createRenderer({ write: (text) => (output += text), ...options });
  for (const line of lines) renderer.handle(typeof line === "string" ? line : JSON.stringify(line));
  return { output, state: renderer.finish() };
}

describe("installer progress", () => {
  test("renders steps, skips and plain output as tidy lines", () => {
    const { output, state } = render([
      { step: "identity", status: "start", message: "Creating the identity" },
      { step: "identity", status: "done", message: "Created the identity" },
      { step: "dev", status: "skip", message: "Dev container" },
      "docker: pulling layer",
      { result: { origin: "https://vorteo.example.ts.net" } },
    ]);
    assert.equal(
      output,
      [
        "  … Creating the identity",
        "  ✓ Created the identity",
        "  · Dev container (skipped)",
        "    docker: pulling layer",
        "",
      ].join("\n"),
    );
    assert.equal(exitStatus(state), 0);
  });

  test("a failed step shows its fix and fails", () => {
    const { output, state } = render([
      { step: "host", status: "start", message: "Starting the Host" },
      { step: "host", status: "fail", message: "Starting the Host failed", fix: "Free port 6790." },
    ]);
    assert.match(output, /✗ Starting the Host failed\n {4}Fix: Free port 6790\.\n$/);
    assert.equal(exitStatus(state), 1);
  });

  test("a stream that ends without a result counts as stopped early", () => {
    const { state } = render([{ step: "host", status: "done", message: "Started" }]);
    assert.equal(exitStatus(state), 2);
    assert.equal(exitStatus(state, { expectResult: false }), 0);
  });

  test("on a terminal the spinner line is replaced when the step ends", () => {
    const { output } = render(
      [
        { step: "host", status: "start", message: "Starting the Host" },
        { step: "host", status: "done", message: "Started the Host" },
      ],
      { animate: true },
    );
    assert.ok(output.startsWith("\r  ⠋ Starting the Host"));
    assert.ok(output.endsWith("\r\u001b[K  ✓ Started the Host\n"));
  });

  test("the command writes the result file and reports the exit status", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "vorteo-progress-"));
    try {
      const resultFile = path.join(dir, "result.json");
      const ok = spawnSync(process.execPath, [progressScript, "--result", resultFile], {
        input: `${JSON.stringify({ result: { name: "Vorteo" } })}\n`,
        encoding: "utf8",
      });
      assert.equal(ok.status, 0);
      assert.deepEqual(JSON.parse(readFileSync(resultFile, "utf8")), { name: "Vorteo" });
      const failed = spawnSync(process.execPath, [progressScript], {
        input: `${JSON.stringify({ step: "x", status: "fail", message: "Broke" })}\n`,
        encoding: "utf8",
      });
      assert.equal(failed.status, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
