// Test-only service adapter for machines without a usable service manager, such as CI
// runners without user systemd: each service runs as a detached process tracked by a pid
// file. Chosen only with VORTEO_SERVICE_MANAGER=process; it does not survive a reboot.
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { privateWrite } from "./primitives.mjs";

export function createProcessManager({ uid, home }) {
  const directory = path.join(home, ".local", "state", "vorteo-services");
  const file = (label) => path.join(directory, `${label}.json`);
  const pidFile = (label) => path.join(directory, `${label}.pid`);
  const alive = (label) => {
    try {
      const pid = Number(readFileSync(pidFile(label), "utf8"));
      process.kill(pid, 0);
      return pid;
    } catch {
      return null;
    }
  };
  async function stop(label) {
    const pid = alive(label);
    if (pid) process.kill(pid, "SIGTERM");
    for (let attempt = 0; attempt < 50 && alive(label); attempt += 1)
      await new Promise((resolve) => setTimeout(resolve, 100));
    rmSync(pidFile(label), { force: true });
  }
  async function start(label) {
    if (alive(label)) return;
    const service = JSON.parse(readFileSync(file(label), "utf8"));
    mkdirSync(path.dirname(service.log), { recursive: true, mode: 0o700 });
    const log = openSync(service.log, "a", 0o600);
    const child = spawn(service.argv[0], service.argv.slice(1), {
      env: service.env,
      detached: true,
      stdio: ["ignore", log, log],
    });
    child.unref();
    closeSync(log);
    privateWrite(pidFile(label), String(child.pid));
  }
  return {
    kind: "process",
    directory,
    file,
    // The coordinator's schema knows launchd and systemd; restarts through it are unavailable.
    descriptor: (label) => ({
      systemdService: { kind: "systemd-user", uid, unit: `${label}.service` },
    }),
    service: (label) => `process/${label}`,
    async preflight() {
      return [];
    },
    write(service) {
      privateWrite(file(service.label), JSON.stringify(service, null, 2));
    },
    isRegistered: async (label) => existsSync(file(label)),
    start,
    async reload(label) {
      await stop(label);
      await start(label);
    },
    async restart(label) {
      await stop(label);
      await start(label);
    },
    stop,
    async remove(label) {
      await stop(label);
      rmSync(file(label), { force: true });
    },
  };
}
