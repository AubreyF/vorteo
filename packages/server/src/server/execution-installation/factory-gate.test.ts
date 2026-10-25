import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import type { FactoryGateConfiguration } from "@getpaseo/protocol/execution-installation";
import { compareFactoryFacts, FactoryGate, factoryRestartClass } from "./factory-gate.js";
import type { EngineCommand, FactoryFacts } from "./factory-verify.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function gateConfig(): FactoryGateConfiguration {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "factory-gate-")));
  roots.push(root);
  const script = path.join(root, "verify.sh");
  const body = "#!/bin/sh\nexit 0\n";
  writeFileSync(script, body);
  chmodSync(script, 0o755);
  return {
    docker: process.execPath,
    socket: "/fixture/docker.sock",
    container: "a".repeat(64),
    verify: {
      script,
      sha256: createHash("sha256").update(body).digest("hex"),
      lockInode: 3901122,
      ownerMode: "paused",
    },
  };
}

const base: FactoryFacts = {
  ok: true,
  check: "all",
  epoch: 40,
  supervisorPid: 22,
  lockDevice: 53,
  lockInode: 3901122,
  ownerMode: "paused",
  ownerSequence: 14,
  custodyCount: 454,
  custodyDigest: "6".repeat(64),
};

/** A fake script: each call returns the next facts and honours the custody flags. */
function fakeScript(results: Partial<FactoryFacts>[]) {
  const calls: string[][] = [];
  const run: EngineCommand = async (_file, args) => {
    calls.push(args);
    const write = args.indexOf("--write-custody-list");
    if (write >= 0) writeFileSync(args[write + 1]!, "custody lines\n", { flag: "wx" });
    const facts = { ...base, ...results.shift() };
    if (!facts.ok)
      throw Object.assign(new Error("exit 1"), { stdout: `${JSON.stringify(facts)}\n` });
    return { stdout: `${JSON.stringify(facts)}\n` };
  };
  return { run, calls };
}

test("restart classes follow how the restart moves Factory's controller", () => {
  expect(factoryRestartClass({})).toBe("worker");
  expect(factoryRestartClass({ supervisorPlanSha256: "a" })).toBe("either");
  expect(factoryRestartClass({ engineRestartPlanSha256: "b" })).toBe("entry");
  const same = compareFactoryFacts(base, base, "worker");
  expect(same.problems).toEqual([]);
  expect(compareFactoryFacts(base, { ...base, supervisorPid: 31 }, "worker").problems).toEqual([
    "Factory's supervisor changed (22 to 31)",
  ]);
  const entry = { ...base, supervisorPid: 31, epoch: 41 };
  expect(compareFactoryFacts(base, entry, "entry").problems).toEqual([]);
  expect(compareFactoryFacts(base, base, "entry").problems).toHaveLength(2);
  expect(compareFactoryFacts(base, base, "either").problems).toEqual([]);
  expect(compareFactoryFacts(base, entry, "either").problems).toEqual([]);
  expect(compareFactoryFacts(base, { ...base, supervisorPid: 31 }, "either").problems).toEqual([
    "Factory's controller epoch did not rise (40 to 40)",
  ]);
});

test("while paused nothing Factory owns may change", () => {
  const check = (after: Partial<FactoryFacts>) =>
    compareFactoryFacts(base, { ...base, ...after }, "worker").problems;
  expect(check({ ownerSequence: 15 })).toEqual([
    "Factory's owner sequence changed while paused (14 to 15)",
  ]);
  expect(check({ custodyDigest: "7".repeat(64), custodyCount: 455 })).toEqual([
    "Factory's custody records changed while paused",
  ]);
  expect(check({ ownerMode: "running" })).toEqual(["Factory was resumed during the restart"]);
});

test("while running the sequence may only rise and the mode may only become paused", () => {
  const running = { ...base, ownerMode: "running" };
  const grew = compareFactoryFacts(
    running,
    { ...running, ownerSequence: 16, custodyCount: 456, custodyDigest: "7".repeat(64) },
    "worker",
  );
  expect(grew).toEqual({
    problems: [],
    notes: ["owner sequence 14 to 16", "2 new custody records"],
  });
  expect(
    compareFactoryFacts(running, { ...running, ownerSequence: 13 }, "worker").problems,
  ).toEqual(["Factory's owner sequence went backwards (14 to 13)"]);
  expect(compareFactoryFacts(running, { ...running, ownerMode: "paused" }, "worker").notes).toEqual(
    ["Factory was paused during the restart"],
  );
});

test("the gate passes an unchanged Factory, reuses its baseline and cleans up", async () => {
  const script = fakeScript([{}, {}]);
  const gate = new FactoryGate(gateConfig(), { run: script.run });
  await gate.before("job");
  await gate.before("job"); // An idle restart polling again reuses the baseline.
  expect(script.calls).toHaveLength(1);
  const list = script.calls[0]![script.calls[0]!.indexOf("--write-custody-list") + 1]!;
  expect(existsSync(list)).toBe(true);
  await expect(gate.after("job", "worker")).resolves.toBe(
    "Factory checks passed (epoch 40, owner paused 14, 454 custody records).",
  );
  expect(script.calls[1]).toContain("--custody-superset-of");
  expect(script.calls[1]![script.calls[1]!.indexOf("--custody-superset-of") + 1]).toBe(list);
  expect(existsSync(list)).toBe(false);
});

test("the gate refuses before any effect when Factory is not in a known good state", async () => {
  const failing = new FactoryGate(gateConfig(), {
    run: fakeScript([{ ok: false, check: "lock-identity-matches" }]).run,
  });
  await expect(failing.before("job")).rejects.toThrow(
    'Factory check "lock-identity-matches" failed before restarting Dev. Nothing was changed',
  );
  const old = new FactoryGate(gateConfig(), {
    run: fakeScript([{ custodyDigest: undefined }]).run,
  });
  await expect(old.before("job")).rejects.toThrow("predates custody digests");
});

test("the gate fails after the restart on a custody change or a moved controller", async () => {
  const removed = new FactoryGate(gateConfig(), {
    run: fakeScript([{}, { ok: false, check: "custody-superset" }]).run,
  });
  await removed.before("job");
  await expect(removed.after("job", "worker")).rejects.toThrow(
    'Dev restarted, but Factory check "custody-superset" failed',
  );
  const moved = new FactoryGate(gateConfig(), {
    run: fakeScript([{}, { epoch: 41, supervisorPid: 31 }]).run,
  });
  await moved.before("job");
  await expect(moved.after("job", "worker")).rejects.toThrow(
    "Factory's supervisor changed (22 to 31); Factory's controller epoch changed (40 to 41)",
  );
});

test("a running Factory that pauses during the restart is rechecked in paused mode", async () => {
  const config = gateConfig();
  config.verify.ownerMode = "running";
  const script = fakeScript([
    { ownerMode: "running" },
    { ok: false, check: "owner-mode", ownerMode: "paused" },
    { ownerMode: "paused" },
  ]);
  const gate = new FactoryGate(config, { run: script.run });
  await gate.before("job");
  await expect(gate.after("job", "worker")).resolves.toContain(
    "Factory was paused during the restart",
  );
  expect(script.calls[2]![script.calls[2]!.indexOf("--owner-mode") + 1]).toBe("paused");
  expect(script.calls[2]).toContain("--custody-superset-of");
});
