import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { compare } from "bcryptjs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { BootstrapClaimedRecoveryPlan } from "@getpaseo/protocol/coordinator-bootstrap";
import {
  BootstrapAuthenticationRequired,
  BootstrapRequestConflict,
} from "./coordinator-bootstrap.js";
import { FileBootstrapRequestJournal } from "./coordinator-bootstrap-journal.js";
import { writeRecoverySnapshot } from "./coordinator-bootstrap-launch.js";
import type { ClaimedRunnerSetupSchema } from "./coordinator-bootstrap-claimed-launch.js";
import {
  assertBootstrapPathsProtected,
  digestBootstrapArtifact,
  readBootstrapPreparedFile,
  readProtectedDocument,
} from "./coordinator-bootstrap-artifact.js";
import {
  claimedRecoveryPlanDigest,
  validateClaimedRecoveryPlan,
} from "./coordinator-bootstrap-claimed-recovery.js";

const FileSchema = z.strictObject({
  path: z.string().startsWith("/"),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});

/** A repair runtime has its own provenance. It must never acquire authority by
 * impersonating the selected Host release or rewriting its installation receipt. */
export const ClaimedRepairProvisioningSchema = z.strictObject({
  version: z.literal(1),
  operation: z.literal("provision-claimed-repair"),
  installationId: z.string().uuid(),
  installationRecord: FileSchema,
  original: z.strictObject({
    id: z.string().uuid(),
    revision: z.string().uuid(),
    generation: z.string().uuid(),
    planSha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  recoveryPlanSha256: z.string().regex(/^[a-f0-9]{64}$/),
  runtime: z.strictObject({
    directory: z.string().startsWith("/"),
    sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
    artifactSha256: z.string().regex(/^[a-f0-9]{64}$/),
    entrypoint: FileSchema,
    ownerLauncher: FileSchema,
    ownershipVerifier: FileSchema,
  }),
});

export interface ClaimedRepairProvisioningInput {
  /** Fixed by the trusted provisioner, never accepted from a browser or RPC. */
  installationRoot: string;
  /** Exact independently admitted receipt, not a hash read from that receipt. */
  admissionSha256: string;
  plan: BootstrapClaimedRecoveryPlan;
  writableMountRoots: readonly string[];
}

/** A new admission has its own immutable directory. Existing controllers retain
 * their exact legacy files; an invalid new directory never falls back to them. */
export async function resolveClaimedRepairFiles(input: {
  installationRoot: string;
  admissionSha256: string;
  writableMountRoots: readonly string[];
}) {
  const digest = z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .parse(input.admissionSha256);
  const parent = path.join(input.installationRoot, "claimed-repair-admissions");
  const directory = path.join(parent, digest);
  let selected = directory;
  try {
    await lstat(directory);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    selected = input.installationRoot;
  }
  const directories = selected === directory ? [parent, directory] : [];
  for (const candidate of directories) {
    const stat = await lstat(candidate);
    if (
      !stat.isDirectory() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o077) !== 0 ||
      (await realpath(candidate)) !== candidate
    )
      throw new BootstrapRequestConflict(
        "Repair admission directory must be private and canonical",
      );
  }
  await assertBootstrapPathsProtected(
    [input.installationRoot, ...directories],
    input.writableMountRoots,
  );
  return {
    plan: path.join(selected, "claimed-repair-plan.json"),
    proposal: path.join(selected, "claimed-repair-proposal.json"),
    admission: path.join(selected, "claimed-repair-admission.json"),
  };
}

/** Read-only verification for the first-repair provisioner. A valid artifact is
 * not approval: the caller must separately authenticate admission and retain a
 * visible exact recovery decision before invoking any executor. */
export async function verifyClaimedRepairProvisioning(input: ClaimedRepairProvisioningInput) {
  const root = input.installationRoot;
  if ((await realpath(root)) !== root)
    throw new BootstrapRequestConflict("Repair installation root must be canonical");
  const receiptFile = (await resolveClaimedRepairFiles(input)).admission;
  await assertBootstrapPathsProtected([root, receiptFile], input.writableMountRoots);
  const receiptStat = await lstat(receiptFile);
  if (!receiptStat.isFile() || (receiptStat.mode & 0o077) !== 0)
    throw new BootstrapRequestConflict("Repair admission must be a private regular file");
  const receiptBytes = await readBootstrapPreparedFile(
    { path: receiptFile, sha256: input.admissionSha256 },
    input.writableMountRoots,
  );
  const receipt = ClaimedRepairProvisioningSchema.parse(JSON.parse(receiptBytes.toString("utf8")));
  await verifyProvisioningReceipt(input, receipt);
  const finalBytes = await readProtectedDocument(receiptFile);
  if (!receiptBytes.equals(finalBytes))
    throw new BootstrapRequestConflict("Repair admission changed during verification");
  return {
    admission: {
      path: receiptFile,
      sha256: createHash("sha256").update(receiptBytes).digest("hex"),
    },
    receipt,
  };
}

/** Inspect a fixed proposal without admitting its runtime or granting effects. */
export async function verifyClaimedRepairProposal(input: ClaimedRepairProvisioningInput) {
  const file = (await resolveClaimedRepairFiles(input)).proposal;
  const bytes = await readBootstrapPreparedFile(
    { path: file, sha256: input.admissionSha256 },
    input.writableMountRoots,
  );
  const receipt = ClaimedRepairProvisioningSchema.parse(JSON.parse(bytes.toString("utf8")));
  // Admission serializes exactly this canonical representation. A proposal may
  // not pin one byte sequence and later admit a different representation.
  if (createHash("sha256").update(JSON.stringify(receipt)).digest("hex") !== input.admissionSha256)
    throw new BootstrapRequestConflict("Repair proposal is not canonical");
  await verifyProvisioningReceipt(input, receipt);
  new FileBootstrapRequestJournal(input.plan.original.plan.state.directory).verifyUnpromotedClaim(
    input.plan.original,
  );
  return { receipt };
}

async function verifyProvisioningReceipt(
  input: Omit<ClaimedRepairProvisioningInput, "admissionSha256">,
  receipt: z.infer<typeof ClaimedRepairProvisioningSchema>,
) {
  const plan = validateClaimedRecoveryPlan(input.plan);
  const root = input.installationRoot;
  if ((await realpath(root)) !== root)
    throw new BootstrapRequestConflict("Repair installation root must be canonical");
  await assertBootstrapPathsProtected([root], input.writableMountRoots);
  const recordFile = path.join(root, "installation.json");
  if (receipt.installationRecord.path !== recordFile)
    throw new BootstrapRequestConflict("Repair admission selected another installation record");
  const record = z
    .object({ root: z.string(), installationId: z.string().uuid(), coordinatorService: z.string() })
    .parse(
      JSON.parse(
        (
          await readBootstrapPreparedFile(receipt.installationRecord, input.writableMountRoots)
        ).toString("utf8"),
      ),
    );
  const original = plan.original;
  if (
    record.root !== root ||
    record.installationId !== receipt.installationId ||
    record.installationId !== original.plan.installationId ||
    record.coordinatorService !== original.plan.service ||
    original.plan.state.directory !== path.join(root, "state/coordinator") ||
    !isDeepStrictEqual(receipt.original, {
      id: original.id,
      revision: original.revision,
      generation: original.execution!.generation,
      planSha256: original.planSha256,
    }) ||
    receipt.recoveryPlanSha256 !== claimedRecoveryPlanDigest(plan)
  )
    throw new BootstrapRequestConflict("Repair admission does not match this exact claim");
  const runtime = receipt.runtime;
  const runtimeRoot = path.join(root, "claimed-repair-runtimes", runtime.sourceCommit);
  if (runtime.directory !== runtimeRoot || (await realpath(runtimeRoot)) !== runtimeRoot)
    throw new BootstrapRequestConflict("Repair runtime escaped its provisioned directory");
  const files = [
    [
      runtime.entrypoint,
      "packages/server/dist/server/server/execution-installation/coordinator-bootstrap-runner.js",
    ],
    [runtime.ownerLauncher, "scripts/run-coordinator-owner.py"],
    [runtime.ownershipVerifier, "scripts/verify-coordinator-owner.py"],
  ] as const;
  for (const [file, relative] of files) {
    if (file.path !== path.join(runtimeRoot, relative))
      throw new BootstrapRequestConflict("Repair runtime entrypoint changed");
    await readBootstrapPreparedFile(file, input.writableMountRoots);
  }
  await assertBootstrapPathsProtected([runtimeRoot], input.writableMountRoots);
  if ((await digestBootstrapArtifact(runtimeRoot)) !== runtime.artifactSha256)
    throw new BootstrapRequestConflict("Provisioned repair runtime changed");
  // Recheck the installation identity after traversing the runtime closure.
  await readBootstrapPreparedFile(receipt.installationRecord, input.writableMountRoots);
}

export interface ProvisionClaimedRepairInput extends Omit<
  ClaimedRepairProvisioningInput,
  "admissionSha256"
> {
  receipt: unknown;
  ownerPassword: string;
}

/** Authenticated one-time provisioning only. This does not approve recovery,
 * fence the original, select a release, start a process or restart a daemon.
 * The independently returned digest must pin the later control transport. */
export async function provisionClaimedRepair(input: ProvisionClaimedRepairInput) {
  const receipt = ClaimedRepairProvisioningSchema.parse(input.receipt);
  const plan = validateClaimedRecoveryPlan(input.plan);
  await verifyProvisioningReceipt(input, receipt);
  const journal = new FileBootstrapRequestJournal(plan.original.plan.state.directory);
  journal.verifyUnpromotedClaim(plan.original);
  const configurationBytes = await readBootstrapPreparedFile(
    plan.selectedConfiguration,
    input.writableMountRoots,
  );
  const configuration = z
    .object({
      public: z.object({ installationId: z.string().uuid() }),
      ownerPasswordHash: z.string().min(1),
    })
    .parse(JSON.parse(configurationBytes.toString("utf8")));
  if (configuration.public.installationId !== plan.original.plan.installationId)
    throw new BootstrapRequestConflict("Repair owner belongs to another installation");
  if (!(await compare(input.ownerPassword, configuration.ownerPasswordHash)))
    throw new BootstrapAuthenticationRequired("Installation owner authentication required");
  await verifyProvisioningReceipt(input, receipt);
  await readBootstrapPreparedFile(plan.selectedConfiguration, input.writableMountRoots);
  journal.verifyUnpromotedClaim(plan.original);
  const admissionSha256 = createHash("sha256").update(JSON.stringify(receipt)).digest("hex");
  const files = await resolveClaimedRepairFiles({ ...input, admissionSha256 });
  await writeRecoverySnapshot(files.plan, plan);
  const file = files.admission;
  await writeRecoverySnapshot(file, receipt);
  const directory = await open(path.dirname(file), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
  return verifyClaimedRepairProvisioning({
    ...input,
    admissionSha256: createHash("sha256").update(JSON.stringify(receipt)).digest("hex"),
  });
}

/** Bind a separately admitted executor without manufacturing a Host source
 * receipt. The retained Host snapshot must still pass normal renewal checks. */
export function assertProvisionedClaimedRuntimeBinding(input: {
  setup: z.infer<typeof ClaimedRunnerSetupSchema>;
  receipt: z.infer<typeof ClaimedRepairProvisioningSchema>;
  plan: BootstrapClaimedRecoveryPlan;
}) {
  const { setup, receipt, plan } = input;
  const provision = setup.provisioning;
  if (!provision) throw new BootstrapRequestConflict("Explicit repair provisioning is required");
  const host = provision.hostRuntime;
  const runtime = receipt.runtime;
  if (
    setup.runtimeDirectory !== runtime.directory ||
    setup.runtimeSha256 !== runtime.artifactSha256 ||
    !isDeepStrictEqual(setup.entrypoint, runtime.entrypoint) ||
    !isDeepStrictEqual(setup.ownerLauncher, runtime.ownerLauncher) ||
    !isDeepStrictEqual(setup.ownershipVerifier, runtime.ownershipVerifier) ||
    !isDeepStrictEqual(setup.node, host.node) ||
    setup.daemonId !== host.daemonId ||
    setup.admissionSetupFile !== host.admissionSetupFile ||
    !isDeepStrictEqual(setup.renewal, host.renewal) ||
    !isDeepStrictEqual(setup.renewal.configuration, plan.selectedConfiguration) ||
    !isDeepStrictEqual(setup.renewal.hostProcess, plan.hostProcess) ||
    !isDeepStrictEqual(setup.original, {
      id: plan.original.id,
      revision: plan.original.revision,
      planSha256: plan.original.planSha256,
    }) ||
    !isDeepStrictEqual(setup.renewal.request, setup.original) ||
    setup.stateDirectory !== plan.original.plan.state.directory ||
    setup.stateDirectory !== path.join(provision.installationRoot, "state/coordinator") ||
    setup.selectedLauncherFile !== plan.selectedLauncher.path
  )
    throw new BootstrapRequestConflict("Provisioned repair runtime binding changed");
  assertProvisionedControlParent({ setup, plan, provision });
}

function assertProvisionedControlParent(input: {
  setup: z.infer<typeof ClaimedRunnerSetupSchema>;
  plan: BootstrapClaimedRecoveryPlan;
  provision: NonNullable<z.infer<typeof ClaimedRunnerSetupSchema>["provisioning"]>;
}) {
  const { setup, plan, provision } = input;
  const parent = provision.controlProcess;
  const controlArgs = [
    setup.node.path,
    setup.entrypoint.path,
    provision.installationRoot,
    "claimed-repair-control",
    provision.admissionSha256,
  ];
  if (
    parent.pid === plan.hostProcess.pid ||
    parent.pid === plan.executor.identity.pid ||
    parent.pid === plan.coordinatorProcess.pid ||
    parent.uid !== plan.hostProcess.uid ||
    parent.bootId !== plan.hostProcess.bootId ||
    parent.executable !== setup.node.path ||
    parent.argumentsSha256 !==
      createHash("sha256").update(JSON.stringify(controlArgs)).digest("hex")
  )
    throw new BootstrapRequestConflict("Provisioned repair parent binding changed");
}

export async function verifyProvisionedClaimedRuntime(input: {
  setup: z.infer<typeof ClaimedRunnerSetupSchema>;
  plan: BootstrapClaimedRecoveryPlan;
  writableMountRoots: readonly string[];
  phase: "initial" | "retained" | "historical";
}) {
  const provision = input.setup.provisioning;
  if (!provision) throw new BootstrapRequestConflict("Explicit repair provisioning is required");
  const { receipt } = await verifyClaimedRepairProvisioning({
    installationRoot: provision.installationRoot,
    admissionSha256: provision.admissionSha256,
    plan: input.plan,
    writableMountRoots: input.writableMountRoots,
  });
  assertProvisionedClaimedRuntimeBinding({ ...input, receipt });
  const { verifyRetainedRenewal, verifyHistoricalRenewal } =
    await import("./coordinator-bootstrap-renewal.js");
  if (input.phase === "historical") await verifyHistoricalRenewal(provision.hostRuntime);
  else await verifyRetainedRenewal(provision.hostRuntime, undefined, input.phase === "retained");
  return provision.hostRuntime;
}
