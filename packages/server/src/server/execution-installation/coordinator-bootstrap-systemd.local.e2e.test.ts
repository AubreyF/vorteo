import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFileSync, realpathSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, test } from "vitest";
import {
  inspectLinuxProcess,
  verifyLinuxProcessExited,
} from "./coordinator-bootstrap-linux-process.js";
import {
  createHostSystemdBootstrapServiceReader,
  isStoppedSystemdCandidate,
  systemdLoadedPid,
} from "./coordinator-bootstrap-systemd.js";

// Needs the account's running `systemd --user` manager, which CI runners lack.
const uid = process.getuid?.() ?? -1;

function systemctl(...args: string[]): string {
  return execFileSync("/usr/bin/systemctl", ["--user", ...args], { encoding: "utf8" }).trim();
}

describe.runIf(process.platform === "linux")("live systemd user service inspection", () => {
  const units: string[] = [];
  const children: ChildProcess[] = [];

  afterEach(async () => {
    // A unit may already be gone; either command then exits non-zero.
    for (const unit of units.splice(0)) {
      spawnSync("/usr/bin/systemctl", ["--user", "stop", unit], { stdio: "ignore" });
      spawnSync("/usr/bin/systemctl", ["--user", "reset-failed", unit], { stdio: "ignore" });
    }
    for (const child of children.splice(0)) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      child.kill("SIGKILL");
      await once(child, "exit");
    }
  });

  function transient(command: string[], options: { collect: boolean }) {
    const unit = `local.vorteo.e2e-${randomUUID().slice(0, 8)}.installation.service`;
    units.push(unit);
    execFileSync("/usr/bin/systemd-run", [
      "--user",
      `--unit=${unit}`,
      "--quiet",
      ...(options.collect ? ["--collect"] : []),
      ...command,
    ]);
    return { unit, service: `systemd-user/${uid}/${unit}` };
  }

  async function waitFor(unit: string, state: string): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (systemctl("show", unit, "--property=ActiveState", "--value") === state) return;
      await delay(10);
    }
    throw new Error(`${unit} did not reach ${state}`);
  }

  test("binds a running unit's main process to the user manager", async () => {
    const reader = await createHostSystemdBootstrapServiceReader({ writableMountRoots: [] });
    const { unit, service } = transient(["/bin/sleep", "300"], { collect: true });
    await waitFor(unit, "active");
    const pid = Number(systemctl("show", unit, "--property=MainPID", "--value"));
    const manager = Number(
      execFileSync("/usr/bin/systemctl", [
        "show",
        `user@${uid}.service`,
        "--property=MainPID",
        "--value",
      ])
        .toString()
        .trim(),
    );
    expect(systemdLoadedPid(service, await reader.readService(service))).toBe(pid);
    const observation = await reader.verifyServiceOwnership(service, pid);
    expect(observation).toMatchObject({
      pid,
      parentPid: manager,
      uid,
      executable: realpathSync("/bin/sleep"),
    });
    expect(await reader.inspectRunningProcess(pid)).toMatchObject({ pid, stopped: false });

    systemctl("stop", unit);
    await expect(reader.verifyServiceAbsent(service)).resolves.toBeUndefined();
    await expect(reader.verifyProcessExited(pid)).resolves.toBeUndefined();
  });

  test("refuses a process outside the unit even when the unit is running", async () => {
    const reader = await createHostSystemdBootstrapServiceReader({ writableMountRoots: [] });
    const { unit, service } = transient(["/bin/sleep", "300"], { collect: true });
    await waitFor(unit, "active");
    const outsider = spawn("/bin/sleep", ["300"], { stdio: "ignore" });
    children.push(outsider);
    if (!outsider.pid) throw new Error("Outsider did not start");
    await expect(reader.verifyServiceOwnership(service, outsider.pid)).rejects.toThrow("not owned");
    await expect(reader.verifyServiceAbsent(service)).rejects.toThrow("still loaded");
  });

  test("binds a stopped unit's loaded command", async () => {
    const reader = await createHostSystemdBootstrapServiceReader({ writableMountRoots: [] });
    const { unit, service } = transient(["/bin/false"], { collect: false });
    await waitFor(unit, "failed");
    const output = await reader.readService(service);
    expect(isStoppedSystemdCandidate({ service, output, expectedArguments: ["/bin/false"] })).toBe(
      true,
    );
    expect(() =>
      isStoppedSystemdCandidate({ service, output, expectedArguments: ["/bin/true"] }),
    ).toThrow("approved candidate");
    systemctl("reset-failed", unit);
    await expect(reader.verifyServiceAbsent(service)).resolves.toBeUndefined();
  });

  test("refuses a same-uid process in another PID namespace", async () => {
    const outer = spawn(
      "/usr/bin/unshare",
      ["--user", "--map-root-user", "--pid", "--fork", "--mount-proc", "/bin/sleep", "300"],
      { stdio: "ignore" },
    );
    children.push(outer);
    if (!outer.pid) throw new Error("Namespace process did not start");
    let inner: number | undefined;
    for (let attempt = 0; attempt < 200 && !inner; attempt++) {
      const text = readFileSync(`/proc/${outer.pid}/task/${outer.pid}/children`, "utf8").trim();
      inner = text ? Number(text.split(" ")[0]) : undefined;
      if (!inner) await delay(10);
    }
    if (!inner) throw new Error("Namespace child did not start");
    const uids = readFileSync(`/proc/${inner}/status`, "utf8").match(/^Uid:\s+(\d+)/m)?.[1];
    expect(Number(uids)).toBe(uid);
    await expect(inspectLinuxProcess(inner)).rejects.toThrow("another namespace");
    await expect(verifyLinuxProcessExited(inner)).rejects.toThrow("not proven");
  });
});
