import { createMaintenanceChildCustody } from "./coordinator-bootstrap-maintenance-child-custody.js";
import {
  inspectSelectedMaintenanceExecutor,
  maintenanceExecutorStartupBinding,
  bindMaintenanceExecutorEvidence,
  requireReservedMaintenanceExecutor,
} from "./coordinator-bootstrap-maintenance-executor-evidence.js";
import { userInfo } from "node:os";
import {
  createMaintenanceServiceInspectionPorts,
  inspectMaintenanceServiceNative,
  inspectMaintenanceServiceReadiness,
} from "./coordinator-bootstrap-maintenance-service-inspection.js";
import {
  executeMaintenanceServiceReplacement,
  observeMaintenanceServiceReplacement,
} from "./coordinator-bootstrap-maintenance-service-native.js";
import path from "node:path";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { BootstrapProcessIdentitySchema } from "@getpaseo/protocol/coordinator-bootstrap";
import {
  BootstrapAdmissionSetupSchema,
  inspectBootstrapWritableMountRoots,
} from "./coordinator-bootstrap-host.js";
import { createNativeBootstrapServiceReader } from "./coordinator-bootstrap-service.js";
import { verifyMaintenanceLauncherArtifacts } from "./coordinator-bootstrap-maintenance-launcher.js";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { FileEnrollmentJournal } from "./maintenance/authorization.js";
import {
  assertMaintenanceServiceAdmission,
  type MaintenanceServiceAdmissionEvidence,
} from "./maintenance/service-admission.js";
import type { LifecycleWriteAdmission } from "./coordinator-bootstrap-journal.js";
import { BootstrapRequestConflict } from "./coordinator-bootstrap.js";
import { FileBootstrapRequestJournal } from "./coordinator-bootstrap-journal.js";
import {
  readProtectedDocument,
  readBootstrapPreparedFile,
  assertBootstrapPathsProtected,
} from "./coordinator-bootstrap-artifact.js";
import { readMaintenanceLauncherStartup } from "./coordinator-bootstrap-maintenance-startup.js";
import { inspectMaintenanceServiceExecution } from "./coordinator-bootstrap-maintenance-service-binding.js";
import { MaintenanceServiceJobSchema } from "@getpaseo/protocol/maintenance-service";

const InvocationSchema = z.tuple([
  z.string().uuid(),
  z.string().uuid(),
  z.string().uuid(),
  z.string().regex(/^[a-f0-9]{64}$/),
]);

/** Only immutable operation identifiers cross the process boundary. In
 * particular, a current queue CAS revision is not an approved revision. */
export function inspectMaintenanceServiceInvocation(
  args: readonly string[],
  input: Parameters<typeof inspectMaintenanceServiceExecution>[0],
) {
  const [requestId, approvedRevision, generation, planSha256] = InvocationSchema.parse(args);
  const context = inspectMaintenanceServiceExecution(input);
  if (
    requestId !== context.job.id ||
    approvedRevision !== context.reservation.requestRevision ||
    generation !== context.reservation.generation ||
    planSha256 !== context.planSha256
  )
    throw new BootstrapRequestConflict(
      "Native service invocation differs from retained reservation",
    );
  return context;
}

/** Read-only child loading. Native runtime, process custody, fresh evidence and
 * the lock-held standing admission callback are still required before effects. */
export async function readMaintenanceServiceInvocation(input: {
  executorSetupFile: string;
  args: readonly string[];
  account: { uid: number; home: string };
}) {
  const [requestId] = InvocationSchema.parse(input.args);
  const startup = await readMaintenanceLauncherStartup({
    setupFile: input.executorSetupFile,
    account: input.account,
  });
  const journal = new FileBootstrapRequestJournal(startup.setup.enrollmentStateDirectory);
  const readJob = () => {
    const matches = journal.readLifecycle().filter((job) => job.id === requestId);
    if (matches.length !== 1)
      throw new BootstrapRequestConflict("Native service request is missing or ambiguous");
    return MaintenanceServiceJobSchema.parse(matches[0]);
  };
  const job = readJob();
  if (job.proposal.installationId !== startup.plan.identity.installationId)
    throw new BootstrapRequestConflict("Native service request belongs to another installation");
  // The target and digest come from the retained schema-validated job, never
  // from a caller-supplied file path or executable argument.
  const planFile = path.join(
    startup.setup.installationRoot,
    "maintenance-services",
    job.target,
    "plans",
    `${job.proposal.planSha256}.json`,
  );
  const context = inspectMaintenanceServiceInvocation(input.args, {
    retained: job,
    reservation: job.reservation,
    plan: JSON.parse((await readProtectedDocument(planFile)).toString("utf8")),
    account: input.account,
  });
  if (
    !isDeepStrictEqual(job, readJob()) ||
    !isDeepStrictEqual(
      maintenanceExecutorStartupBinding(startup),
      maintenanceExecutorStartupBinding(
        await readMaintenanceLauncherStartup({
          setupFile: input.executorSetupFile,
          account: input.account,
        }),
      ),
    )
  )
    throw new BootstrapRequestConflict("Native service invocation changed during loading");
  return { ...context, startup, planFile, expectedRevision: job.revision };
}

/** The native child uses the same policy as the queue, but reads its grant only
 * after mutateLifecycle has acquired the shared installation lock. */
export function maintenanceServiceClaimAdmission(input: {
  stateDirectory: string;
  evidence: MaintenanceServiceAdmissionEvidence;
}): LifecycleWriteAdmission {
  const enrollment = new FileEnrollmentJournal(input.stateDirectory);
  return (previous, next) => {
    assertMaintenanceServiceAdmission({
      previous,
      next,
      state: enrollment.readUnderLifecycleLock(),
      evidence: input.evidence,
      now: Date.now(),
    });
  };
}

/** This binding is independently supplied by the kernel inspector. The runner
 * supplies its own module and process properties, never request-body values. */
export function inspectMaintenanceServiceChildIdentity(input: {
  invocation: Awaited<ReturnType<typeof readMaintenanceServiceInvocation>>;
  args: readonly string[];
  observation: unknown;
  runtime: {
    modulePath: string;
    executable: string;
    argv: readonly string[];
    pid: number;
    parentPid: number;
    uid: number;
  };
}) {
  const { startup } = input.invocation;
  const selected = startup.selected;
  const expected = [
    selected.node.path,
    selected.entrypoint.path,
    selected.setup.path,
    "maintenance-service",
    ...InvocationSchema.parse(input.args),
  ];
  const observed = BootstrapProcessIdentitySchema.parse(input.observation);
  if (
    input.runtime.modulePath !==
      path.join(
        selected.directory,
        "packages/server/dist/server/server/execution-installation/coordinator-bootstrap-maintenance-service-runner.js",
      ) ||
    input.runtime.executable !== selected.node.path ||
    !isDeepStrictEqual(input.runtime.argv, expected) ||
    observed.pid !== input.runtime.pid ||
    observed.parentPid !== input.runtime.parentPid ||
    observed.uid !== input.runtime.uid ||
    observed.uid !== startup.plan.identity.custodyOwnerUid ||
    observed.executable !== selected.node.path ||
    observed.argumentsSha256 !== createHash("sha256").update(JSON.stringify(expected)).digest("hex")
  )
    throw new BootstrapRequestConflict("Native service child is outside its selected runtime");
  return observed;
}

/** No effect occurs here. Rechecks remain usable after selection changes because
 * they pin this already admitted child's immutable bytes and native lifetime. */
export async function verifyNativeMaintenanceServiceInvocation(
  input: Parameters<typeof readMaintenanceServiceInvocation>[0],
) {
  const context = await readMaintenanceServiceInvocation(input);
  const admission = BootstrapAdmissionSetupSchema.parse(
    JSON.parse(
      (await readBootstrapPreparedFile(context.startup.setup.nativeAdmission, [])).toString("utf8"),
    ),
  );
  const roots = await inspectBootstrapWritableMountRoots(admission);
  const reader = await createNativeBootstrapServiceReader({
    ...admission,
    writableMountRoots: roots,
  });
  const verifyFiles = async () => {
    const currentRoots = await inspectBootstrapWritableMountRoots(admission);
    if (!isDeepStrictEqual(currentRoots, roots))
      throw new BootstrapRequestConflict("Native service child mount custody changed");
    await assertBootstrapPathsProtected(
      [
        input.executorSetupFile,
        context.planFile,
        context.startup.planFile,
        context.startup.setup.enrollmentStateDirectory,
        context.startup.setup.nativeAdmission.path,
      ],
      roots,
    );
    await readBootstrapPreparedFile(context.startup.setup.nativeAdmission, roots);
    await verifyMaintenanceLauncherArtifacts({
      plan: context.startup.plan,
      account: input.account,
      writableMountRoots: roots,
    });
    await verifyMaintenanceLauncherArtifacts({
      plan: context.plan,
      account: input.account,
      writableMountRoots: roots,
    });
  };
  const inspectSelf = async () =>
    inspectMaintenanceServiceChildIdentity({
      invocation: context,
      args: input.args,
      observation: await reader.inspectProcess(process.pid),
      runtime: {
        modulePath: fileURLToPath(import.meta.url),
        executable: await realpath(process.execPath),
        argv: process.argv,
        pid: process.pid,
        parentPid: process.ppid,
        uid: process.getuid?.() ?? -1,
      },
    });
  await verifyFiles();
  const executor = await inspectSelf();
  const currentInvocation = await readMaintenanceServiceInvocation(input);
  if (
    !isDeepStrictEqual(
      { ...context, startup: maintenanceExecutorStartupBinding(context.startup) },
      {
        ...currentInvocation,
        startup: maintenanceExecutorStartupBinding(currentInvocation.startup),
      },
    )
  )
    throw new BootstrapRequestConflict("Native service child request changed during verification");
  const requireExecutor = async () => {
    await verifyFiles();
    const current = await inspectSelf();
    if (!isDeepStrictEqual(current, executor))
      throw new BootstrapRequestConflict("Native service child lifetime changed");
    return current;
  };
  await requireExecutor();
  const childCustody = await createMaintenanceChildCustody({
    expected: executor,
    ...admission,
    writableMountRoots: roots,
  });
  return {
    ...context,
    childCustody,
    executor,
    reader,
    nativeAdmission: admission,
    writableMountRoots: roots,
    requireExecutor,
  };
}

/** One retained generation only. The existing queue owns reservation and final
 * observation; this child cannot approve, reserve, retry or consume another job. */
export async function runNativeMaintenanceService(setupFile: string, args: readonly string[]) {
  const owner = userInfo();
  const account = { uid: owner.uid, home: owner.homedir };
  const context = await verifyNativeMaintenanceServiceInvocation({
    executorSetupFile: setupFile,
    args,
    account,
  });
  const stateDirectory = context.startup.setup.enrollmentStateDirectory;
  const ports = await createMaintenanceServiceInspectionPorts({
    ...context.nativeAdmission,
    writableMountRoots: context.writableMountRoots,
  });
  const selectedExecutor = await inspectSelectedMaintenanceExecutor({
    setupFile,
    account,
    stateDirectory,
    writableMountRoots: context.writableMountRoots,
    ports,
  });
  if (!isDeepStrictEqual(selectedExecutor.startup.selected, context.startup.selected))
    throw new BootstrapRequestConflict("Child runtime differs from selected executor");
  requireReservedMaintenanceExecutor(context.job, selectedExecutor.executor);
  const targetEvidence = await inspectMaintenanceServiceNative({
    request: context.job,
    plan: context.plan,
    account,
    stateDirectory,
    writableMountRoots: context.writableMountRoots,
    ports,
  });
  const evidence = bindMaintenanceExecutorEvidence(targetEvidence, selectedExecutor);
  const { evidenceSha256, assertCurrent, ...record } = evidence;
  const observationInput = {
    stateDirectory,
    requestId: context.job.id,
    reservation: context.reservation,
    plan: context.plan,
    account,
    reader: context.reader,
    writableMountRoots: context.writableMountRoots,
  };
  return executeMaintenanceServiceReplacement({
    ...observationInput,
    expectedRevision: context.expectedRevision,
    executor: context.executor,
    evidence,
    requireExecutor: context.requireExecutor,
    admission: maintenanceServiceClaimAdmission({
      stateDirectory,
      evidence: {
        expectedRevision: context.expectedRevision,
        record,
        sha256: evidenceSha256,
        assertCurrent,
      },
    }),
    readCandidateObservation: (signal) =>
      observeMaintenanceServiceReplacement({
        ...observationInput,
        readObservation: () =>
          inspectMaintenanceServiceReadiness({
            ...observationInput,
            ports,
            signal,
          }),
      }),
  });
}
