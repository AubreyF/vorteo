import { test, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { RestartJobSchema } from "@getpaseo/protocol/execution-installation";
import { runSupervisorMaintenance, supervisorPlanDigest } from "./supervisor-maintenance.js";

test("supervisor execution binds reviewed bytes and fails before changed code can run", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "supervisor-plan-"));
  try {
    const script = path.join(root, "plan.mjs");
    const receipt = path.join(root, "receipt.json");
    const source = `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({id:process.env.VORTEO_RESTART_JOB_ID,force:process.env.VORTEO_RESTART_FORCE}));`;
    writeFileSync(script, source);
    const sha256 = createHash("sha256").update(source).digest("hex");
    const plan = { node: process.execPath, script, sha256 };
    expect(supervisorPlanDigest(plan)).toBe(sha256);
    expect(
      supervisorPlanDigest({ ...plan, node: path.join(root, "missing-node") }),
    ).toBeUndefined();
    const job = RestartJobSchema.parse({
      id: randomUUID(),
      revision: randomUUID(),
      target: "container-daemon",
      reason: "Isolated launcher repair",
      requestedBy: "host-agent",
      status: "running",
      detail: "Executing reviewed fixture",
      createdAt: new Date().toISOString(),
      expiresAt: "9999-12-31T23:59:59.999Z",
      supervisorPlanSha256: sha256,
      whenIdle: true,
    });
    await expect(
      runSupervisorMaintenance(plan, { ...job, supervisorPlanSha256: "b".repeat(64) }),
    ).rejects.toThrow("changed");
    expect(existsSync(receipt)).toBe(false);
    writeFileSync(script, source + "\n// changed");
    expect(supervisorPlanDigest(plan)).toBeUndefined();
    await expect(runSupervisorMaintenance(plan, job)).rejects.toThrow("no restart dispatched");
    expect(existsSync(receipt)).toBe(false);
    writeFileSync(script, source);
    await runSupervisorMaintenance(plan, job);
    expect(JSON.parse(readFileSync(receipt, "utf8"))).toEqual({ id: job.id, force: "0" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
