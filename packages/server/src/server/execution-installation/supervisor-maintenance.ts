import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, readFileSync } from "node:fs";
import { promisify } from "node:util";
import type { RestartJob } from "@getpaseo/protocol/execution-installation";
import type { InstallationConfig } from "./config.js";

const execute = promisify(execFile);

export function supervisorPlanDigest(
  plan: InstallationConfig["container"]["supervisorMaintenance"],
): string | undefined {
  if (!plan) return undefined;
  try {
    accessSync(plan.node, constants.X_OK);
    const sha256 = createHash("sha256").update(readFileSync(plan.script)).digest("hex");
    return sha256 === plan.sha256 ? sha256 : undefined;
  } catch {
    // Unreadable scripts or unavailable executables cannot advertise maintenance capability.
    return undefined;
  }
}

export async function runSupervisorMaintenance(
  plan: NonNullable<InstallationConfig["container"]["supervisorMaintenance"]>,
  job: RestartJob,
): Promise<void> {
  if (job.target !== "container-daemon" || job.supervisorPlanSha256 !== plan.sha256)
    throw new Error("Supervisor maintenance plan is unavailable or changed");
  const script = readFileSync(plan.script);
  if (createHash("sha256").update(script).digest("hex") !== plan.sha256)
    throw new Error("Supervisor maintenance script changed; no restart dispatched");
  // Execute the verified buffer so replacing the script after review cannot change the operation.
  await execute(plan.node, ["--input-type=module", "--eval", script.toString("utf8")], {
    env: {
      ...process.env,
      VORTEO_RESTART_JOB_ID: job.id,
      VORTEO_RESTART_FORCE: job.whenIdle ? "0" : "1",
    },
    timeout: 360_000,
    maxBuffer: 8192,
  });
}
