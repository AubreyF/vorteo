import { test, expect } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";

test.each([false, true])("dispatch notification survives a closed observer: %s", async (closed) => {
  const moduleUrl = new URL("./coordinator-bootstrap-runner.ts", import.meta.url).href;
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `import { acknowledgeBootstrapDispatch } from ${JSON.stringify(moduleUrl)};
       process.stdin.once('data', () => {
         acknowledgeBootstrapDispatch();
         setTimeout(() => { process.stderr.write('continued'); process.exit(0); }, 50);
       });
       process.stderr.write('ready');`,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const exited = once(child, "close");
  let output = "";
  let errors = "";
  child.stdout.on("data", (chunk) => (output += chunk.toString()));
  child.stderr.on("data", (chunk) => (errors += chunk.toString()));
  try {
    await once(child.stderr, "data");
    expect(errors).toBe("ready");
    if (closed) {
      const disconnected = once(child.stdout, "close");
      child.stdout.destroy();
      await disconnected;
    }
    child.stdin.end("go");
    expect(await exited).toEqual([0, null]);
    expect(errors).toBe("readycontinued");
    expect(output).toBe(closed ? "" : "dispatched\n");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
  }
});
