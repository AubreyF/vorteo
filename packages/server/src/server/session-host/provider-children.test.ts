import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createProviderChildRegistry, PROVIDER_CHILDREN_FILE_NAME } from "./provider-children.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "provider-children-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * A process table the registry consults instead of ps, plus the signals it sent. Negative pids
 * name process groups, as for process.kill; a group exists only when listed in `groups`.
 */
function fakeProcesses(table: Record<number, string>, groups: number[] = []) {
  const killed: number[] = [];
  return {
    killed,
    ports: {
      processCommand: async (pid: number) => table[pid] ?? null,
      kill: (pid: number) => {
        const exists = pid < 0 ? groups.includes(-pid) : pid in table;
        if (!exists) throw Object.assign(new Error("no such process"), { code: "ESRCH" });
        killed.push(pid);
      },
      now: () => new Date("2026-10-22T00:00:00Z"),
    },
  };
}

const CODEX = "/usr/local/bin/codex";
const MARKERS = [CODEX, "app-server"];

test("records children privately, forgets the ones that exit, and stops only live orphans", async () => {
  const dir = scratch();
  const processes = fakeProcesses(
    {
      101: `${CODEX} app-server --enable goals`,
      103: "node something-else-reused-the-pid",
      104: "/opt/other/app-server",
      105: `${CODEX} app-server`,
    },
    [105],
  );
  const registry = createProviderChildRegistry(dir, processes.ports);
  await registry.record({ pid: 101, markers: MARKERS, agentId: "agent-1" });
  await registry.record({ pid: 102, markers: MARKERS, agentId: "agent-2" });
  await registry.record({ pid: 103, markers: MARKERS, agentId: "agent-3" });
  await registry.record({ pid: 104, markers: MARKERS, agentId: "agent-4" });
  await registry.record({ pid: 105, markers: MARKERS, agentId: "agent-5" });
  const file = join(dir, PROVIDER_CHILDREN_FILE_NAME);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(JSON.parse(readFileSync(file, "utf8")).children).toHaveLength(5);

  // Agent 2's app-server exited normally.
  await registry.forget(102);

  // The next host start: 101 and 105 still run the recorded program, 102 is gone, 103 is another
  // program, and 104 carries one marker but not the binary. 105 leads a process group, so the
  // group is signalled; 101 does not, so it is signalled alone after the group attempt fails.
  const reaped = await registry.reapOrphans();
  expect(reaped.stopped.map((child) => child.pid)).toEqual([101, 105]);
  expect(reaped.dropped.map((child) => child.pid)).toEqual([103, 104]);
  expect(processes.killed).toEqual([101, -105]);
  expect(JSON.parse(readFileSync(file, "utf8")).children).toEqual([]);
});

test("a missing or corrupt file means nothing to stop", async () => {
  const dir = scratch();
  const processes = fakeProcesses({});
  const registry = createProviderChildRegistry(dir, processes.ports);
  expect(await registry.reapOrphans()).toEqual({ stopped: [], dropped: [] });
  const file = join(dir, PROVIDER_CHILDREN_FILE_NAME);
  await registry.record({ pid: 5, markers: MARKERS });
  const { writeFileSync } = await import("node:fs");
  writeFileSync(file, "{not json");
  expect(await registry.reapOrphans()).toEqual({ stopped: [], dropped: [] });
  expect(processes.killed).toEqual([]);
});

test("writes for one registry run in order, so a forget never resurrects a record", async () => {
  const dir = scratch();
  const registry = createProviderChildRegistry(dir, fakeProcesses({}).ports);
  await Promise.all([
    registry.record({ pid: 7, markers: MARKERS }),
    registry.forget(7),
    registry.record({ pid: 8, markers: MARKERS }),
  ]);
  const children = JSON.parse(readFileSync(join(dir, PROVIDER_CHILDREN_FILE_NAME), "utf8"))
    .children as { pid: number }[];
  expect(children.map((child) => child.pid)).toEqual([8]);
});
