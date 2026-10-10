import { spawn, type ChildProcess } from "node:child_process";
import { open } from "node:fs/promises";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { CoordinatorBootstrapRequest } from "@getpaseo/protocol/coordinator-bootstrap";
import { BootstrapRequestConflict } from "./coordinator-bootstrap.js";
import {
  BootstrapAdmissionSetupSchema,
  readPrivateBootstrapConfiguration,
  createBootstrapReviewService,
  inspectBootstrapWritableMountRoots,
} from "./coordinator-bootstrap-host.js";
import {
  readBootstrapPreparedFile,
  verifyBootstrapReleaseArtifacts,
  assertBootstrapPathsProtected,
} from "./coordinator-bootstrap-artifact.js";
import { requireBootstrapOwnership } from "./coordinator-bootstrap-ownership.js";
import { createNativeBootstrapServiceReader } from "./coordinator-bootstrap-service.js";
import { createBootstrapNativeLifecycle } from "./coordinator-bootstrap-native.js";
import {
  readBootstrapHealth,
  createBootstrapNativeOperations,
} from "./coordinator-bootstrap-runtime.js";
import { executeCoordinatorBootstrap } from "./coordinator-bootstrap-executor.js";
import { recoverAbandonedBootstrap } from "./coordinator-bootstrap-watchdog.js";
import { BootstrapExecutorRecordSchema } from "./coordinator-bootstrap-process.js";

function watchdogRecoveryArguments(request: CoordinatorBootstrapRequest): string[] {
  return request.plan.automaticRecovery !== undefined ? ["automatic-recovery"] : [];
}

function findRunnerRequest(
  requests: CoordinatorBootstrapRequest[],
  role: "executor" | "watchdog",
  identifier: string,
) {
  return requests.find((request) =>
    role === "executor" ? request.id === identifier : request.execution?.generation === identifier,
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

/** Only the fixed protected Host launcher invokes this entrypoint. Browser input
 * supplies neither setup paths nor commands. An existing execution is never replayed. */
export async function runNativeBootstrap(
  setupFile: string,
  role: "executor" | "watchdog",
  identifier: string,
  descriptor: number,
): Promise<void> {
  const uid = nativeRunnerUid();
  z.string().uuid().parse(identifier);
  const readSetup = () =>
    BootstrapRunnerSetupSchema.parse(readPrivateBootstrapConfiguration(setupFile, uid));
  const setup = readSetup();
  if (
    realpathSync(process.execPath) !== setup.node.path ||
    fileURLToPath(import.meta.url) !== setup.entrypoint.path
  )
    throw new BootstrapRequestConflict(
      "Bootstrap runner executable does not match protected setup",
    );
  const admission = BootstrapAdmissionSetupSchema.parse(
    readPrivateBootstrapConfiguration(setup.admissionSetupFile, uid),
  );
  const host = { ...admission, daemonId: setup.daemonId };
  const roots = await inspectBootstrapWritableMountRoots(host);
  await assertBootstrapPathsProtected(
    [setupFile, setup.admissionSetupFile, setup.runtimeDirectory],
    roots,
  );
  const relative = path.relative(setup.runtimeDirectory, setup.entrypoint.path);
  if (relative.startsWith("..") || path.isAbsolute(relative))
    throw new BootstrapRequestConflict("Runner is outside its prepared runtime");
  for (const file of [setup.entrypoint, setup.ownerLauncher, setup.ownershipVerifier])
    await readBootstrapPreparedFile(file, roots);
  const requests = await createBootstrapReviewService(setup.admissionSetupFile, setup.daemonId);
  const request = findRunnerRequest(requests.list(), role, identifier);
  if (!request || request.status !== "approved")
    throw new BootstrapRequestConflict("Exact bootstrap approval is unavailable");
  if (
    request.plan.candidate.directory !== setup.runtimeDirectory ||
    request.plan.candidate.artifactSha256 !== setup.runtimeSha256 ||
    !isDeepStrictEqual(request.plan.candidate.node, setup.node)
  )
    throw new BootstrapRequestConflict("Runner does not belong to the approved candidate");
  // The watchdog must not depend on reading the failed candidate tree to restore service.
  if (role === "executor") await verifyBootstrapReleaseArtifacts(request.plan.candidate, roots);
  const lockFile = path.join(request.plan.state.directory, "coordinator-bootstrap-execution.lock");
  const verifySetup = async () => {
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
  };
  const requireOwnership = async () => {
    await verifySetup();
    await requireBootstrapOwnership({
      descriptor,
      lockFile,
      verifier: setup.ownershipVerifier,
      writableMountRoots: await inspectBootstrapWritableMountRoots(host),
    });
  };
  await requireOwnership();
  const reader = await createNativeBootstrapServiceReader({ ...host, writableMountRoots: roots });
  const executorFile = (generation: string) =>
    path.join(request.plan.state.directory, `coordinator-executor-${generation}.json`);
  if (role === "watchdog") {
    const record = BootstrapExecutorRecordSchema.parse(
      readPrivateBootstrapConfiguration(executorFile(identifier), uid),
    );
    if (record.id !== request.id || record.generation !== identifier)
      throw new BootstrapRequestConflict("Watchdog executor identity changed");
    const native = createBootstrapNativeLifecycle({
      requests,
      reader,
      configurationFile: host.configurationFile,
      launcherFile: host.launcherFile,
      writableMountRoots: () => inspectBootstrapWritableMountRoots(host),
      requireOwnership,
      readHealth: async () => {
        const config = readPrivateBootstrapConfiguration(
          request.plan.previous.configuration.path,
          uid,
        );
        const port = z.object({ listenPort: z.number().int().positive() }).parse(config).listenPort;
        return readBootstrapHealth(port);
      },
    });
    await recoverAbandonedBootstrap(
      requests,
      { id: record.id, generation: identifier },
      {
        withOwnership: async (operation) => {
          await requireOwnership();
          return operation();
        },
        verifyExecutorExited: async () => {
          // Lock release can precede native process reaping. Observe the same PID
          // briefly; timeout never establishes death and never triggers a signal.
          const deadline = performance.now() + 5000;
          for (;;) {
            try {
              await reader.verifyProcessExited(record.pid);
              return;
            } catch (error) {
              if (performance.now() >= deadline) throw error;
            }
            await delay(50);
          }
        },
        resumePrevious: native.resumePrevious,
        restorePrevious: native.restorePrevious,
      },
    );
    return;
  }
  if (request.execution)
    throw new BootstrapRequestConflict("Bootstrap execution cannot be replayed");
  const armWatchdog = async (claimed: CoordinatorBootstrapRequest) => {
    if (!claimed.execution)
      throw new BootstrapRequestConflict("Bootstrap dispatch generation is missing");
    await requireOwnership();
    const audited = await reader.inspectAuditedProcess(process.pid);
    const record = BootstrapExecutorRecordSchema.parse({
      id: claimed.id,
      generation: claimed.execution.generation,
      pid: process.pid,
      planSha256: claimed.planSha256,
      process: audited.identity,
      auditToken: audited.auditToken,
    });
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
      await waitForBootstrapWatchdog(child);
    } finally {
      child.stdout?.destroy();
      child.unref();
    }
    if (!child.pid) throw new BootstrapRequestConflict("Watchdog process identity is unavailable");
    await reader.inspectProcess(child.pid);
    if (child.exitCode !== null || child.signalCode !== null)
      throw new BootstrapRequestConflict("Watchdog exited before dispatch");
    await requireOwnership();
    process.stdout.write("dispatched\n");
  };
  const operations = await createBootstrapNativeOperations({
    requests,
    approved: request,
    host,
    descriptor,
    lockFile,
    ownershipVerifier: setup.ownershipVerifier,
    verifySetup,
    armWatchdog,
  });
  const result = await executeCoordinatorBootstrap(
    requests,
    { id: request.id, revision: request.revision, planSha256: request.planSha256 },
    operations,
  );
  if (result.execution?.stage !== "succeeded")
    throw new BootstrapRequestConflict("Bootstrap did not activate the replacement");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [, , setup, role, identifier] = process.argv;
  if (!setup || !identifier || (role !== "executor" && role !== "watchdog")) process.exitCode = 1;
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
