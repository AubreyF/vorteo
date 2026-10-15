import {
  createBootstrapRunnerEvidence,
  type RunnerPhase,
} from "./coordinator-bootstrap-evidence.js";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { open } from "node:fs/promises";
import { realpathSync, existsSync, readFileSync, openSync, fsyncSync, closeSync } from "node:fs";
import { writePrivateFileAtomicSync } from "../private-files.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, promisify } from "node:util";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { CoordinatorBootstrapRequest } from "@getpaseo/protocol/coordinator-bootstrap";
import { BootstrapRequestConflict, CoordinatorBootstrapRequests } from "./coordinator-bootstrap.js";
import { FileBootstrapRequestJournal } from "./coordinator-bootstrap-journal.js";
import {
  BootstrapAdmissionSetupSchema,
  readPrivateBootstrapConfiguration,
  readBootstrapHostBinding,
  type BootstrapAdmissionHost,
  createBootstrapReviewService,
  inspectBootstrapWritableMountRoots,
} from "./coordinator-bootstrap-host.js";
import {
  readBootstrapPreparedFile,
  verifyBootstrapReleaseArtifacts,
  assertBootstrapPathsProtected,
} from "./coordinator-bootstrap-artifact.js";
import { requireBootstrapOwnership } from "./coordinator-bootstrap-ownership.js";
import {
  createNativeBootstrapServiceReader,
  inspectBootstrapPythonExecutable,
  verifyRetainedProcessExited,
  loadedCoordinatorPid,
} from "./coordinator-bootstrap-service.js";
import {
  verifyBootstrapRecoveryArtifacts,
  registerBootstrapRecovery,
  removeCompletedBootstrapRecovery,
  bootstrapRecoveryLauncher,
} from "./coordinator-bootstrap-boot-recovery.js";
import { createBootstrapNativeLifecycle } from "./coordinator-bootstrap-native.js";
import {
  readBootstrapHealth,
  createBootstrapNativeOperations,
} from "./coordinator-bootstrap-runtime.js";
import {
  executeCoordinatorBootstrap,
  type BootstrapExecutorFailure,
  type BootstrapExecutorOperations,
} from "./coordinator-bootstrap-executor.js";
import { recoverAbandonedBootstrap } from "./coordinator-bootstrap-watchdog.js";
import {
  BootstrapExecutorRecordSchema,
  ProcessObservationSchema,
} from "./coordinator-bootstrap-process.js";
import {
  BootstrapRenewalSchema,
  RenewalGenerationSchema,
  deriveBootstrapRenewal,
  retainRenewalGeneration,
  verifyRenewalPlan,
  verifyRetainedRenewal,
} from "./coordinator-bootstrap-renewal.js";

const ExitObservationSchema = z.object({
  attempts: z.number().int().min(0).max(3),
  nextAttemptAt: z.number().finite(),
});
interface ReadOnlyObservation {
  file: string;
  inspect(): Promise<void>;
  now(): number;
  wait(milliseconds: number): Promise<void>;
}

export async function observeBootstrapExecutorExit(
  input: Omit<ReadOnlyObservation, "inspect"> & { verifyExited(): Promise<void> },
): Promise<void> {
  await observeBootstrap(
    { ...input, inspect: input.verifyExited },
    "Executor exit could not be verified after three observations. Inspect the retained recovery request; no lifecycle effect was retried.",
  );
}

export async function observeBootstrapReadiness(input: ReadOnlyObservation): Promise<void> {
  await observeBootstrap(
    input,
    "Startup dependencies were unavailable after three observations. Inspect the retained recovery request; no lifecycle effect was retried.",
  );
}

/** Consume a durable read-only attempt before observing. A crash never resets the budget. */
async function observeBootstrap(input: ReadOnlyObservation, failureMessage: string): Promise<void> {
  const backoff = [5_000, 15_000, 45_000];
  let state = existsSync(input.file)
    ? ExitObservationSchema.parse(JSON.parse(readFileSync(input.file, "utf8")))
    : { attempts: 0, nextAttemptAt: input.now() + backoff[0] };
  const retain = () => {
    writePrivateFileAtomicSync(input.file, JSON.stringify(state));
    for (const file of [input.file, path.dirname(input.file)]) {
      const descriptor = openSync(file, "r");
      try {
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
    }
  };
  retain();
  while (state.attempts < backoff.length) {
    await input.wait(Math.max(0, Math.min(45_000, state.nextAttemptAt - input.now())));
    state = {
      attempts: state.attempts + 1,
      nextAttemptAt: input.now() + (backoff[state.attempts + 1] ?? 0),
    };
    retain();
    try {
      await input.inspect();
      return;
    } catch {
      // Observation failures grant no lifecycle authority. Only read-only work retries.
    }
  }
  throw new BootstrapRequestConflict(failureMessage);
}

function watchdogRecoveryArguments(request: CoordinatorBootstrapRequest): string[] {
  return request.plan.automaticRecovery !== undefined ? ["automatic-recovery"] : [];
}

function findRunnerRequest(
  requests: CoordinatorBootstrapRequest[],
  role: "executor" | "watchdog" | "boot-watchdog",
  identifier: string,
) {
  return requests.find((request) =>
    role !== "watchdog" ? request.id === identifier : request.execution?.generation === identifier,
  );
}

const FileSchema = z.strictObject({
  path: z.string().startsWith("/"),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export const BootstrapRunnerSetupSchema = z.strictObject({
  admissionSetupFile: z.string().startsWith("/"),
  daemonId: z.string().min(1),
  node: FileSchema,
  entrypoint: FileSchema,
  ownerLauncher: FileSchema,
  ownershipVerifier: FileSchema,
  runtimeDirectory: z.string().startsWith("/"),
  runtimeSha256: z.string().regex(/^[a-f0-9]{64}$/),
  renewal: BootstrapRenewalSchema.optional(),
  maintenance: z
    .strictObject({
      installationRoot: z.string().startsWith("/"),
      admissionSha256: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .optional(),
});

/** The watchdog acknowledges its pre-lock wait; the executor acknowledges a
 * durable claim with its watchdog armed. Neither message proves completion. */
export function waitForBootstrapWatchdog(
  child: ChildProcess,
  role: "watchdog" | "executor" = "watchdog",
): Promise<void> {
  const expected = role === "watchdog" ? "waiting\n" : "dispatched\n";
  return new Promise((resolve, reject) => {
    let bytes = "";
    // Full installed dependency trees can take minutes to verify. This bounds
    // observation only; expiration never proves the executor stopped.
    const timer = setTimeout(() => finish(false), role === "watchdog" ? 10_000 : 15 * 60_000);
    const failed = () => finish(false);
    const data = (chunk: Buffer) => {
      bytes += chunk.toString("utf8");
      if (bytes === expected) finish(true);
      else if (bytes.length >= expected.length) finish(false);
    };
    const finish = (ready: boolean) => {
      clearTimeout(timer);
      child.removeListener("error", failed);
      child.removeListener("exit", failed);
      child.stdout?.removeListener("data", data);
      if (ready && child.exitCode === null && child.signalCode === null) resolve();
      else reject(new BootstrapRequestConflict("Bootstrap child did not become ready"));
    };
    if (!child.stdout || child.exitCode !== null || child.signalCode !== null) {
      finish(false);
      return;
    }
    child.once("error", failed);
    child.once("exit", failed);
    child.stdout.on("data", data);
  });
}

function nativeRunnerUid(): number {
  const uid = process.getuid?.();
  if (process.platform !== "darwin" || uid === undefined)
    throw new BootstrapRequestConflict("Native Host runner required");
  return uid;
}

/** Host observation may time out before validation finishes. Losing its pipe
 * cannot abort a durable claim or change the executor's recovery obligations. */
export function acknowledgeBootstrapDispatch(): void {
  process.stdout.on("error", () => {});
  try {
    process.stdout.write("dispatched\n");
  } catch {
    // The journal, not this best-effort notification, records dispatch.
  }
}

type RunnerSetup = z.infer<typeof BootstrapRunnerSetupSchema>;
function runnerRenewal(
  setup: RunnerSetup,
  setupFile: string,
  role: "executor" | "watchdog",
  admission: z.infer<typeof BootstrapAdmissionSetupSchema>,
  trace: ReturnType<typeof createBootstrapRunnerEvidence>["run"],
) {
  const uid = process.getuid!();
  const effectiveAdmission = setup.renewal
    ? { ...admission, configurationFile: setup.renewal.configuration.path }
    : admission;
  let armed = role === "watchdog";
  let dispatched: CoordinatorBootstrapRequest | undefined;
  const verifyRenewal = async () => {
    const renewal = setup.renewal;
    if (!renewal) return;
    await trace("renewal-retained", () =>
      verifyRetainedRenewal(setup, undefined, role === "watchdog"),
    );
    const retained = dispatched;
    if (retained)
      await trace("renewal-generation", () =>
        retainRenewalGeneration({ setup, setupFile, request: retained, watchdog: true }),
      );
    if (!armed) {
      if (setup.maintenance) {
        const { verifyMaintenanceBeforeDispatch } =
          await import("./coordinator-bootstrap-maintenance-runtime.js");
        await trace("renewal-derive", () => verifyMaintenanceBeforeDispatch(setup));
        return;
      }
      const original = BootstrapRunnerSetupSchema.parse(
        readPrivateBootstrapConfiguration(renewal.originalSetup.path, uid),
      );
      const reconstructed = await trace("renewal-derive", () =>
        deriveBootstrapRenewal({
          setupFile: renewal.originalSetup.path,
          setup: original,
          moduleFile: fileURLToPath(import.meta.url),
          dispatchedRequest: renewal.request,
        }),
      );
      const expected = { ...renewal, request: undefined };
      if (
        !reconstructed?.renewal ||
        !isDeepStrictEqual({ ...reconstructed.renewal, request: undefined }, expected)
      )
        throw new BootstrapRequestConflict("Renewal changed before dispatch fence");
    }
  };
  return {
    admission: effectiveAdmission,
    verify: verifyRenewal,
    markDispatched: (request: CoordinatorBootstrapRequest) => {
      dispatched = request;
      armed = true;
    },
    options: setup.renewal
      ? {
          setup: effectiveAdmission,
          verify: async (plan: CoordinatorBootstrapRequest["plan"]) => {
            await verifyRenewal();
            await trace("renewal-plan", () => verifyRenewalPlan(setup, plan));
          },
        }
      : undefined,
    async verifyApproval(request: CoordinatorBootstrapRequest) {
      await trace("renewal-retained", () =>
        verifyRetainedRenewal(setup, request, role === "watchdog"),
      );
      if (!setup.renewal) return;
      if (role === "executor" && setup.renewal.request?.revision !== request.revision)
        throw new BootstrapRequestConflict(
          "Renewal approval revision changed before executor admission",
        );
      if (role === "watchdog") {
        await retainRenewalGeneration({ setup, setupFile, request, watchdog: true });
        dispatched = request;
      }
    },
    verifyExecutorRecord(
      record: z.infer<typeof BootstrapExecutorRecordSchema>,
      request: CoordinatorBootstrapRequest,
    ) {
      if (!setup.renewal) return;
      if (
        record.planSha256 !== request.planSha256 ||
        record.process?.pid !== record.pid ||
        record.auditToken?.[1] !== uid ||
        record.auditToken[5] !== record.pid
      )
        throw new BootstrapRequestConflict("Renewal watchdog generation receipt changed");
    },
  };
}

function verifyRunnerExecutable(setup: RunnerSetup): void {
  if (
    realpathSync(process.execPath) !== setup.node.path ||
    fileURLToPath(import.meta.url) !== setup.entrypoint.path
  )
    throw new BootstrapRequestConflict(
      "Bootstrap runner executable does not match protected setup",
    );
  const relative = path.relative(setup.runtimeDirectory, setup.entrypoint.path);
  if (relative.startsWith("..") || path.isAbsolute(relative))
    throw new BootstrapRequestConflict("Runner is outside its prepared runtime");
}

/** Only the fixed protected Host launcher invokes this entrypoint. Browser input
 * supplies neither setup paths nor commands. An existing execution is never replayed. */
export async function runNativeBootstrap(
  setupFile: string,
  role: "executor" | "watchdog" | "boot-watchdog",
  identifier: string,
  descriptor: number,
): Promise<void> {
  const uid = nativeRunnerUid();
  z.string().uuid().parse(identifier);
  const readSetup = () =>
    BootstrapRunnerSetupSchema.parse(readPrivateBootstrapConfiguration(setupFile, uid));
  if (role === "boot-watchdog") setupFile = await resolveBootstrapBootSetup(setupFile, identifier);
  const setup = readSetup();
  verifyRunnerExecutable(setup);
  const admission = BootstrapAdmissionSetupSchema.parse(
    readPrivateBootstrapConfiguration(setup.admissionSetupFile, uid),
  );
  let evidence: ReturnType<typeof createBootstrapRunnerEvidence> | undefined;
  function trace<T>(phase: RunnerPhase, operation: () => Promise<T>): Promise<T> {
    return evidence ? evidence.run(phase, operation) : operation();
  }
  const renewal = runnerRenewal(
    setup,
    setupFile,
    role === "executor" ? "executor" : "watchdog",
    admission,
    trace,
  );
  const host = { ...renewal.admission, daemonId: setup.daemonId };
  const roots = await readRunnerMounts({ host, setupFile, setup, identifier, role });
  await assertBootstrapPathsProtected(
    [setupFile, setup.admissionSetupFile, setup.runtimeDirectory],
    roots,
  );
  for (const file of [setup.entrypoint, setup.ownerLauncher, setup.ownershipVerifier])
    await readBootstrapPreparedFile(file, roots);
  const requests = await createBootstrapReviewService(
    setup.admissionSetupFile,
    setup.daemonId,
    renewal.options,
  );
  const request = findRunnerRequest(requests.list(), role, identifier);
  if (bootRecoveryInactive(request, role)) return;
  if (!request || request.status !== "approved")
    throw new BootstrapRequestConflict("Exact bootstrap approval is unavailable");
  await assertBootstrapPathsProtected([request.plan.state.directory], roots);
  evidence = createBootstrapRunnerEvidence({
    directory: request.plan.state.directory,
    request,
    role,
  });
  const runnerEvidence = evidence;
  return trace("runner", async () => {
    if (role === "boot-watchdog") {
      await trace("boot-binding", () => verifyBootRunnerBinding(request, setupFile, setup));
      await trace("boot-artifacts", () => verifyBootstrapRecoveryArtifacts(request.plan, roots));
    }
    await trace("approval", () => renewal.verifyApproval(request));
    if (
      request.plan.candidate.directory !== setup.runtimeDirectory ||
      request.plan.candidate.artifactSha256 !== setup.runtimeSha256 ||
      !isDeepStrictEqual(request.plan.candidate.node, setup.node)
    )
      throw new BootstrapRequestConflict("Runner does not belong to the approved candidate");
    // The watchdog must not depend on reading the failed candidate tree to restore service.
    if (role === "executor")
      await trace("candidate-artifacts", () =>
        verifyBootstrapReleaseArtifacts(request.plan.candidate, roots),
      );
    const lockFile = path.join(
      request.plan.state.directory,
      "coordinator-bootstrap-execution.lock",
    );
    const verifySetup = async () =>
      trace("setup-files", async () => {
        if (
          !isDeepStrictEqual(readSetup(), setup) ||
          !isDeepStrictEqual(
            BootstrapAdmissionSetupSchema.parse(
              readPrivateBootstrapConfiguration(setup.admissionSetupFile, uid),
            ),
            admission,
          )
        )
          throw new BootstrapRequestConflict("Bootstrap runner setup changed");
        await trace("renewal-validation", () => renewal.verify());
      });
    const requireOwnership = async () => {
      await verifySetup();
      const writableMountRoots = await trace("ownership-mounts", () =>
        inspectBootstrapWritableMountRoots(host),
      );
      await trace("ownership-lock", () =>
        requireBootstrapOwnership({
          descriptor,
          lockFile,
          verifier: setup.ownershipVerifier,
          writableMountRoots,
        }),
      );
    };
    await requireOwnership();
    const reader = await createNativeBootstrapServiceReader({ ...host, writableMountRoots: roots });
    const executorFile = (generation: string) =>
      path.join(request.plan.state.directory, `coordinator-executor-${generation}.json`);
    const removeCompletedRecovery = async (terminal: CoordinatorBootstrapRequest) => {
      await removeCompletedBootstrapRecovery({
        request: terminal,
        writableMountRoots: await inspectBootstrapWritableMountRoots(host),
        requireTerminal: async () => {
          await requireOwnership();
          if (
            !isDeepStrictEqual(
              requests.list().find((item) => item.id === terminal.id),
              terminal,
            )
          )
            throw new BootstrapRequestConflict("Completed recovery ownership changed");
        },
      });
    };
    const recoverGeneration = async () => {
      const generation = request.execution?.generation;
      if (!generation) throw new BootstrapRequestConflict("Recovery generation is missing");
      if (["succeeded", "resumed", "rolled_back"].includes(request.execution!.stage)) {
        await removeCompletedRecovery(request);
        return;
      }
      const runnerIdentity = ProcessObservationSchema.parse(
        await reader.inspectProcess(process.pid),
      );
      const changedBoot = runnerIdentity.bootId !== request.plan.expectedProcess.bootId;
      if (changedBoot && role !== "boot-watchdog")
        throw new BootstrapRequestConflict(
          "Only the approved startup runner can recover another boot",
        );
      const verifyBootChanged = async () => {
        const current = ProcessObservationSchema.parse(await reader.inspectProcess(process.pid));
        if (
          !changedBoot ||
          current.pid !== process.pid ||
          current.uid !== uid ||
          !isDeepStrictEqual(current, runnerIdentity)
        )
          throw new BootstrapRequestConflict("Startup recovery native boot changed");
      };
      const record = BootstrapExecutorRecordSchema.parse(
        readPrivateBootstrapConfiguration(executorFile(generation), uid),
      );
      if (record.id !== request.id || record.generation !== generation)
        throw new BootstrapRequestConflict("Watchdog executor identity changed");
      renewal.verifyExecutorRecord(record, request);
      if (
        changedBoot &&
        (!record.process ||
          record.process.bootId !== request.plan.expectedProcess.bootId ||
          record.planSha256 !== request.planSha256)
      )
        throw new BootstrapRequestConflict("Startup recovery executor boot receipt is unavailable");
      const native = createBootstrapNativeLifecycle({
        requests,
        reader,
        configurationFile: host.configurationFile,
        launcherFile: host.launcherFile,
        writableMountRoots: () => inspectBootstrapWritableMountRoots(host),
        requireOwnership,
        recoveryBootId: changedBoot ? runnerIdentity.bootId : undefined,
        readHealth: async () => {
          const config = readPrivateBootstrapConfiguration(
            request.plan.previous.configuration.path,
            uid,
          );
          const port = z
            .object({ listenPort: z.number().int().positive() })
            .parse(config).listenPort;
          return readBootstrapHealth(port);
        },
      });
      const recovered = await recoverAbandonedBootstrap(
        requests,
        { id: record.id, generation },
        {
          withOwnership: async (operation) => {
            await requireOwnership();
            return operation();
          },
          verifyBootChanged: changedBoot ? verifyBootChanged : undefined,
          verifyExecutorExited: () =>
            changedBoot
              ? verifyBootChanged()
              : observeBootstrapExecutorExit({
                  file: path.join(
                    request.plan.state.directory,
                    `coordinator-exit-observation-${generation}.json`,
                  ),
                  verifyExited: () =>
                    record.process
                      ? verifyRetainedProcessExited(reader, record.process)
                      : reader.verifyProcessExited(record.pid),
                  now: Date.now,
                  wait: delay,
                }),
          verifyReplacement: native.verifyReplacement,
          verifyRollback: native.verifyRollback,
          resumePrevious: native.resumePrevious,
          restorePrevious: native.restorePrevious,
        },
      );
      if (["succeeded", "resumed", "rolled_back"].includes(recovered.execution!.stage))
        await removeCompletedRecovery(recovered);
      return;
    };
    if (role !== "executor") {
      await trace("recovery", recoverGeneration);
      return;
    }
    if (request.execution)
      throw new BootstrapRequestConflict("Bootstrap execution cannot be replayed");
    const armWatchdog = async (claimed: CoordinatorBootstrapRequest) => {
      if (!claimed.execution)
        throw new BootstrapRequestConflict("Bootstrap dispatch generation is missing");
      runnerEvidence.bind(claimed);
      await requireOwnership();
      const audited = await trace("watchdog-audit", () =>
        reader.inspectAuditedProcess(process.pid),
      );
      const record = BootstrapExecutorRecordSchema.parse({
        id: claimed.id,
        generation: claimed.execution.generation,
        pid: process.pid,
        planSha256: claimed.planSha256,
        process: audited.identity,
        auditToken: audited.auditToken,
      });
      await trace("watchdog-record", async () => {
        const file = await open(executorFile(record.generation), "wx", 0o600);
        try {
          await file.writeFile(JSON.stringify(record));
          await file.sync();
        } finally {
          await file.close();
        }
        const directory = await open(request.plan.state.directory, "r");
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      });
      if (setup.renewal)
        await trace("generation-retention", () =>
          retainRenewalGeneration({ setup, setupFile, request: claimed, watchdog: false }),
        );
      const source = await readBootstrapPreparedFile(
        setup.ownerLauncher,
        await inspectBootstrapWritableMountRoots(host),
      );
      const child = spawn(
        "/usr/bin/python3",
        [
          "-I",
          "-B",
          "-c",
          source.toString("utf8"),
          lockFile,
          setup.node.path,
          setup.entrypoint.path,
          setupFile,
          "watchdog",
          record.generation,
          ...watchdogRecoveryArguments(claimed),
        ],
        { detached: true, stdio: ["ignore", "pipe", "ignore"], env: { PATH: "/usr/bin:/bin" } },
      );
      // Keep an error listener after readiness so a detached child's later failure
      // cannot crash the executor. Recovery remains bound to durable stages.
      child.on("error", () => {});
      try {
        await trace("watchdog-readiness", () => waitForBootstrapWatchdog(child));
        renewal.markDispatched(claimed);
      } finally {
        child.stdout?.destroy();
        child.unref();
      }
      if (!child.pid)
        throw new BootstrapRequestConflict("Watchdog process identity is unavailable");
      await reader.inspectProcess(child.pid);
      if (child.exitCode !== null || child.signalCode !== null)
        throw new BootstrapRequestConflict("Watchdog exited before dispatch");
      await requireOwnership();
      acknowledgeBootstrapDispatch();
    };
    const operations: BootstrapExecutorOperations = await trace("native-operations", () =>
      createBootstrapNativeOperations({
        requests,
        approved: request,
        host,
        descriptor,
        lockFile,
        ownershipVerifier: setup.ownershipVerifier,
        verifySetup,
        armWatchdog,
        evidence: runnerEvidence,
      }),
    );
    if (request.plan.bootRecovery)
      operations.armBootRecovery = async (claimed) => {
        const recovery = claimed.plan.bootRecovery!;
        await verifyBootRunnerBinding(claimed, setupFile, setup);
        const requireClaim = async () => {
          await requireOwnership();
          const current = requests.list().find((item) => item.id === claimed.id);
          if (!isDeepStrictEqual(current, claimed) || current?.execution?.stage !== "claimed")
            throw new BootstrapRequestConflict("Startup recovery lost its claimed generation");
        };
        const pythonExecutable = await inspectBootstrapPythonExecutable();
        const [, ...pythonArguments] = bootstrapRecoveryLauncher(claimed.plan).ProgramArguments;
        const expectedArguments = createHash("sha256")
          .update(JSON.stringify([pythonExecutable, ...pythonArguments]))
          .digest("hex");
        await registerBootstrapRecovery({
          request: claimed,
          writableMountRoots: await inspectBootstrapWritableMountRoots(host),
          requireClaim,
          verifyServiceAbsent: () => reader.verifyServiceAbsent(recovery.service),
          register: async (domain, launcherFile) => {
            await promisify(execFile)("/bin/launchctl", ["bootstrap", domain, launcherFile], {
              env: { PATH: "/usr/bin:/bin" },
              timeout: 10_000,
              maxBuffer: 8192,
            });
          },
          verifyRegistered: async () => {
            const deadline = performance.now() + 15_000;
            for (;;) {
              await requireClaim();
              try {
                const service = await reader.readService(recovery.service);
                const pid = loadedCoordinatorPid(recovery.service, service);
                const observed = ProcessObservationSchema.parse(await reader.inspectProcess(pid));
                if (
                  !service.includes("\n\tprogram = /usr/bin/python3\n") ||
                  observed.pid !== pid ||
                  observed.uid !== uid ||
                  observed.executable !== pythonExecutable ||
                  observed.parentPid !== 1 ||
                  observed.bootId !== claimed.plan.expectedProcess.bootId ||
                  observed.argumentsSha256 !== expectedArguments ||
                  !isDeepStrictEqual(observed, await reader.inspectProcess(pid)) ||
                  loadedCoordinatorPid(
                    recovery.service,
                    await reader.readService(recovery.service),
                  ) !== pid
                )
                  throw new BootstrapRequestConflict("Startup recovery service identity changed");
                return;
              } catch {
                if (performance.now() >= deadline)
                  throw new BootstrapRequestConflict(
                    "Startup recovery did not establish readiness",
                  );
              }
              await delay(50);
            }
          },
        });
      };
    operations.recordFailure = async (
      failed: CoordinatorBootstrapRequest,
      failure: BootstrapExecutorFailure,
    ) => {
      if (!failed.execution)
        throw new BootstrapRequestConflict("Failed execution identity is missing");
      const diagnostic = path.join(
        failed.plan.state.directory,
        `coordinator-failure-${failed.execution.generation}.json`,
      );
      const file = await open(diagnostic, "wx", 0o600);
      try {
        await file.writeFile(
          JSON.stringify({
            version: 1,
            requestId: failed.id,
            generation: failed.execution.generation,
            planSha256: failed.planSha256,
            recordedAt: new Date().toISOString(),
            operation: failure.operation,
            stage: failure.stage,
          }),
        );
        await file.sync();
      } finally {
        await file.close();
      }
      const directory = await open(failed.plan.state.directory, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    };
    const result = await trace("executor-dispatch", () =>
      executeCoordinatorBootstrap(
        requests,
        { id: request.id, revision: request.revision, planSha256: request.planSha256 },
        operations,
      ),
    );
    if (result.execution?.stage !== "succeeded")
      throw new BootstrapRequestConflict("Bootstrap did not activate the replacement");
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [, , setup, role, identifier] = process.argv;
  if (setup && role === "maintenance-service") {
    void import("./coordinator-bootstrap-maintenance-service-runner.js")
      .then(({ runNativeMaintenanceService }) =>
        runNativeMaintenanceService(setup, process.argv.slice(4)),
      )
      .catch(() => {
        process.stderr.write("Native maintenance attempt requires retained observation.\n");
        process.exitCode = 1;
      });
  } else if (setup && role === "maintenance-launcher" && process.argv.length === 4) {
    void import("./coordinator-bootstrap-maintenance-controller.js")
      .then(({ runPersistentMaintenanceController }) => runPersistentMaintenanceController(setup))
      .catch(() => {
        process.stderr.write("Selected maintenance controller could not establish readiness.\n");
        process.exitCode = 1;
      });
  } else if (setup && identifier && role === "maintenance-control") {
    void import("./coordinator-bootstrap-maintenance-controller.js")
      .then(({ runMaintenanceControl }) =>
        runMaintenanceControl({
          installationRoot: setup,
          admissionSha256: identifier,
          ...(process.argv[5] ? { enrollmentSha256: process.argv[5] } : {}),
        }),
      )
      .catch(() => {
        process.stderr.write("Maintenance controls could not establish readiness.\n");
        process.exitCode = 1;
      });
  } else if (setup && identifier && role === "claimed-repair-control") {
    void import("./coordinator-bootstrap-claimed-control.js")
      .then(({ runProvisionedClaimedRepairControl }) =>
        runProvisionedClaimedRepairControl({
          installationRoot: setup,
          admissionSha256: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .parse(identifier),
        }),
      )
      .catch(() => {
        process.stderr.write("Provisioned repair controls could not establish readiness.\n");
        process.exitCode = 1;
      });
  } else if (setup && identifier && (role === "claimed-executor" || role === "claimed-observer")) {
    const [, , , , , revision, planSha256, generation] = process.argv;
    void import("./coordinator-bootstrap-claimed-runner.js")
      .then(async ({ runNativeClaimedRecovery }) => {
        if (role === "claimed-observer") z.string().uuid().parse(generation);
        const result = await runNativeClaimedRecovery(
          {
            setupFile: setup,
            identity: { id: identifier, revision: revision ?? "", planSha256: planSha256 ?? "" },
            recoveryDescriptor: Number(process.env.VORTEO_CLAIMED_LOCK_FD),
          },
          undefined,
          role === "claimed-observer" ? generation : undefined,
        );
        if (result.execution?.stage !== "succeeded")
          throw new BootstrapRequestConflict("Recovery did not establish a terminal result");
        return result;
      })
      .catch(() => {
        process.stderr.write("Bootstrap recovery requires recorded status inspection.\n");
        process.exitCode = 1;
      });
  } else if (
    setup &&
    identifier &&
    (role === "preclaim-executor" || role === "preclaim-observer")
  ) {
    const [, , , , , revision, planSha256, generation] = process.argv;
    void import("./coordinator-bootstrap-launch.js")
      .then(async ({ runNativePreclaimRecovery }) => {
        if (role === "preclaim-observer") z.string().uuid().parse(generation);
        const result = await runNativePreclaimRecovery(
          {
            setupFile: setup,
            identity: { id: identifier, revision: revision ?? "", planSha256: planSha256 ?? "" },
            recoveryDescriptor: Number(process.env.VORTEO_PRECLAIM_LOCK_FD),
          },
          undefined,
          role === "preclaim-observer" ? generation : undefined,
        );
        if (result.execution?.stage !== "succeeded")
          throw new BootstrapRequestConflict("Recovery did not establish a terminal result");
        return result;
      })
      .catch(() => {
        process.stderr.write("Bootstrap recovery requires recorded status inspection.\n");
        process.exitCode = 1;
      });
  } else if (
    !setup ||
    !identifier ||
    (role !== "executor" && role !== "watchdog" && role !== "boot-watchdog")
  )
    process.exitCode = 1;
  else
    void runNativeBootstrap(
      setup,
      role,
      identifier,
      Number(process.env.VORTEO_BOOTSTRAP_LOCK_FD),
    ).catch(() => {
      process.stderr.write("Coordinator bootstrap requires recovery inspection.\n");
      process.exitCode = 1;
    });
}

export async function verifyBootRunnerBinding(
  request: CoordinatorBootstrapRequest,
  setupFile: string,
  setup: RunnerSetup,
): Promise<void> {
  const recovery = request.plan.bootRecovery;
  if (
    !recovery ||
    recovery.requestId !== request.id ||
    !isDeepStrictEqual(recovery.node, setup.node) ||
    !isDeepStrictEqual(recovery.entrypoint, setup.entrypoint) ||
    !isDeepStrictEqual(recovery.ownerLauncher, setup.ownerLauncher)
  )
    throw new BootstrapRequestConflict("Startup runner does not match exact approved recovery");
  // A renewal's approval revision does not exist when its plan is prepared.
  // Pin the inert base setup, then allow only its exact approval envelope.
  const prepared = BootstrapRunnerSetupSchema.parse(
    JSON.parse((await readBootstrapPreparedFile(recovery.setup, [])).toString("utf8")),
  );
  if (!setup.renewal?.request) {
    if (setupFile !== recovery.setup.path || !isDeepStrictEqual(prepared, setup))
      throw new BootstrapRequestConflict("Startup setup differs from approved preparation");
    return;
  }
  const { request: approval, ...renewal } = setup.renewal;
  let inertSetup: RunnerSetup = { ...setup, renewal };
  if (setup.maintenance) {
    // The admission digest includes the plan, whose boot descriptor pins this
    // inert setup. Avoid a digest cycle by retaining admission only in the later
    // approval snapshot, and independently verify it before accepting that delta.
    const { verifyMaintenanceRetainedRuntime } =
      await import("./coordinator-bootstrap-maintenance-runtime.js");
    await verifyMaintenanceRetainedRuntime({ setup, request, watchdog: true, historical: false });
    const { maintenance: _admission, ...preparedRuntime } = inertSetup;
    inertSetup = preparedRuntime;
  }
  const expectedPath = path.join(
    request.plan.state.directory,
    `coordinator-renewal-${approval.id}-${approval.revision}.json`,
  );
  if (
    setupFile !== expectedPath ||
    approval.id !== request.id ||
    approval.planSha256 !== request.planSha256 ||
    !isDeepStrictEqual(prepared, inertSetup)
  )
    throw new BootstrapRequestConflict("Startup renewal differs from approved preparation");
}

/** Resolve the already retained generation without deriving from a new Host
 * runtime. This reads protected files only; mount checks precede all effects. */
export async function resolveBootstrapBootSetup(
  setupFile: string,
  identifier: string,
): Promise<string> {
  const uid = nativeRunnerUid();
  const setup = BootstrapRunnerSetupSchema.parse(readPrivateBootstrapConfiguration(setupFile, uid));
  if (!setup.renewal || setup.renewal.request) return setupFile;
  const host = readBootstrapHostBinding(setup.renewal.configuration.path, setup.daemonId);
  const request = new FileBootstrapRequestJournal(host.stateDirectory)
    .read()
    .find((item) => item.id === identifier);
  if (!request?.execution || request.status !== "approved") return setupFile;
  if (request.plan.bootRecovery?.setup.path !== setupFile)
    throw new BootstrapRequestConflict("Startup preparation belongs to a different request");
  const retained = RenewalGenerationSchema.parse(
    readPrivateBootstrapConfiguration(
      path.join(
        host.stateDirectory,
        `coordinator-renewal-generation-${request.execution.generation}.json`,
      ),
      uid,
    ),
  );
  const snapshot = BootstrapRunnerSetupSchema.parse(
    JSON.parse((await readBootstrapPreparedFile(retained.snapshot, [])).toString("utf8")),
  );
  if (
    retained.generation !== request.execution.generation ||
    !isDeepStrictEqual(retained.approval, snapshot.renewal?.request)
  )
    throw new BootstrapRequestConflict("Startup renewal generation changed");
  await verifyBootRunnerBinding(request, retained.snapshot.path, snapshot);
  return retained.snapshot.path;
}

function bootRecoveryInactive(
  request: CoordinatorBootstrapRequest | undefined,
  role: string,
): boolean {
  return (
    role === "boot-watchdog" &&
    request !== undefined &&
    (!request.execution || request.status !== "approved")
  );
}

/** Docker may become available after login. Retry only mount observation before
 * constructing any lifecycle capability; a persisted budget survives restart. */
async function readRunnerMounts(input: {
  role: "executor" | "watchdog" | "boot-watchdog";
  host: BootstrapAdmissionHost;
  setupFile: string;
  setup: RunnerSetup;
  identifier: string;
}): Promise<string[]> {
  const { host } = input;
  if (input.role !== "boot-watchdog") return inspectBootstrapWritableMountRoots(host);
  const currentHost = () => readBootstrapHostBinding(host.configurationFile, host.daemonId);
  const initial = currentHost();
  const requests = new CoordinatorBootstrapRequests(
    new FileBootstrapRequestJournal(initial.stateDirectory),
    () => currentHost().binding,
    async () => {
      throw new BootstrapRequestConflict("Startup observation cannot approve maintenance");
    },
  );
  const request = requests.list().find((entry) => entry.id === input.identifier);
  if (
    !request?.execution ||
    request.status !== "approved" ||
    request.plan.state.directory !== initial.stateDirectory
  )
    throw new BootstrapRequestConflict("Startup readiness has no approved recovery generation");
  await verifyBootRunnerBinding(request, input.setupFile, input.setup);
  let roots: string[] = [];
  await observeBootstrapReadiness({
    file: path.join(
      initial.stateDirectory,
      `coordinator-boot-readiness-${request.execution.generation}.json`,
    ),
    now: Date.now,
    wait: delay,
    inspect: async () => {
      const current = requests.list().find((entry) => entry.id === input.identifier);
      if (
        !current ||
        current.planSha256 !== request.planSha256 ||
        current.execution?.generation !== request.execution?.generation ||
        currentHost().stateDirectory !== initial.stateDirectory
      )
        throw new BootstrapRequestConflict("Startup readiness ownership changed");
      roots = await inspectBootstrapWritableMountRoots(host);
    },
  });
  return roots;
}
