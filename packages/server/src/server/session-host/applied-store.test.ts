import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createAppliedSeqStore } from "./applied-store.js";
import { sessionHostPaths } from "./host-files.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

test("applied records are private, ordered per agent and listed back by agent id", async () => {
  const home = mkdtempSync(join(tmpdir(), "applied-"));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const paths = sessionHostPaths(home);
  const store = createAppliedSeqStore(paths);
  const agentId = "agent/../with odd characters";
  await Promise.all([
    store.write(agentId, { hostId: "host-1", lastAppliedSeq: 3 }),
    store.write(agentId, { hostId: "host-1", lastAppliedSeq: 9 }),
  ]);
  await store.write("agent-2", { hostId: "host-1", lastAppliedSeq: 1 });
  expect(await store.read(agentId)).toEqual({ hostId: "host-1", lastAppliedSeq: 9 });
  expect(statSync(join(paths.directory, "applied")).mode & 0o777).toBe(0o700);
  const listed = await store.list();
  expect([...listed.keys()].sort()).toEqual(["agent-2", agentId].sort());
  for (const file of ["applied"])
    expect(statSync(join(paths.directory, file)).isDirectory()).toBe(true);
  await store.remove(agentId);
  expect(await store.read(agentId)).toBeNull();
  expect([...(await store.list()).keys()]).toEqual(["agent-2"]);
});
