import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { compare } from "bcryptjs";
import { z } from "zod";
import type { BootstrapPreclaimRecoveryPlan } from "@getpaseo/protocol/coordinator-bootstrap";
import {
  BootstrapAuthenticationRequired,
  BootstrapRequestConflict,
} from "./coordinator-bootstrap.js";
import {
  ClaimedRepairProvisioningSchema,
  resolveClaimedRepairFiles,
  verifyRepairRuntimeReceipt,
} from "./coordinator-bootstrap-claimed-provisioning.js";
import {
  preclaimRecoveryPlanDigest,
  validatePreclaimRecoveryPlan,
} from "./coordinator-bootstrap-preclaim-recovery.js";
import { FileBootstrapRequestJournal } from "./coordinator-bootstrap-journal.js";
import {
  readBootstrapPreparedFile,
  readProtectedDocument,
} from "./coordinator-bootstrap-artifact.js";
import { writeRecoverySnapshot } from "./coordinator-bootstrap-launch.js";

/** An unclaimed approval cannot borrow admission for a claimed generation. */
export const PreclaimRepairProvisioningSchema = ClaimedRepairProvisioningSchema.extend({
  operation: z.literal("provision-preclaim-repair"),
  original: ClaimedRepairProvisioningSchema.shape.original.omit({ generation: true }),
});

export interface PreclaimRepairProvisioningInput {
  installationRoot: string;
  admissionSha256: string;
  plan: BootstrapPreclaimRecoveryPlan;
  writableMountRoots: readonly string[];
}

export async function resolvePreclaimRepairFiles(
  input: Omit<PreclaimRepairProvisioningInput, "plan">,
) {
  // Reuse the existing addressed admission artifacts, without its legacy-root
  // fallback. New preclaim consent must never overwrite an older repair.
  const files = await resolveClaimedRepairFiles(input);
  const directory = path.join(
    input.installationRoot,
    "claimed-repair-admissions",
    input.admissionSha256,
  );
  if (path.dirname(files.admission) !== directory)
    throw new BootstrapRequestConflict("Preclaim repair requires its exact admission directory");
  return files;
}

function assertOriginal(input: PreclaimRepairProvisioningInput) {
  const plan = validatePreclaimRecoveryPlan(input.plan);
  const records = new FileBootstrapRequestJournal(plan.original.plan.state.directory).read();
  if (
    plan.original.execution ||
    !isDeepStrictEqual(
      records.find((record) => record.id === plan.original.id),
      plan.original,
    )
  )
    throw new BootstrapRequestConflict("Exact unclaimed preclaim repair target changed");
}

async function verifyReceipt(
  input: PreclaimRepairProvisioningInput,
  receipt: z.infer<typeof PreclaimRepairProvisioningSchema>,
) {
  const plan = validatePreclaimRecoveryPlan(input.plan);
  const original = plan.original;
  if (
    !isDeepStrictEqual(receipt.original, {
      id: original.id,
      revision: original.revision,
      planSha256: original.planSha256,
    }) ||
    receipt.recoveryPlanSha256 !== preclaimRecoveryPlanDigest(plan)
  )
    throw new BootstrapRequestConflict("Preclaim repair admission changed its exact approval");
  await verifyRepairRuntimeReceipt({
    ...input,
    installationId: original.plan.installationId,
    service: original.plan.service,
    stateDirectory: original.plan.state.directory,
    runtimeDirectoryName: "preclaim-repair-runtimes",
    receipt,
  });
}

export async function verifyPreclaimRepairProposal(input: PreclaimRepairProvisioningInput) {
  const files = await resolvePreclaimRepairFiles(input);
  const bytes = await readBootstrapPreparedFile(
    { path: files.proposal, sha256: input.admissionSha256 },
    input.writableMountRoots,
  );
  const receipt = PreclaimRepairProvisioningSchema.parse(JSON.parse(bytes.toString("utf8")));
  if (createHash("sha256").update(JSON.stringify(receipt)).digest("hex") !== input.admissionSha256)
    throw new BootstrapRequestConflict("Preclaim repair proposal must be canonical");
  assertOriginal(input);
  await verifyReceipt(input, receipt);
  assertOriginal(input);
  return { receipt };
}

export async function verifyPreclaimRepairProvisioning(input: PreclaimRepairProvisioningInput) {
  const files = await resolvePreclaimRepairFiles(input);
  const stat = await lstat(files.admission);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0)
    throw new BootstrapRequestConflict("Preclaim repair admission must be private");
  const bytes = await readBootstrapPreparedFile(
    { path: files.admission, sha256: input.admissionSha256 },
    input.writableMountRoots,
  );
  const receipt = PreclaimRepairProvisioningSchema.parse(JSON.parse(bytes.toString("utf8")));
  await verifyReceipt(input, receipt);
  if (!bytes.equals(await readProtectedDocument(files.admission)))
    throw new BootstrapRequestConflict("Preclaim repair admission changed during inspection");
  return { receipt, admission: { path: files.admission, sha256: input.admissionSha256 } };
}

/** Provisioning admits immutable review machinery only. The existing preclaim
 * journal still requires its own exact owner decision before any process effect. */
export async function provisionPreclaimRepair(
  input: PreclaimRepairProvisioningInput & { ownerPassword: string },
) {
  const { receipt } = await verifyPreclaimRepairProposal(input);
  const plan = validatePreclaimRecoveryPlan(input.plan);
  const bytes = await readBootstrapPreparedFile(
    plan.selectedConfiguration,
    input.writableMountRoots,
  );
  const owner = z
    .object({
      public: z.object({ installationId: z.string().uuid() }),
      ownerPasswordHash: z.string().min(1),
    })
    .parse(JSON.parse(bytes.toString("utf8")));
  if (owner.public.installationId !== plan.original.plan.installationId)
    throw new BootstrapRequestConflict("Preclaim owner belongs to another installation");
  if (!(await compare(input.ownerPassword, owner.ownerPasswordHash)))
    throw new BootstrapAuthenticationRequired("Installation owner authentication required");
  await verifyPreclaimRepairProposal(input);
  await readBootstrapPreparedFile(plan.selectedConfiguration, input.writableMountRoots);
  assertOriginal(input);
  const files = await resolvePreclaimRepairFiles(input);
  await writeRecoverySnapshot(files.plan, plan);
  await writeRecoverySnapshot(files.admission, receipt);
  const directory = await open(
    path.dirname(files.admission),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
  return verifyPreclaimRepairProvisioning(input);
}
