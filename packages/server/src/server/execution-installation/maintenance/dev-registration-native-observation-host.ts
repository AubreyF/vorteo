import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { Readable, Writable } from "node:stream";
import { z } from "zod";
import {
  SupervisorEffectSchema,
  type SupervisorEffect,
} from "@getpaseo/protocol/execution-installation";
import type { InstallationStandingGrant } from "@getpaseo/protocol/installation-enrollment";
import { BootstrapRequestConflict, coordinatorPlanDigest } from "../coordinator-bootstrap.js";
import { FileBootstrapRequestJournal } from "../coordinator-bootstrap-journal.js";
import { verifyMaintenanceProposalFiles } from "../coordinator-bootstrap-maintenance-admission.js";
import type { MaintenanceObservationRuntime } from "../coordinator-bootstrap-maintenance-observation-runtime.js";
import {
  inspectBootstrapArtifact,
  readBootstrapPreparedFile,
  readProtectedDocument,
  verifyBootstrapPreparedDependency,
  assertBootstrapPathsProtected,
} from "../coordinator-bootstrap-artifact.js";
import { retainServiceFiles } from "../coordinator-bootstrap-maintenance-service-inspection.js";
import { bootstrapWritableMountRoots } from "../coordinator-bootstrap-host.js";
import { AuditedProcessObservationSchema } from "../coordinator-bootstrap-process.js";
import { verifyRetainedProcessExited } from "../coordinator-bootstrap-service.js";
import { FileEnrollmentJournal, enrollmentManifestDigest } from "./authorization.js";
import {
  collectDevRegistrationNativeObservation,
  DEV_REGISTRATION_NATIVE_OBSERVATION_SCRIPT,
  type DevRegistrationNativeObservationInvocation,
} from "./dev-registration-native-observation.js";
import type { PreparedDevRegistrationProvisioner } from "./dev-registration-provisioner.js";

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const MAX_BYTES = 1024 * 1024;
const COMMAND_MS = 10_000;
const FINAL_METADATA_MS = 2000;
const FACTORY_MS = 120_000;
const MODULE_RELATIVE =
  "packages/server/dist/server/server/execution-installation/maintenance/dev-registration-native-observation-host.js";
const containerSchema = z.object({
  Id: z.string(),
  State: z.object({ Running: z.literal(true) }),
  Path: z.string(),
  Args: z.array(z.string()),
  Config: z.object({
    Entrypoint: z.array(z.string()).nullable(),
    Cmd: z.array(z.string()).nullable(),
  }),
  Mounts: z.array(
    z.object({
      Type: z.string(),
      Source: z.string(),
      Destination: z.string(),
      RW: z.boolean(),
      Name: z.string().optional(),
    }),
  ),
});
const bytePinSchema = z.object({
  path: z.string().startsWith("/"),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  size: z
    .number()
    .int()
    .positive()
    .max(256 * 1024 * 1024),
});
type BytePin = z.infer<typeof bytePinSchema>;
interface ApprovedRuntime {
  directory: string;
  sourceCommit: string;
  artifactSha256: string;
  planSha256: string;
  node: { path: string; sha256: string };
  entrypoint: { path: string; sha256: string };
  files: string[];
}
interface ApprovedRuntimeEvidence extends ApprovedRuntime {
  assertCurrent(): void;
}
function approvedRuntimeData(value: ApprovedRuntime): ApprovedRuntime {
  const { directory, sourceCommit, artifactSha256, planSha256, node, entrypoint, files } = value;
  return { directory, sourceCommit, artifactSha256, planSha256, node, entrypoint, files };
}
interface LocalReadChild {
  stdout: Readable | null;
  stderr: Readable | null;
  stdin: Writable | null;
  once(event: string, listener: (...args: unknown[]) => void): unknown;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  kill(signal: NodeJS.Signals): boolean;
}
interface CommandOptions {
  timeoutMs: number;
  input: string;
}
export interface DevRegistrationObservationHostInput {
  runtime: MaintenanceObservationRuntime;
  requestId: string;
  provisioner: PreparedDevRegistrationProvisioner;
}
/** Native implementations are fixed below. Replacements are for inert source
 * tests, never a source of production authority or caller-selected commands. */
export interface DevRegistrationObservationHostPorts {
  grant(directory: string): InstallationStandingGrant;
  effect(directory: string, requestId: string): SupervisorEffect;
  approvedRuntime(
    installationRoot: string,
    admissionSha256: string,
    writableMountRoots: readonly string[],
  ): Promise<ApprovedRuntimeEvidence>;
  artifact: typeof inspectBootstrapArtifact;
  readFile: typeof readBootstrapPreparedFile;
  verifyFile: typeof verifyBootstrapPreparedDependency;
  protect: typeof assertBootstrapPathsProtected;
  retainFiles: typeof retainServiceFiles;
  retainSocket(file: string, uid: number): () => void;
  canonical(file: string): string;
  moduleFile(): string;
  observerArgv(): string[];
  readBytes(file: string): Buffer;
  spawn(file: string, args: string[]): LocalReadChild;
  commandSync(file: string, args: string[], options: CommandOptions): string;
  now(): number;
}
function requireObservation(ok: unknown, message: string): asserts ok {
  if (!ok) throw new BootstrapRequestConflict(message);
}
function synchronous(check: () => void): void {
  requireObservation(check() === undefined, "Observer custody must be synchronous");
}
function boundedBytes(file: string): Buffer {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    requireObservation(
      stat.isFile() && stat.size > 0 && stat.size <= 256 * 1024 * 1024,
      "Observer dependency byte limit exceeded",
    );
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      requireObservation(count > 0, "Observer dependency truncated");
      offset += count;
    }
    requireObservation(
      readSync(fd, Buffer.alloc(1), 0, 1, offset) === 0,
      "Observer dependency grew during read",
    );
    return bytes;
  } finally {
    closeSync(fd);
  }
}
function retainSocket(file: string, uid: number): () => void {
  const parent = retainServiceFiles([path.dirname(file)]);
  function identify() {
    const stat = lstatSync(file, { bigint: true });
    requireObservation(
      realpathSync(file) === file &&
        stat.isSocket() &&
        stat.uid === BigInt(uid) &&
        (stat.mode & 0o022n) === 0n,
      "Observer Docker socket custody differs",
    );
    return [stat.dev, stat.ino, stat.uid, stat.gid, stat.mode, stat.ctimeNs].join(":");
  }
  const captured = identify();
  return () => {
    parent();
    requireObservation(identify() === captured, "Observer Docker endpoint changed");
  };
}
const nativePorts: DevRegistrationObservationHostPorts = {
  grant(directory) {
    const state = new FileEnrollmentJournal(directory).readPolicySnapshot();
    requireObservation(state.status === "enrolled", "Observer enrollment is unavailable");
    return state.grant;
  },
  effect(directory, requestId) {
    const job = new FileBootstrapRequestJournal(directory)
      .readLifecycle()
      .find((item) => item.id === requestId);
    requireObservation(
      job && "supervisorEffect" in job && job.supervisorEffect,
      "Observer consumed claim is unavailable",
    );
    return SupervisorEffectSchema.parse(job.supervisorEffect);
  },
  async approvedRuntime(installationRoot, admissionSha256, writableMountRoots) {
    z.string()
      .regex(/^[a-f0-9]{64}$/)
      .parse(admissionSha256);
    const directory = path.join(installationRoot, "maintenance-admissions", admissionSha256);
    const names = ["admission.json", "proposal.json", "plan.json", "host.json", "runner.json"];
    const files = names.map((name) => path.join(directory, name));
    const assertFiles = retainServiceFiles(files);
    await readBootstrapPreparedFile(
      { path: files[0], sha256: admissionSha256 },
      writableMountRoots,
    );
    const snapshots = await Promise.all(files.slice(2).map((file) => readProtectedDocument(file)));
    const context = await verifyMaintenanceProposalFiles({
      installationRoot,
      receiptFile: { path: files[1], sha256: admissionSha256 },
      plan: JSON.parse(snapshots[0].toString("utf8")),
      hostSetup: JSON.parse(snapshots[1].toString("utf8")),
      runnerSetup: JSON.parse(snapshots[2].toString("utf8")),
      writableMountRoots,
    });
    assertFiles();
    const runtime = context.receipt.runtime;
    return {
      ...runtime,
      planSha256: coordinatorPlanDigest(context.plan),
      node: context.host.node,
      entrypoint: runtime.entrypoint,
      files,
      assertCurrent: assertFiles,
    };
  },
  artifact: inspectBootstrapArtifact,
  readFile: readBootstrapPreparedFile,
  verifyFile: verifyBootstrapPreparedDependency,
  protect: assertBootstrapPathsProtected,
  retainFiles: retainServiceFiles,
  retainSocket,
  canonical: realpathSync,
  moduleFile: () => fileURLToPath(import.meta.url),
  observerArgv: () => [process.execPath, ...process.execArgv, ...process.argv.slice(1)],
  readBytes: boundedBytes,
  spawn: (file, args) =>
    spawn(file, args, { env: { PATH: "/usr/bin:/bin" }, stdio: ["pipe", "pipe", "pipe"] }),
  commandSync: (file, args, options) =>
    execFileSync(file, args, {
      input: options.input,
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin" },
      timeout: options.timeoutMs,
      maxBuffer: MAX_BYTES,
    }),
  now: () => performance.now(),
};
function runtimeData(runtime: MaintenanceObservationRuntime) {
  return {
    installationRoot: runtime.installationRoot,
    stateDirectory: runtime.stateDirectory,
    account: runtime.account,
    nativeAdmission: runtime.nativeAdmission,
    admission: runtime.admission,
    writableMountRoots: runtime.writableMountRoots,
  };
}
function authority(effect: SupervisorEffect) {
  requireObservation(
    effect.phase !== "reserved" && effect.consumedAt && effect.child,
    "Observer needs an actual consumed child",
  );
  return {
    binding: effect.binding,
    reservedAt: effect.reservedAt,
    consumedAt: effect.consumedAt,
    child: effect.child,
  };
}
function under(root: string, file: string): boolean {
  return file.startsWith(root + path.sep) && path.normalize(file) === file;
}
interface ApprovedCodeCheck {
  approved: ApprovedRuntime;
  coordinator: InstallationStandingGrant["manifest"]["steps"][number] | undefined;
  argv: string[];
  moduleFile: string;
  canonical(file: string): string;
}
function assertApprovedCode(input: ApprovedCodeCheck): void {
  const { approved, coordinator, argv, moduleFile, canonical } = input;
  requireObservation(
    coordinator?.target === "coordinator" &&
      coordinator.planSha256 === approved.planSha256 &&
      coordinator.candidate.sourceCommit === approved.sourceCommit &&
      coordinator.candidate.artifactSha256 === approved.artifactSha256,
    "Observer runtime is not independently approved",
  );
  requireObservation(
    argv[0] === approved.node.path &&
      argv[1] === approved.entrypoint.path &&
      canonical(argv[1]) === argv[1] &&
      under(approved.directory, argv[1]),
    "Observer entrypoint is outside its independently approved runtime",
  );
  const observedModule = path.join(approved.directory, MODULE_RELATIVE);
  requireObservation(
    moduleFile === observedModule && canonical(moduleFile) === observedModule,
    "Observer module is outside its approved coordinator graph",
  );
}
function assertToolScope(
  plan: PreparedDevRegistrationProvisioner["plan"],
  admission: MaintenanceObservationRuntime["admission"],
): void {
  requireObservation(
    plan.docker.path === admission.docker &&
      plan.docker.socket === admission.socket &&
      plan.docker.containerId === admission.containerId &&
      plan.hostInspector.path === admission.helperPath &&
      plan.hostInspector.sha256 === admission.helperSha256,
    "Observer tool, endpoint or helper differs from protected Host setup",
  );
}
interface RetainedChildCheck {
  consumed: ReturnType<typeof authority>;
  provisioner: PreparedDevRegistrationProvisioner;
  approved: ApprovedRuntime;
  uid: number | undefined;
}
function assertRetainedChild(input: RetainedChildCheck) {
  const { consumed, provisioner, approved, uid } = input;
  const binding = consumed.binding;
  const script = binding.operation === "replace" ? provisioner : provisioner.rollback;
  const child = consumed.child.executor;
  requireObservation(
    hash(script.script) === script.sha256 &&
      binding.supervisorPlanSha256 === script.sha256 &&
      child.entrypoint.sha256 === script.sha256 &&
      child.executable.path === approved.node.path &&
      child.executable.sha256 === approved.node.sha256 &&
      child.uid === uid &&
      child.parentPid === binding.controller.pid &&
      child.argumentsSha256 ===
        hash(JSON.stringify([approved.node.path, "--input-type=module", "--eval", script.script])),
    "Observer retained child script or Host Node differs",
  );
  return child;
}

interface LocalObserverCheck {
  observed: z.infer<typeof AuditedProcessObservationSchema>;
  pid: number;
  uid: number | undefined;
  bootId: string;
  nodePath: string;
  argv: string[];
}
function assertLocalObserver(input: LocalObserverCheck): void {
  const { observed, pid, uid, bootId, nodePath, argv } = input;
  requireObservation(
    observed.identity.pid === pid &&
      observed.identity.uid === uid &&
      observed.identity.bootId === bootId &&
      observed.identity.executable === nodePath &&
      observed.identity.argumentsSha256 === hash(JSON.stringify(argv)),
    "Observer actual local lifetime or boot differs",
  );
}

/** No production caller or capability is installed here. A missing static
 * Docker pin or approved coordinator graph refuses before any Docker command. */
export async function observeDevRegistrationNativeFromHost(
  input: DevRegistrationObservationHostInput,
  supplied: DevRegistrationObservationHostPorts = nativePorts,
) {
  const ports = { ...supplied };
  const runtime = input.runtime;
  const assertRuntime = runtime.assertCurrent;
  const reader = runtime.ports.reader;
  const inspectObserver = reader.inspectAuditedProcess;
  const verifyExit = reader.verifyProcessExited;
  const inspectProcess = reader.inspectProcess;
  const original = structuredClone({
    runtime: runtimeData(runtime),
    requestId: input.requestId,
    provisioner: input.provisioner,
  });
  const observerPid = process.pid;
  const uid = process.getuid?.();
  const argv = [...ports.observerArgv()];
  const moduleFile = ports.moduleFile();
  const began = ports.now();
  const factoryDeadline = began + FACTORY_MS;
  let gate = false;
  let pending: Promise<string> | null = null;
  const custody: Array<() => void> = [];
  let approved: ApprovedRuntime | undefined;
  let retainedGrant:
    | {
        id: string;
        manifest: InstallationStandingGrant["manifest"];
        approval: InstallationStandingGrant["approval"];
      }
    | undefined;
  let capturedAuthority: ReturnType<typeof authority> | undefined;
  function unchanged() {
    requireObservation(
      input.runtime === runtime &&
        input.requestId === original.requestId &&
        isDeepStrictEqual(
          {
            runtime: runtimeData(runtime),
            requestId: input.requestId,
            provisioner: input.provisioner,
          },
          original,
        ) &&
        runtime.assertCurrent === assertRuntime &&
        runtime.ports.reader === reader &&
        reader.inspectAuditedProcess === inspectObserver &&
        reader.verifyProcessExited === verifyExit &&
        reader.inspectProcess === inspectProcess &&
        observerPid === process.pid &&
        uid === process.getuid?.() &&
        isDeepStrictEqual(argv, ports.observerArgv()) &&
        moduleFile === ports.moduleFile(),
      "Observer input, reader or local owner changed",
    );
    for (const [key, method] of Object.entries(ports))
      requireObservation(method === Reflect.get(supplied, key), "Observer native port changed");
  }
  function assertCustody() {
    unchanged();
    synchronous(assertRuntime);
    unchanged();
    for (const check of custody) {
      synchronous(check);
      unchanged();
    }
    if (retainedGrant) {
      const current = ports.grant(original.runtime.stateDirectory);
      requireObservation(
        isDeepStrictEqual(
          { id: current.id, manifest: current.manifest, approval: current.approval },
          retainedGrant,
        ),
        "Observer approved enrollment changed",
      );
    }
    if (capturedAuthority)
      requireObservation(
        isDeepStrictEqual(
          authority(ports.effect(original.runtime.stateDirectory, original.requestId)),
          capturedAuthority,
        ),
        "Observer consumed child changed",
      );
    unchanged();
  }
  function timeLeft(deadline: number, reserve = 0) {
    const remaining = Math.floor(deadline - ports.now() - reserve);
    requireObservation(remaining > 0, "Observer monotonic command budget exhausted");
    return remaining;
  }
  function assertFactory() {
    assertCustody();
    timeLeft(factoryDeadline);
  }
  assertFactory();
  requireObservation(
    process.platform === "darwin" && uid === original.runtime.account.uid,
    "Observer requires the actual native Host account",
  );
  const grant = ports.grant(original.runtime.stateDirectory);
  retainedGrant = structuredClone({
    id: grant.id,
    manifest: grant.manifest,
    approval: grant.approval,
  });
  const manifestSha = enrollmentManifestDigest(grant.manifest);
  requireObservation(
    grant.approval.manifestSha256 === manifestSha &&
      grant.manifest.installationId === original.provisioner.plan.installationId &&
      grant.manifest.provisioning,
    "Observer has no approved provisioned coordinator scope",
  );
  const effect = SupervisorEffectSchema.parse(
    ports.effect(original.runtime.stateDirectory, original.requestId),
  );
  capturedAuthority = structuredClone(authority(effect));
  const binding = capturedAuthority.binding;
  requireObservation(
    binding.requestId === original.requestId &&
      binding.grantId === grant.id &&
      binding.manifestSha256 === manifestSha &&
      binding.registrationPlanSha256 === original.provisioner.planSha256 &&
      hash(JSON.stringify(original.provisioner.plan)) === original.provisioner.planSha256,
    "Observer claim differs from approved static plan",
  );
  const step = grant.manifest.steps.find((item) => item.id === binding.stepId);
  requireObservation(
    step?.target === "supervisor" &&
      step.planSha256 === binding.requestPlanSha256 &&
      step.candidate.sourceCommit === binding.sourceCommit &&
      step.candidate.artifactSha256 === binding.artifactSha256,
    "Observer registration step differs",
  );
  const approvedEvidence = await ports.approvedRuntime(
    original.runtime.installationRoot,
    grant.manifest.provisioning.admissionSha256,
    original.runtime.writableMountRoots,
  );
  const assertApprovedFiles = approvedEvidence.assertCurrent;
  approved = structuredClone(approvedRuntimeData(approvedEvidence));
  const approvedSnapshot = structuredClone(approved);
  custody.push(() => {
    synchronous(assertApprovedFiles);
    requireObservation(
      approvedEvidence.assertCurrent === assertApprovedFiles &&
        isDeepStrictEqual(approvedRuntimeData(approvedEvidence), approvedSnapshot),
      "Observer approved runtime evidence changed",
    );
  });
  assertFactory();
  const coordinator = grant.manifest.steps.find(
    (item) => item.id === grant.manifest.provisioning?.coordinatorStepId,
  );
  assertApprovedCode({ approved, coordinator, argv, moduleFile, canonical: ports.canonical });
  const artifact = await ports.artifact(approved.directory, {
    timeoutMs: timeLeft(factoryDeadline),
    maxFiles: 250000,
    maxBytes: 4 * 1024 * 1024 * 1024,
  });
  requireObservation(
    artifact.sha256 === approved.artifactSha256,
    "Observer approved coordinator artifact differs",
  );
  custody.push(artifact.assertCurrent);
  assertFactory();
  const plan = original.provisioner.plan;
  assertToolScope(plan, original.runtime.admission);
  const runtimeFiles = [
    moduleFile,
    path.join(path.dirname(moduleFile), "dev-registration-native-observation.js"),
    path.join(path.dirname(moduleFile), "dev-registration-native-primitives.js"),
    ...approved.files,
    approved.node.path,
    approved.entrypoint.path,
    plan.hostInspector.path,
    original.runtime.nativeAdmission.path,
    plan.docker.path,
  ];
  await ports.protect(runtimeFiles.concat(plan.docker.socket), original.runtime.writableMountRoots);
  assertFactory();
  custody.push(ports.retainFiles(runtimeFiles));
  custody.push(ports.retainSocket(plan.docker.socket, original.runtime.account.uid));
  assertFactory();
  let dockerPin: BytePin;
  const staticPin = bytePinSchema.safeParse(plan.docker);
  if (staticPin.success) dockerPin = staticPin.data;
  else {
    requireObservation(
      under(approved.directory, plan.docker.path) &&
        ports.canonical(plan.docker.path) === plan.docker.path,
      "Approved static Docker byte pin is missing; path-only plan cannot invoke the observer",
    );
    // This hash is covered by the independently approved complete artifact,
    // never adopted from an external executable merely because it exists.
    const bytes = ports.readBytes(plan.docker.path);
    dockerPin = bytePinSchema.parse({
      path: plan.docker.path,
      sha256: hash(bytes),
      size: bytes.length,
    });
  }
  await ports.verifyFile(dockerPin, original.runtime.writableMountRoots, "host-or-root");
  assertFactory();
  const dockerBytes = ports.readBytes(dockerPin.path);
  requireObservation(
    dockerBytes.length === dockerPin.size && hash(dockerBytes) === dockerPin.sha256,
    "Observer Docker bytes or size differ",
  );
  await ports.verifyFile(approved.node, original.runtime.writableMountRoots, "host-or-root");
  await ports.readFile(approved.entrypoint, original.runtime.writableMountRoots);
  await ports.readFile(plan.hostInspector, original.runtime.writableMountRoots);
  assertFactory();
  const child = assertRetainedChild({
    consumed: capturedAuthority,
    provisioner: original.provisioner,
    approved,
    uid,
  });
  const observer = AuditedProcessObservationSchema.parse(
    await inspectObserver.call(reader, observerPid),
  );
  assertFactory();
  assertLocalObserver({
    observed: observer,
    pid: observerPid,
    uid,
    bootId: child.bootId,
    nodePath: approved.node.path,
    argv,
  });
  requireObservation(
    timeLeft(factoryDeadline) >= 30000,
    "Observer exit gate lacks its native call budget",
  );
  await verifyRetainedProcessExited(reader, {
    pid: child.pid,
    parentPid: child.parentPid,
    uid: child.uid,
    bootId: child.bootId,
    startIdentity: child.startIdentity,
    executable: child.executable.path,
    argumentsSha256: child.argumentsSha256,
  });
  assertFactory();
  const after = AuditedProcessObservationSchema.parse(
    await inspectObserver.call(reader, observerPid),
  );
  assertFactory();
  requireObservation(
    isDeepStrictEqual(after, observer),
    "Observer lifetime changed around child exit proof",
  );
  gate = true;

  const prefix = ["--host", `unix://${plan.docker.socket}`];
  function ensureGate() {
    assertCustody();
    requireObservation(gate, "Host child exit gate is unproven");
  }
  function rawRead(args: string[], stdin: string, timeoutMs: number): Promise<string> {
    requireObservation(pending === null, "Observer raw child is still unsettled");
    let childProcess: LocalReadChild;
    try {
      childProcess = ports.spawn(plan.docker.path, prefix.concat(args));
    } catch (error) {
      return Promise.reject(error);
    }
    const raw = new Promise<string>((resolve, reject) => {
      let failure: Error | null = null;
      const stdout: Buffer[] = [];
      let outputBytes = 0;
      const fail = (error: Error) => {
        failure ??= error;
        try {
          childProcess.kill("SIGKILL");
        } catch (killError) {
          failure = killError instanceof Error ? killError : error;
        }
      };
      const timer = setTimeout(
        () => fail(new BootstrapRequestConflict("Observer Docker command timed out")),
        timeoutMs,
      );
      childProcess.on("error", (error) => {
        failure ??= error instanceof Error ? error : new Error("Observer raw child failed");
      });
      childProcess.once("close", (code, signal) => {
        clearTimeout(timer);
        if (failure) reject(failure);
        else if (code !== 0 || signal !== null)
          reject(new BootstrapRequestConflict("Observer fixed Docker command failed"));
        else resolve(Buffer.concat(stdout).toString("utf8"));
      });
      childProcess.stdout?.on("data", (chunk: Buffer) => {
        outputBytes += chunk.length;
        if (outputBytes <= MAX_BYTES) stdout.push(Buffer.from(chunk));
        else fail(new BootstrapRequestConflict("Observer Docker output exceeded bound"));
      });
      childProcess.stderr?.on("data", (chunk: Buffer) => {
        outputBytes += chunk.length;
        if (outputBytes > MAX_BYTES)
          fail(new BootstrapRequestConflict("Observer Docker output exceeded bound"));
      });
      childProcess.stdin?.on("error", (error) => fail(error));
      if (!childProcess.stdin || !childProcess.stdout || !childProcess.stderr)
        fail(new BootstrapRequestConflict("Observer raw child pipes are unavailable"));
      else {
        try {
          childProcess.stdin.end(stdin);
        } catch (error) {
          fail(error instanceof Error ? error : new Error("Observer input stream failed"));
        }
      }
    });
    pending = raw;
    const clear = () => {
      if (pending === raw) pending = null;
    };
    raw.then(clear, clear);
    return raw;
  }
  function syncRead(args: string[], stdin: string, timeoutMs: number): string {
    requireObservation(pending === null, "Observer raw child is still unsettled");
    return ports.commandSync(plan.docker.path, prefix.concat(args), { input: stdin, timeoutMs });
  }
  const inspectArgs = ["container", "inspect", "--format", "{{json .}}", plan.docker.containerId];
  function inspectContainer(raw: string) {
    const current = containerSchema.parse(JSON.parse(raw));
    requireObservation(
      current.Id === plan.docker.containerId &&
        isDeepStrictEqual(
          {
            path: current.Path,
            args: current.Args,
            entrypoint: current.Config.Entrypoint,
            cmd: current.Config.Cmd,
          },
          plan.startup,
        ),
      "Observer actual Docker startup tuple changed",
    );
    return current;
  }
  function volumes(current: z.infer<typeof containerSchema>) {
    return [
      ...new Set(
        current.Mounts.filter((mount) => mount.RW && mount.Type === "volume").map((mount) =>
          z
            .string()
            .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/)
            .parse(mount.Name),
        ),
      ),
    ].sort();
  }
  function finishMetadata(current: z.infer<typeof containerSchema>, inspectedVolumes: unknown[]) {
    const roots = bootstrapWritableMountRoots({
      container: current,
      containerId: plan.docker.containerId,
      volumes: inspectedVolumes,
    });
    requireObservation(
      isDeepStrictEqual(roots, original.runtime.writableMountRoots),
      "Observer actual writable Host mounts changed",
    );
    return {
      current,
      inspectedVolumes,
      writableMounts: current.Mounts.filter((mount) => mount.RW).map((mount) => mount.Destination),
    };
  }
  async function metadata(deadline: number, reserve = 0) {
    ensureGate();
    const current = inspectContainer(await rawRead(inspectArgs, "", timeLeft(deadline, reserve)));
    ensureGate();
    const inspected: unknown[] = [];
    for (const name of volumes(current)) {
      inspected.push(
        JSON.parse(
          await rawRead(
            ["volume", "inspect", "--format", "{{json .}}", name],
            "",
            timeLeft(deadline, reserve),
          ),
        ),
      );
      ensureGate();
    }
    return finishMetadata(current, inspected);
  }
  function metadataSync(deadline: number, reserve = 0) {
    ensureGate();
    const current = inspectContainer(syncRead(inspectArgs, "", timeLeft(deadline, reserve)));
    ensureGate();
    const inspected = volumes(current).map((name) => {
      const value = JSON.parse(
        syncRead(
          ["volume", "inspect", "--format", "{{json .}}", name],
          "",
          timeLeft(deadline, reserve),
        ),
      );
      ensureGate();
      return value;
    });
    return finishMetadata(current, inspected);
  }
  const initialMetadata = await metadata(Math.min(factoryDeadline, ports.now() + COMMAND_MS));
  assertFactory();
  const baseInvocation = {
    program: DEV_REGISTRATION_NATIVE_OBSERVATION_SCRIPT,
    programSha256: hash(DEV_REGISTRATION_NATIVE_OBSERVATION_SCRIPT),
    python: plan.systemPython,
    containerId: plan.docker.containerId,
    timeoutMs: COMMAND_MS,
    maxOutputBytes: MAX_BYTES,
  };
  const claim = capturedAuthority;
  const expectedInput = JSON.stringify({
    plan,
    planSha256: original.provisioner.planSha256,
    claim,
    claimSha256: hash(JSON.stringify(claim)),
    container: {
      containerId: plan.docker.containerId,
      startup: plan.startup,
      writableMounts: initialMetadata.writableMounts,
    },
    writableMounts: initialMetadata.writableMounts,
  });
  function command(invocation: DevRegistrationNativeObservationInvocation) {
    requireObservation(
      isDeepStrictEqual(invocation, { ...baseInvocation, input: expectedInput }),
      "Observer fixed program, arguments or consumed payload changed",
    );
    return [
      "exec",
      "-i",
      "--user",
      "0:0",
      plan.docker.containerId,
      plan.systemPython.path,
      "-I",
      "-B",
      "-c",
      DEV_REGISTRATION_NATIVE_OBSERVATION_SCRIPT,
    ];
  }
  async function read(invocation: DevRegistrationNativeObservationInvocation) {
    assertFactory();
    const args = command(invocation);
    const deadline = Math.min(factoryDeadline, ports.now() + COMMAND_MS);
    const before = await metadata(deadline, FINAL_METADATA_MS);
    requireObservation(
      isDeepStrictEqual(before, initialMetadata),
      "Observer container changed before root read",
    );
    const stdout = await rawRead(args, invocation.input, timeLeft(deadline, FINAL_METADATA_MS));
    ensureGate();
    const afterMetadata = await metadata(deadline);
    ensureGate();
    requireObservation(
      isDeepStrictEqual(before, afterMetadata),
      "Observer container changed around root read",
    );
    timeLeft(deadline);
    command(invocation);
    return stdout;
  }
  function readObserverSync(invocation: DevRegistrationNativeObservationInvocation) {
    const args = command(invocation);
    const deadline = ports.now() + COMMAND_MS;
    const before = metadataSync(deadline, FINAL_METADATA_MS);
    requireObservation(
      isDeepStrictEqual(before, initialMetadata),
      "Observer container changed before root recheck",
    );
    const stdout = syncRead(args, invocation.input, timeLeft(deadline, FINAL_METADATA_MS));
    ensureGate();
    const afterMetadata = metadataSync(deadline);
    ensureGate();
    requireObservation(
      isDeepStrictEqual(before, afterMetadata),
      "Observer container changed around root recheck",
    );
    timeLeft(deadline);
    command(invocation);
    return stdout;
  }
  return collectDevRegistrationNativeObservation(
    {
      provisioner: original.provisioner,
      effect,
      container: {
        containerId: plan.docker.containerId,
        startup: plan.startup,
        writableMounts: initialMetadata.writableMounts,
        assertCurrent: ensureGate,
      },
    },
    { read, readSync: readObserverSync, now: ports.now },
  );
}
