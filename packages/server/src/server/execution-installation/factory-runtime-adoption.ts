import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, lstatSync, readFileSync, realpathSync } from "node:fs";
import { promisify } from "node:util";
import { z } from "zod";
import type { RestartJob } from "@getpaseo/protocol/execution-installation";
import type { InstallationConfig } from "./config.js";

const execute = promisify(execFile);
type AdoptionPlan = NonNullable<InstallationConfig["container"]["factoryRuntimeAdoption"]>;
const ReceiptSchema = z.strictObject({
  requestId: z.string().uuid(),
  planSha256: z.string().regex(/^[a-f0-9]{64}$/),
  phase: z.enum(["stage", "verify"]),
  serverId: z.string().min(1),
  previousPid: z.number().int().positive(),
  replacementPid: z.number().int().positive().nullable(),
});

function readPlan(plan: AdoptionPlan): Buffer {
  accessSync(plan.node, constants.X_OK);
  const file = lstatSync(plan.script);
  if (
    !file.isFile() ||
    file.uid !== process.getuid?.() ||
    (file.mode & 0o022) !== 0 ||
    realpathSync(plan.script) !== plan.script
  )
    throw new Error("Factory adoption requires an owner-controlled physical plan");
  const script = readFileSync(plan.script);
  if (createHash("sha256").update(script).digest("hex") !== plan.sha256)
    throw new Error("Factory adoption plan changed");
  return script;
}

export function factoryRuntimePlanDigest(plan: AdoptionPlan | undefined): string | undefined {
  if (!plan) return undefined;
  try {
    readPlan(plan);
    return plan.sha256;
  } catch {
    // A missing or changed reviewed plan cannot advertise an executable operation.
    return undefined;
  }
}

interface PhaseInput {
  plan: AdoptionPlan;
  job: RestartJob;
  phase: "stage" | "verify";
  serverId: string;
  previousPid: number;
  replacementPid: number | null;
}

/** The pinned Host plan stages source only. The existing coordinator performs the restart. */
export async function runFactoryRuntimePhase(input: PhaseInput): Promise<void> {
  const { plan, job, phase, serverId, previousPid, replacementPid } = input;
  if (
    job.target !== "container-daemon" ||
    job.factoryRuntimePlanSha256 !== plan.sha256 ||
    job.update ||
    job.supervisorPlanSha256
  )
    throw new Error("Factory adoption request does not match the reviewed plan");
  const script = readPlan(plan);
  const result = await execute(
    plan.node,
    ["--input-type=module", "--eval", script.toString("utf8")],
    {
      env: {
        ...process.env,
        VORTEO_FACTORY_ADOPTION_PHASE: phase,
        VORTEO_FACTORY_ADOPTION_REQUEST_ID: job.id,
        VORTEO_FACTORY_ADOPTION_RECOVERY_OF: job.factoryRuntimeRecoveryOf ?? "",
        VORTEO_FACTORY_ADOPTION_PLAN_SHA256: plan.sha256,
        VORTEO_FACTORY_ADOPTION_SERVER_ID: serverId,
        VORTEO_FACTORY_ADOPTION_PREVIOUS_PID: String(previousPid),
        VORTEO_FACTORY_ADOPTION_REPLACEMENT_PID:
          replacementPid === null ? "" : String(replacementPid),
      },
      timeout: 120_000,
      maxBuffer: 8192,
    },
  ).catch(() => {
    // execFile errors include the --eval source and stderr. Neither belongs in
    // a shared lifecycle receipt, including timeout and nonzero-exit failures.
    throw new Error(
      `Factory adoption ${phase} execution failed; inspect retained selection before recovery.`,
    );
  });
  let receipt: z.infer<typeof ReceiptSchema>;
  try {
    receipt = ReceiptSchema.parse(JSON.parse(result.stdout));
  } catch {
    throw new Error(
      `Factory adoption ${phase} returned an invalid receipt; inspect retained selection before recovery.`,
    );
  }
  if (
    receipt.requestId !== job.id ||
    receipt.planSha256 !== plan.sha256 ||
    receipt.phase !== phase ||
    receipt.serverId !== serverId ||
    receipt.previousPid !== previousPid ||
    receipt.replacementPid !== replacementPid
  )
    throw new Error(
      "Factory adoption receipt does not match this operation; retain it for recovery",
    );
}
