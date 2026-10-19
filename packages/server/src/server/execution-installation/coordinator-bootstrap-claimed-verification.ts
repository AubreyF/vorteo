import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import path from "node:path";
import { spawn } from "node:child_process";
import { z } from "zod";
import {
  BootstrapClaimedRecoveryPlanSchema,
  BootstrapAuditedProcessSchema,
  BootstrapProcessIdentitySchema,
  type BootstrapClaimedRecoveryPlan,
} from "@getpaseo/protocol/coordinator-bootstrap";
import { BootstrapRequestConflict } from "./coordinator-bootstrap.js";
import { validateClaimedRecoveryPlan } from "./coordinator-bootstrap-claimed-recovery.js";
import {
  readBootstrapPreparedFile,
  verifyBootstrapReleaseArtifacts,
  assertBootstrapPathsProtected,
} from "./coordinator-bootstrap-artifact.js";
import {
  loadedCoordinatorPid,
  verifyLoadedBootstrapService,
  type NativeBootstrapServiceReader,
} from "./coordinator-bootstrap-service.js";

type FileIdentity = BootstrapClaimedRecoveryPlan["setup"];
type Reader = Pick<
  NativeBootstrapServiceReader,
  "inspectProcess" | "inspectAuditedProcess" | "verifyProcessExited" | "readService"
>;
const fileSchema = BootstrapClaimedRecoveryPlanSchema.shape.setup;
const requestSchema = z.strictObject({
  id: z.string().uuid(),
  revision: z.string().uuid(),
  planSha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const claimSchema = requestSchema.extend({ generation: z.string().uuid() });
export const ClaimedRecoveryObservationSchema = z.strictObject({
  version: z.literal(1),
  provenance: z.literal("observed-after-claim"),
  observedAt: z.string().datetime(),
  claim: claimSchema,
  dispatchApprovalRevision: z.string().uuid(),
  setup: fileSchema,
  inspector: fileSchema,
  ownerLauncher: fileSchema,
  executor: BootstrapAuditedProcessSchema,
  host: BootstrapProcessIdentitySchema,
  coordinator: BootstrapProcessIdentitySchema,
  executionLock: BootstrapClaimedRecoveryPlanSchema.shape.executionLock,
});

export async function verifyClaimedRetainedObservation(input: {
  plan: BootstrapClaimedRecoveryPlan;
  inspector: FileIdentity;
  writableMountRoots: readonly string[];
}): Promise<void> {
  const plan = validateClaimedRecoveryPlan(input.plan);
  const retained = ClaimedRecoveryObservationSchema.parse(
    JSON.parse(
      (
        await readBootstrapPreparedFile(plan.retainedObservation, input.writableMountRoots)
      ).toString("utf8"),
    ),
  );
  const expected = {
    version: 1,
    provenance: "observed-after-claim",
    observedAt: retained.observedAt,
    claim: {
      id: plan.original.id,
      revision: plan.original.revision,
      planSha256: plan.original.planSha256,
      generation: plan.original.execution!.generation,
    },
    dispatchApprovalRevision: plan.dispatchApprovalRevision,
    setup: plan.setup,
    inspector: input.inspector,
    ownerLauncher: plan.ownerLauncher,
    executor: plan.executor,
    host: plan.hostProcess,
    coordinator: plan.coordinatorProcess,
    executionLock: plan.executionLock,
  };
  if (
    !isDeepStrictEqual(retained, expected) ||
    Date.parse(retained.observedAt) < Date.parse(plan.original.execution!.updatedAt)
  )
    throw new BootstrapRequestConflict("Retained claimed observation changed");
  const setup = z
    .object({
      node: fileSchema,
      entrypoint: fileSchema,
      renewal: z.object({ hostProcess: BootstrapProcessIdentitySchema, request: requestSchema }),
    })
    .parse(
      JSON.parse(
        (await readBootstrapPreparedFile(plan.setup, input.writableMountRoots)).toString("utf8"),
      ),
    );
  if (
    !isDeepStrictEqual(setup.node, plan.runner.node) ||
    !isDeepStrictEqual(setup.entrypoint, plan.executorEntrypoint) ||
    !isDeepStrictEqual(setup.renewal.hostProcess, plan.hostProcess) ||
    !isDeepStrictEqual(setup.renewal.request, {
      id: plan.original.id,
      revision: plan.dispatchApprovalRevision,
      planSha256: plan.original.planSha256,
    })
  )
    throw new BootstrapRequestConflict("Claimed runner dispatch provenance changed");
}

/** Retained audit evidence permits only PPID becoming 1 after proven parent
 * exit. PID reuse, audit generation changes and another selected service fail. */
export async function verifyClaimedLiveProcesses(input: {
  plan: BootstrapClaimedRecoveryPlan;
  reader: Reader;
  inspector: FileIdentity;
  writableMountRoots: readonly string[];
}): Promise<void> {
  const plan = validateClaimedRecoveryPlan(input.plan);
  await verifyClaimedRetainedObservation(input);
  for (let observation = 0; observation < 2; observation++) {
    const coordinator = await input.reader.inspectProcess(plan.coordinatorProcess.pid);
    const executor = await input.reader.inspectAuditedProcess(plan.executor.identity.pid);
    const expected = structuredClone(plan.executor);
    if (executor.identity.parentPid === 1) {
      await input.reader.verifyProcessExited(plan.hostProcess.pid);
      expected.identity.parentPid = 1;
    } else if (
      !isDeepStrictEqual(await input.reader.inspectProcess(plan.hostProcess.pid), plan.hostProcess)
    ) {
      throw new BootstrapRequestConflict("Claimed recovery Host identity changed");
    }
    if (
      !isDeepStrictEqual(coordinator, plan.coordinatorProcess) ||
      !isDeepStrictEqual(executor, expected)
    )
      throw new BootstrapRequestConflict("Claimed recovery process identity changed");
    if (
      loadedCoordinatorPid(
        plan.original.plan.service,
        await input.reader.readService(plan.original.plan.service),
      ) !== plan.coordinatorProcess.pid
    )
      throw new BootstrapRequestConflict("Claimed recovery selected coordinator changed");
  }
}

/** A failed live inspection is never absence evidence. The protected native
 * reader must independently prove ESRCH; a reused PID remains a refusal. */
export async function observeClaimedExecutor(
  input: Parameters<typeof verifyClaimedLiveProcesses>[0],
): Promise<"running" | "exited"> {
  // Lost live visibility must not conceal changed retained provenance.
  await verifyClaimedRetainedObservation(input);
  try {
    await verifyClaimedLiveProcesses(input);
    return "running";
  } catch (error) {
    try {
      await input.reader.verifyProcessExited(input.plan.executor.identity.pid);
    } catch {
      throw error;
    }
    return "exited";
  }
}

export async function verifyClaimedSelectedService(input: {
  plan: BootstrapClaimedRecoveryPlan;
  reader: Reader;
  launcherFile: string;
  configurationFile: string;
  writableMountRoots: readonly string[];
}): Promise<void> {
  const plan = validateClaimedRecoveryPlan(input.plan);
  if (
    plan.selectedLauncher.path !== input.launcherFile ||
    plan.selectedConfiguration.path !== input.configurationFile
  )
    throw new BootstrapRequestConflict("Claimed recovery selected paths changed");
  for (let observation = 0; observation < 2; observation++) {
    await readBootstrapPreparedFile(plan.selectedLauncher, input.writableMountRoots);
    await readBootstrapPreparedFile(plan.selectedConfiguration, input.writableMountRoots);
    await verifyLoadedBootstrapService({
      plan: plan.original.plan,
      hostUid: plan.coordinatorProcess.uid,
      configurationFile: input.configurationFile,
      reader: input.reader,
    });
    if (
      !isDeepStrictEqual(
        await input.reader.inspectProcess(plan.coordinatorProcess.pid),
        plan.coordinatorProcess,
      )
    )
      throw new BootstrapRequestConflict("Claimed recovery coordinator identity changed");
  }
  await readBootstrapPreparedFile(plan.selectedLauncher, input.writableMountRoots);
  await readBootstrapPreparedFile(plan.selectedConfiguration, input.writableMountRoots);
}

// The installed v350 runner promotes under the legacy journal lock before any
// coordinator effect. Its exact bytes were inspected and exercised in races.
const supportedSource = "dc66750776e2534cd65f051e6aefa11dbfbe5513";
const supportedFiles: Record<string, string> = {
  "coordinator-bootstrap-runner.js":
    "5798c5ff6b703f31f240d14975730051224d8fb2eadc42d648f7404d5e428835",
  "coordinator-bootstrap-executor.js":
    "56abd8be342c1181df1ac4cf4fa0057814b6203842d1188c088ab8349444e802",
  "coordinator-bootstrap-journal.js":
    "7d3619ba062d8b4d8f11703ac3a5b4934f2c87bc1c9b5073079c8a3601cb0b24",
  "coordinator-bootstrap-runtime.js":
    "69d01a9d3131b2e0d7cad41c0d0a40de0019f949c0c8e835a31baed95fae1a8c",
  "coordinator-bootstrap-watchdog.js":
    "4df4afc14d13c95c639f4f68cfcf52a7ce06b27fb65b32cfe83a62c68e243df3",
  "coordinator-bootstrap.js": "3a5bca2374f52c9152ef4a8af8d54b006177c72bb08896191d1772950e711847",
};
interface SupportedClaimedRunner {
  files: Readonly<Record<string, string>>;
  ownerSha256: string;
}

// The later runner retains promotion under the same journal lock. Its added
// recovery fence rejects promotion in both orderings; ordinary executor and
// watchdog ownership still use the same inherited execution-lock descriptor.
const supportedRunners: Readonly<Record<string, SupportedClaimedRunner>> = {
  [supportedSource]: {
    files: supportedFiles,
    ownerSha256: "14ea30b57eac8802979b9e4d194e6efb2e943dc46ba40fec50ff0894efb29439",
  },
  "1bc87b11e3e6f42970d314b0319d4393d09d0d09": {
    files: {
      ...supportedFiles,
      "coordinator-bootstrap-runner.js":
        "5272355d819d71b2181cb77e90c1039ad57f4da60052a8aa06debac28dff0065",
      "coordinator-bootstrap-executor.js":
        "09547d55e884e3216d2eba7c7ebb91443f0d39c05391e6868d29f785b2a015a4",
      "coordinator-bootstrap-journal.js":
        "f5d7730501cb5d63655e21e3d05f61552a1561c51be363ba825cf63bfbda4744",
    },
    ownerSha256: "e82bf14c5cdad3d7f7bfaff2413923280c82cc3e173d291616695113224ef309",
  },
};

export async function verifySupportedClaimedRunner(input: {
  plan: BootstrapClaimedRecoveryPlan;
  daemonId: string;
  admissionSetupFile: string;
  anchor: {
    originalSetup: FileIdentity;
    originalAdmission: FileIdentity;
    terminal: { id: string; revision: string; generation: string; planSha256: string };
  };
  writableMountRoots: readonly string[];
}): Promise<void> {
  const plan = validateClaimedRecoveryPlan(input.plan);
  const supported = supportedRunners[plan.runner.sourceCommit];
  if (!supported)
    throw new BootstrapRequestConflict("Target runner is not supported for claimed recovery");
  const directory = path.join(
    plan.runner.directory,
    "packages/server/dist/server/server/execution-installation",
  );
  for (const [name, sha256] of Object.entries(supported.files))
    await readBootstrapPreparedFile(
      { path: path.join(directory, name), sha256 },
      input.writableMountRoots,
    );
  if (
    !isDeepStrictEqual(plan.ownerLauncher, {
      path: path.join(plan.runner.directory, "scripts/run-coordinator-owner.py"),
      sha256: supported.ownerSha256,
    })
  )
    throw new BootstrapRequestConflict("Target runner ownership launcher is not supported");
  await readBootstrapPreparedFile(plan.ownerLauncher, input.writableMountRoots);
  const { BootstrapRunnerSetupSchema } = await import("./coordinator-bootstrap-runner.js");
  const setup = BootstrapRunnerSetupSchema.parse(
    JSON.parse(
      (await readBootstrapPreparedFile(plan.setup, input.writableMountRoots)).toString("utf8"),
    ),
  );
  const expected = {
    daemonId: input.daemonId,
    admissionSetupFile: input.admissionSetupFile,
    node: plan.runner.node,
    entrypoint: plan.executorEntrypoint,
    ownerLauncher: plan.ownerLauncher,
    runtimeDirectory: plan.runner.directory,
    runtimeSha256: plan.runner.artifactSha256,
    ownershipVerifier: {
      path: path.join(plan.runner.directory, "scripts/verify-coordinator-owner.py"),
      sha256: "c9dcb2d3bbf1cdccdb198fdccd3701f43de9fe4f4510f6f466ac16b40639a1da",
    },
  };
  for (const key of Object.keys(expected) as (keyof typeof expected)[])
    if (!isDeepStrictEqual(setup[key], expected[key]))
      throw new BootstrapRequestConflict("Claimed runner setup changed");
  await readBootstrapPreparedFile(expected.ownershipVerifier, input.writableMountRoots);
  const renewal = setup.renewal;
  if (
    !renewal ||
    !isDeepStrictEqual(renewal.originalSetup, input.anchor.originalSetup) ||
    !isDeepStrictEqual(renewal.originalAdmission, input.anchor.originalAdmission) ||
    !isDeepStrictEqual(renewal.terminal, input.anchor.terminal) ||
    !isDeepStrictEqual(renewal.hostProcess, plan.hostProcess) ||
    !isDeepStrictEqual(renewal.configuration, plan.selectedConfiguration) ||
    !isDeepStrictEqual(renewal.request, {
      id: plan.original.id,
      revision: plan.dispatchApprovalRevision,
      planSha256: plan.original.planSha256,
    }) ||
    renewal.sourceCommit !== plan.runner.sourceCommit
  )
    throw new BootstrapRequestConflict("Claimed runner renewal provenance changed");
  for (const file of [renewal.originalSetup, renewal.originalAdmission, renewal.source])
    await readBootstrapPreparedFile(file, input.writableMountRoots);
  await verifyBootstrapReleaseArtifacts(plan.runner, input.writableMountRoots);
}

export async function verifyClaimedExecutionLock(input: {
  plan: BootstrapClaimedRecoveryPlan;
  writableMountRoots: readonly string[];
}): Promise<void> {
  const plan = validateClaimedRecoveryPlan(input.plan);
  await assertBootstrapPathsProtected([plan.executionLock.path], input.writableMountRoots);
  if ((await realpath(plan.executionLock.path)) !== plan.executionLock.path)
    throw new BootstrapRequestConflict("Claimed recovery execution lock is not canonical");
  const descriptor = await open(
    plan.executionLock.path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await descriptor.stat({ bigint: true });
    if (
      !stat.isFile() ||
      stat.uid !== BigInt(plan.executor.identity.uid) ||
      stat.nlink !== 1n ||
      (stat.mode & 0o077n) !== 0n ||
      String(stat.dev) !== plan.executionLock.device ||
      String(stat.ino) !== plan.executionLock.inode
    )
      throw new BootstrapRequestConflict("Claimed recovery execution lock changed");
  } finally {
    await descriptor.close();
  }
}

/** This helper role observes isolation only. It has no signaling or service
 * operation. Repeat audited observations on each side of its result. */
export async function verifyClaimedPreparationIsolation(
  input: Parameters<typeof verifyClaimedLiveProcesses>[0] & { helper: FileIdentity },
): Promise<void> {
  await verifyClaimedLiveProcesses(input);
  await verifyClaimedExecutionLock(input);
  const source = await readBootstrapPreparedFile(input.helper, input.writableMountRoots);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "/usr/bin/python3",
      [
        "-I",
        "-B",
        "-c",
        source.toString("utf8"),
        "preclaim-isolated",
        String(input.plan.executor.identity.pid),
      ],
      { env: { PATH: "/usr/bin:/bin" }, stdio: "ignore", timeout: 5000, killSignal: "SIGKILL" },
    );
    const failed = () =>
      reject(new BootstrapRequestConflict("Claimed executor isolation is unproven"));
    child.once("error", failed);
    child.once("close", (code) => (code === 0 ? resolve() : failed()));
  });
  await verifyClaimedLiveProcesses(input);
  await verifyClaimedExecutionLock(input);
}
