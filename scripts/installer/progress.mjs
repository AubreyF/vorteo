// Renders the installer engine's JSON-line events as tidy progress for install.sh and the
// `vorteo` command. Reads events on stdin:
//   {"step":"…","status":"start"|"done"|"skip"|"fail","message":"…","fix":"…"}
//   {"result":{"origin":"…","localOrigin":"…","passwordFile":"…","name":"…"}}
// Lines that are not JSON are shown as they are, indented.
//
// Usage: engine … | node scripts/installer/progress.mjs [--result <file>]
// Exit status: 0 when the stream ended with a result (or with no failure when no result is
// expected, see --no-result), 1 after a failed step, 2 when the stream ended early.
import { writeFileSync } from "node:fs";
import readline from "node:readline";
import { isMainModule } from "../is-main-module.mjs";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function paint(enabled, code, text) {
  return enabled ? `\u001b[${code}m${text}\u001b[0m` : text;
}

/**
 * Turns events into output lines. `write` receives finished text; with `animate` the
 * current step shows a spinner on its own line that is replaced when the step ends.
 */
export function createRenderer({ write, animate = false, color = false, intervalMs = 80 }) {
  let active = null;
  let frame = 0;
  let timer = null;
  const state = { failed: null, result: null };

  const clearSpinner = () => {
    if (timer) clearInterval(timer);
    timer = null;
    if (active && animate) write("\r\u001b[K");
    active = null;
  };
  const line = (text) => {
    clearSpinner();
    write(`${text}\n`);
  };

  const label = (event) => event.message || event.step || "Working";
  const handlers = {
    start(event) {
      clearSpinner();
      active = label(event);
      if (!animate) {
        write(`  ${paint(color, 2, "…")} ${active}\n`);
        return;
      }
      const draw = () => {
        write(`\r  ${paint(color, 36, SPINNER[frame % SPINNER.length])} ${active}\u001b[K`);
        frame++;
      };
      draw();
      timer = setInterval(draw, intervalMs);
      timer.unref?.();
    },
    done(event) {
      line(`  ${paint(color, 32, "✓")} ${label(event)}`);
    },
    skip(event) {
      // The engine skips steps that are already done on a rerun or do not apply.
      line(`  ${paint(color, 2, "·")} ${label(event)} ${paint(color, 2, "(skipped)")}`);
    },
    fail(event) {
      line(`  ${paint(color, 31, "✗")} ${label(event)}`);
      if (event.fix) line(`    ${paint(color, 1, "Fix:")} ${event.fix}`);
      state.failed = event;
    },
  };

  return {
    state,
    handle(rawLine) {
      const text = rawLine.trimEnd();
      if (!text) return;
      let event;
      try {
        event = JSON.parse(text);
      } catch {
        line(`    ${paint(color, 2, text)}`);
        return;
      }
      if (!event || typeof event !== "object") {
        line(`    ${paint(color, 2, text)}`);
      } else if (event.result) {
        clearSpinner();
        state.result = event.result;
      } else if (handlers[event.status]) {
        handlers[event.status](event);
      } else if (event.message) {
        line(`    ${event.message}`);
      }
    },
    finish() {
      clearSpinner();
      return state;
    },
  };
}

export function exitStatus(state, { expectResult = true } = {}) {
  if (state.failed) return 1;
  if (expectResult && !state.result) return 2;
  return 0;
}

async function main(argv) {
  const resultIndex = argv.indexOf("--result");
  const resultFile = resultIndex === -1 ? null : argv[resultIndex + 1];
  const expectResult = !argv.includes("--no-result");
  const interactive = Boolean(process.stdout.isTTY) && process.env.TERM !== "dumb";
  const renderer = createRenderer({
    write: (text) => process.stdout.write(text),
    animate: interactive,
    color: interactive && !process.env.NO_COLOR,
  });
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const rawLine of input) renderer.handle(rawLine);
  const state = renderer.finish();
  if (resultFile && state.result) {
    writeFileSync(resultFile, `${JSON.stringify(state.result)}\n`, { mode: 0o600 });
  }
  return exitStatus(state, { expectResult });
}

if (isMainModule(import.meta.url, process.argv[1])) {
  process.exitCode = await main(process.argv.slice(2));
}
