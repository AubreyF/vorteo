import { expect, test } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { inspectInstallerPresence } from "./native-helper-installer-process.js";

test("installer observation distinguishes a live fixture from its exited PID without terminating it", async () => {
  const child = spawn(process.execPath, ["-e", "process.stdin.resume();"], {
    stdio: ["pipe", "ignore", "ignore"],
  });
  await once(child, "spawn");
  const pid = child.pid!;
  const exited = once(child, "exit");
  try {
    await expect(inspectInstallerPresence(pid)).resolves.toEqual({ state: "present" });
  } finally {
    child.stdin.end();
    await exited;
  }
  await expect(inspectInstallerPresence(pid)).resolves.toEqual({ state: "absent" });
});

test("invalid installer PIDs cannot become evidence of termination", async () => {
  for (const pid of [0, -1, NaN, 1.5, 2147483648]) {
    await expect(inspectInstallerPresence(pid)).resolves.toEqual({ state: "unverified" });
  }
});
