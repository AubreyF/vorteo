import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  installationRoot,
  isPreviousWorker,
  reclaimListenAddress,
  systemListenReclaimPorts,
  type ListenerProcess,
  type ListenReclaimPorts,
} from "./listen-reclaim.js";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const step of cleanup.splice(0)) step();
});

const logger = { info: () => {}, warn: () => {}, error: () => {} };
const self = {
  pid: 4000,
  uid: 501,
  workerScript:
    "/Users/me/.local/share/vorteo-host/releases/reviewed-updates/b/packages/server/dist/scripts/daemon-worker.js",
};
const previous: ListenerProcess = {
  pid: 3000,
  uid: 501,
  command:
    "/usr/bin/node /Users/me/.local/share/vorteo-host/releases/reviewed-updates/a/packages/server/dist/scripts/daemon-worker.js",
};

function fakePorts(input: { busyProbes: number; holders: ListenerProcess[] }) {
  let probes = 0;
  const terminated: number[] = [];
  const slept: number[] = [];
  const ports: ListenReclaimPorts = {
    probe: async () => (probes++ < input.busyProbes ? "in-use" : "free"),
    listeners: async () => input.holders,
    terminate: async (pid) => {
      terminated.push(pid);
    },
    sleep: async (ms) => {
      slept.push(ms);
    },
  };
  return { ports, terminated, slept };
}

test("only a daemon worker of this installation run by this user is a previous worker", () => {
  expect(installationRoot(self.workerScript)).toBe("/Users/me/.local/share/vorteo-host/releases/");
  expect(isPreviousWorker(previous, self)).toBe(true);
  expect(isPreviousWorker({ ...previous, uid: 0 }, self)).toBe(false);
  expect(isPreviousWorker({ ...previous, pid: self.pid }, self)).toBe(false);
  expect(
    isPreviousWorker(
      { ...previous, command: "/usr/bin/node /opt/other-install/releases/x/daemon-worker.js" },
      self,
    ),
  ).toBe(false);
  expect(isPreviousWorker({ ...previous, command: "/usr/bin/python3 -m http.server" }, self)).toBe(
    false,
  );
});

test("a free address is used immediately", async () => {
  const fake = fakePorts({ busyProbes: 0, holders: [] });
  await reclaimListenAddress({ host: "127.0.0.1", port: 1, self, logger, ports: fake.ports });
  expect(fake.terminated).toEqual([]);
  expect(fake.slept).toEqual([]);
});

test("a previous worker holding the address is terminated, then the address is used", async () => {
  const fake = fakePorts({ busyProbes: 1, holders: [previous] });
  await reclaimListenAddress({ host: "127.0.0.1", port: 1, self, logger, ports: fake.ports });
  expect(fake.terminated).toEqual([previous.pid]);
  expect(fake.slept).toEqual([]);
});

test("another owner is never terminated; retries back off exponentially", async () => {
  const stranger = { pid: 5000, uid: 501, command: "/usr/bin/python3 -m http.server 6771" };
  const fake = fakePorts({ busyProbes: 4, holders: [stranger] });
  await reclaimListenAddress({ host: "127.0.0.1", port: 1, self, logger, ports: fake.ports });
  expect(fake.terminated).toEqual([]);
  expect(fake.slept).toEqual([1000, 2000, 4000, 8000]);
});

test("reclaim is bounded when a previous worker cannot be removed", async () => {
  const fake = fakePorts({ busyProbes: 5, holders: [previous] });
  await reclaimListenAddress({ host: "127.0.0.1", port: 1, self, logger, ports: fake.ports });
  expect(fake.terminated).toEqual([previous.pid, previous.pid, previous.pid]);
  expect(fake.slept).toEqual([1000, 2000]);
});

test("a real frozen predecessor that ignores SIGTERM is killed and its port freed", async () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "listen-reclaim-")));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const port = await new Promise<number>((resolve) => {
    const probe = net.createServer().listen(0, "127.0.0.1", () => {
      const value = (probe.address() as net.AddressInfo).port;
      probe.close(() => resolve(value));
    });
  });
  const oldWorker = path.join(root, "releases", "old", "daemon-worker.js");
  mkdirSync(path.dirname(oldWorker), { recursive: true });
  writeFileSync(
    oldWorker,
    `process.on("SIGTERM", () => {});
     require("node:net").createServer().listen(${port}, "127.0.0.1", () => process.stdout.write("listening\\n"));`,
  );
  const holder = spawn(process.execPath, [oldWorker], { stdio: ["ignore", "pipe", "inherit"] });
  cleanup.push(() => holder.kill("SIGKILL"));
  await new Promise((resolve) => holder.stdout.once("data", resolve));
  const exited = new Promise<NodeJS.Signals | null>((resolve) =>
    holder.once("exit", (_code, signal) => resolve(signal)),
  );
  await reclaimListenAddress({
    host: "127.0.0.1",
    port,
    self: {
      pid: process.pid,
      uid: process.getuid!(),
      workerScript: path.join(root, "releases", "new", "daemon-worker.js"),
    },
    logger,
    ports: systemListenReclaimPorts,
  });
  expect(await exited).toBe("SIGKILL");
  expect(await systemListenReclaimPorts.probe("127.0.0.1", port)).toBe("free");
}, 30_000);
