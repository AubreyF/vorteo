import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, test } from "vitest";
import {
  clockTicksFromAuxv,
  inspectLinuxProcess,
  inspectLinuxProcessSnapshot,
  type LinuxProcessReader,
  inspectLinuxProcessCgroup,
  inspectRunningLinuxProcess,
  inspectStoppedLinuxProcess,
  parseProcStat,
  parseProcStatus,
  procArgumentsDigest,
  startIdentityFromTicks,
  verifyLinuxProcessExited,
} from "./coordinator-bootstrap-linux-process.js";
import { verifyRetainedProcessExited } from "./coordinator-bootstrap-service.js";

const digest = (args: string[]) => createHash("sha256").update(JSON.stringify(args)).digest("hex");

describe("Linux /proc parsing", () => {
  test("reads lifetime fields after a process-controlled comm", () => {
    const tail = Array.from({ length: 50 }, (_, index) => String(index + 4)).join(" ");
    const fields = tail.split(" ");
    fields[18] = "987654";
    expect(parseProcStat(42, `42 (evil) S 1 (x) T ${fields.join(" ")}`)).toEqual({
      pid: 42,
      state: "T",
      parentPid: 4,
      startTicks: 987654n,
    });
  });

  test("accepts the kernel's parent 0 for PID 1", () => {
    const tail = Array.from({ length: 50 }, () => "0").join(" ");
    expect(parseProcStat(1, `1 (systemd) S ${tail}`)).toMatchObject({ parentPid: 0 });
  });

  test("rejects stat for another PID or a truncated record", () => {
    expect(() => parseProcStat(42, "43 (x) S 1 2 3")).toThrow("status identity");
    expect(() => parseProcStat(42, "42 (x) S 1 2 3")).toThrow("status identity");
  });

  test("reads the thread group and exactly four UID values", () => {
    expect(
      parseProcStatus("Name:\tx\nTgid:\t42\nPid:\t43\nUid:\t1000\t1000\t1000\t1000\nGid:\t1\n"),
    ).toEqual({ threadGroup: 42, uids: [1000, 1000, 1000, 1000] });
    expect(() => parseProcStatus("Tgid:\t42\nUid:\t1000\t1000\t1000\n")).toThrow("status");
    expect(() => parseProcStatus("Tgid:\t42\nUid:\t1\t1\t1\t1\nUid:\t2\t2\t2\t2\n")).toThrow(
      "status",
    );
    expect(() => parseProcStatus("Uid:\t1\t1\t1\t1\n")).toThrow("status");
  });

  test("digests argv like the macOS inspector and refuses ambiguous bytes", () => {
    expect(procArgumentsDigest(Buffer.from("/bin/sh\0-c\0a b\0"))).toBe(
      digest(["/bin/sh", "-c", "a b"]),
    );
    expect(procArgumentsDigest(Buffer.from("x\0\0"))).toBe(digest(["x", ""]));
    expect(() => procArgumentsDigest(Buffer.from("/bin/sh\0-c"))).toThrow("incomplete");
    expect(() => procArgumentsDigest(Buffer.alloc(0))).toThrow("incomplete");
    expect(() => procArgumentsDigest(Buffer.from([0xff, 0]))).toThrow();
  });

  test("encodes clock ticks as ordered seconds and microseconds", () => {
    expect(startIdentityFromTicks(12345n, 100n)).toBe("123:450000");
    expect(startIdentityFromTicks(99n, 100n)).toBe("0:990000");
    expect(startIdentityFromTicks(1024n, 1000n)).toBe("1:24000");
    expect(() => startIdentityFromTicks(1n, 1024n)).toThrow("tick rate");
  });

  test("reads AT_CLKTCK and refuses a vector without it", () => {
    const vector = Buffer.alloc(48);
    vector.writeBigUInt64LE(6n, 0);
    vector.writeBigUInt64LE(4096n, 8);
    vector.writeBigUInt64LE(17n, 16);
    vector.writeBigUInt64LE(100n, 24);
    expect(clockTicksFromAuxv(vector)).toBe(100n);
    expect(() => clockTicksFromAuxv(Buffer.alloc(32))).toThrow("unavailable");
  });
});

/** Another account's process, when this environment has one. A development
 * container's PID 1 can run as the test account, so PID 1 is not assumed. */
function foreignProcess(): number | undefined {
  if (process.platform !== "linux") return undefined;
  const uid = String(process.getuid?.());
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const owner = readFileSync(`/proc/${entry}/status`, "utf8").match(/^Uid:\s+(\d+)/m)?.[1];
      if (owner !== undefined && owner !== uid) return Number(entry);
    } catch {
      // The process exited during the scan.
    }
  }
  return undefined;
}

describe.runIf(process.platform === "linux")("live Linux process inspection", () => {
  const children: ChildProcess[] = [];

  afterEach(async () => {
    for (const child of children.splice(0)) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      child.kill("SIGKILL");
      await once(child, "exit");
    }
  });

  function start(command: string, args: string[]): ChildProcess & { pid: number } {
    const child = spawn(command, args, { stdio: "ignore" });
    children.push(child);
    if (!child.pid) throw new Error("Child process did not start");
    return Object.assign(child, { pid: child.pid });
  }

  async function waitForState(pid: number, state: string): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (parseProcStat(pid, readFileSync(`/proc/${pid}/stat`, "utf8")).state === state) return;
      await delay(10);
    }
    throw new Error(`Process ${pid} did not reach state ${state}`);
  }

  async function waitForChildren(pid: number, count: number): Promise<number[]> {
    for (let attempt = 0; attempt < 200; attempt++) {
      const text = readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim();
      const pids = text ? text.split(" ").map(Number) : [];
      if (pids.length === count) return pids;
      await delay(10);
    }
    throw new Error(`Process ${pid} did not reach ${count} children`);
  }

  test("observes a child's exact identity", async () => {
    const child = start("/bin/sleep", ["30"]);
    await waitForState(child.pid, "S");
    const observation = await inspectLinuxProcess(child.pid);
    expect(observation).toEqual({
      pid: child.pid,
      parentPid: process.pid,
      uid: process.getuid?.(),
      bootId: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
      startIdentity: expect.stringMatching(/^\d+:\d{1,6}$/),
      argumentsSha256: digest(["/bin/sleep", "30"]),
      executable: realpathSync("/bin/sleep"),
    });
    const uptime = Number(readFileSync("/proc/uptime", "utf8").split(" ")[0]);
    const born = Number(observation.startIdentity.split(":")[0]);
    expect(born).toBeLessThanOrEqual(uptime);
    expect(born).toBeGreaterThan(uptime - 60);
    expect(await inspectLinuxProcess(child.pid)).toEqual(observation);
  });

  test("reports running and stopped states with the stopped child inventory", async () => {
    const parent = start("/bin/sh", ["-c", "/bin/sleep 30 & wait"]);
    const [grandchild] = await waitForChildren(parent.pid, 1);
    await waitForState(parent.pid, "S");
    expect(await inspectRunningLinuxProcess(parent.pid)).toMatchObject({ stopped: false });
    await expect(inspectStoppedLinuxProcess(parent.pid)).rejects.toThrow("not stopped");

    parent.kill("SIGSTOP");
    await waitForState(parent.pid, "T");
    const frozen = await inspectStoppedLinuxProcess(parent.pid);
    expect(frozen).toMatchObject({ pid: parent.pid, stopped: true, childPids: [grandchild] });
    await expect(inspectRunningLinuxProcess(parent.pid)).rejects.toThrow("not running");
    parent.kill("SIGCONT");
  });

  test("proves exit only after the PID is reaped", async () => {
    const child = start("/bin/sleep", ["30"]);
    await waitForState(child.pid, "S");
    const before = await inspectLinuxProcess(child.pid);
    await expect(verifyLinuxProcessExited(child.pid)).rejects.toThrow("not proven");
    child.kill("SIGKILL");
    await once(child, "exit");
    await expect(verifyLinuxProcessExited(child.pid)).resolves.toBeUndefined();
    await expect(inspectLinuxProcess(child.pid)).rejects.toThrow();
    await expect(
      verifyRetainedProcessExited(
        { verifyProcessExited: verifyLinuxProcessExited, inspectProcess: inspectLinuxProcess },
        before,
      ),
    ).resolves.toBeUndefined();
  });

  test("treats a zombie as neither exited nor inspectable", async () => {
    // The inner sleep exits first; its exec'd parent never reaps it.
    const parent = start("/bin/sh", ["-c", "/bin/sleep 0.05 & exec /bin/sleep 30"]);
    const [zombie] = await waitForChildren(parent.pid, 1);
    if (!zombie) throw new Error("Zombie candidate missing");
    await waitForState(zombie, "Z");
    await expect(verifyLinuxProcessExited(zombie)).rejects.toThrow("not proven");
    await expect(inspectLinuxProcess(zombie)).rejects.toThrow();
  });

  test("detects exec under an unchanged PID and birth", async () => {
    const child = start("/bin/sh", ["-c", "/bin/sleep 0.3; exec /bin/sleep 30"]);
    await waitForChildren(child.pid, 1);
    const before = await inspectLinuxProcess(child.pid);
    await waitForChildren(child.pid, 0);
    let after = await inspectLinuxProcess(child.pid);
    for (let attempt = 0; attempt < 100 && after.executable === before.executable; attempt++) {
      await delay(10);
      after = await inspectLinuxProcess(child.pid);
    }
    expect(after.startIdentity).toBe(before.startIdentity);
    expect(after.executable).toBe(realpathSync("/bin/sleep"));
    expect(after.argumentsSha256).toBe(digest(["/bin/sleep", "30"]));
    expect(after.argumentsSha256).not.toBe(before.argumentsSha256);
    await expect(
      verifyRetainedProcessExited(
        { verifyProcessExited: verifyLinuxProcessExited, inspectProcess: inspectLinuxProcess },
        before,
      ),
    ).rejects.toThrow("unproven");
  });

  const foreign = foreignProcess();
  test.skipIf(foreign === undefined)("refuses a process owned by another account", async () => {
    await expect(inspectLinuxProcess(foreign ?? 0)).rejects.toThrow("does not match Host");
  });

  test("refuses a thread identifier as a process", async () => {
    const thread = readdirSync(`/proc/${process.pid}/task`)
      .map(Number)
      .find((tid) => tid !== process.pid);
    if (!thread) throw new Error("Test process has no secondary thread");
    await expect(inspectLinuxProcess(thread)).rejects.toThrow("names a thread");
    await expect(verifyLinuxProcessExited(thread)).rejects.toThrow("not proven");
  });

  test("binds the cgroup to the observed lifetime", async () => {
    const own = readFileSync("/proc/self/cgroup", "utf8");
    const child = start("/bin/sleep", ["30"]);
    await waitForState(child.pid, "S");
    const { observation, cgroup } = await inspectLinuxProcessCgroup(child.pid);
    expect(observation.pid).toBe(child.pid);
    expect(cgroup).toBe(own);
  });
});

describe("process state changes during inspection", () => {
  function reader(finalState: string): LinuxProcessReader {
    let reads = 0;
    return {
      async readStat(pid) {
        reads++;
        return { pid, parentPid: 2, startTicks: 12345n, state: reads < 3 ? "S" : finalState };
      },
      async requireInspectable() {},
      async readChildren() {
        return [];
      },
      async readArguments() {
        return Buffer.from(["/usr/bin/sleep", "30", ""].join("\0"));
      },
      async readExecutable() {
        return "/usr/bin/sleep";
      },
      async readCgroup() {
        return "0::/fixture\n";
      },
    };
  }

  function running(finalState: string) {
    return inspectLinuxProcessSnapshot({
      pid: 42,
      uid: 1000,
      mode: "running",
      bootId: "4f1c2a3b-5d6e-4f70-8a9b-0c1d2e3f4a5b",
      ticksPerSecond: 100n,
      reader: reader(finalState),
    });
  }

  test.each(["T", "t", "Z", "X"])(
    "refuses final state %s after initially running",
    async (state) => {
      await expect(running(state)).rejects.toThrow("not running");
    },
  );

  test.each(["R", "S", "D"])("accepts a final running state %s", async (state) => {
    await expect(running(state)).resolves.toMatchObject({ observation: { pid: 42 } });
  });
});
