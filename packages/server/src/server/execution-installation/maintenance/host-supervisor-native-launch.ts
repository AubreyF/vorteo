import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { Writable } from "node:stream";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { BootstrapAuditedProcessSchema } from "@getpaseo/protocol/coordinator-bootstrap";
import type { InstallationConfig } from "../config.js";
import { BootstrapRequestConflict } from "../coordinator-bootstrap-errors.js";
import { FileBootstrapRequestJournal } from "../coordinator-bootstrap-journal.js";
import {
  readBootstrapHostBinding,
  inspectBootstrapWritableMountRoots,
} from "../coordinator-bootstrap-host.js";
import { inspectMaintenanceObservationRuntime } from "../coordinator-bootstrap-maintenance-observation-runtime.js";
import {
  inspectSelectedCoordinatorRuntime,
  terminalBootstrapRelease,
} from "../coordinator-bootstrap-renewal.js";
import {
  inspectBootstrapReleaseArtifacts,
  readBootstrapPreparedFile,
  assertBootstrapPathsProtected,
  readProtectedDocument,
} from "../coordinator-bootstrap-artifact.js";
import { retainServiceFiles } from "../coordinator-bootstrap-maintenance-service-inspection.js";
import { retainMaintenancePublishedFile } from "../coordinator-bootstrap-maintenance-file-selection.js";
import { createRetainedNativeChild, type RetainedNativeChild } from "../native-gated-child.js";
import { retainCustodyBinding, retainCustodyProof } from "../retained-custody-binding.js";
import { FileEnrollmentJournal } from "./authorization.js";
import { readEnrollmentNativeIdentity } from "./native-registration.js";
import { EnrollmentNativeIdentitySchema } from "./native-identity.js";
import {
  InitialHostPreparedLaunchDataSchema,
  InitialHostMigrationClaimSchema,
  initialHostNativeLaunchBinding,
  inspectInitialHostNativeLaunchBinding,
  inspectInitialHostSupervisorMigrationPlan,
} from "./host-supervisor-contract.js";
import {
  attemptInitialHostConstruction,
  withInitialHostCommandAdmission,
  writeInitialHostArtifact,
  type InitialHostConstructorHandle,
  type InitialHostCommandContext,
  type InitialHostCommandActor,
} from "./host-supervisor-migration.js";
import {
  attemptInitialHostCommand,
  initialHostCommandPaths,
  initialHostCommandScope,
  initialHostCommandFenceRecord,
} from "./host-supervisor-initial-command-admission.js";

export const InitialHostClaimNoticeSchema = z.strictObject({
  version: z.literal(1),
  kind: z.literal("initial-host-claimed"),
  stepId: z.uuid(),
  generation: z.uuid(),
});
type Audited = z.infer<typeof BootstrapAuditedProcessSchema>;
type Binding = ReturnType<typeof initialHostNativeLaunchBinding>;
export interface InitialHostLaunchInvocation {
  enrollmentStateDirectory: string;
  plan: Parameters<typeof inspectInitialHostSupervisorMigrationPlan>[0];
  grantId: string;
  grantRevision: string;
  stepId: string;
  generation: string;
}
const nativePorts = {
  observe: inspectMaintenanceObservationRuntime,
  readEnrollment: (directory: string) => new FileEnrollmentJournal(directory).readPolicySnapshot(),
  readIdentity: readEnrollmentNativeIdentity,
  readHostBinding: readBootstrapHostBinding,
  witness: inspectSelectedCoordinatorRuntime,
  readHistory: (directory: string) =>
    new FileBootstrapRequestJournal(directory).readStartupHistory(),
  inspectRelease: inspectBootstrapReleaseArtifacts,
  readPin: readBootstrapPreparedFile,
  readDocument: readProtectedDocument,
  protect: assertBootstrapPathsProtected,
  retainFiles: retainServiceFiles,
  retainBytes: retainMaintenancePublishedFile,
  mountRoots: inspectBootstrapWritableMountRoots,
  spawn,
  construct: attemptInitialHostConstruction,
  admit: withInitialHostCommandAdmission,
  queue: attemptInitialHostCommand,
  write: writeInitialHostArtifact,
  self: () => ({
    pid: process.pid,
    parentPid: process.ppid,
    uid: process.getuid?.(),
    node: realpathSync(process.execPath),
    argv: [...process.argv],
  }),
  now: () => performance.now(),
};
/** Trusted source substitutions for inert tests, never observations accepted from a request. */
export type InitialHostNativeLaunchPorts = typeof nativePorts;
const COLLECTION_MS = 30_000;
const SYNC_CALL_MS = 10_000;
const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const hash = (value: unknown) => sha(JSON.stringify(value));
function requireProof(value: unknown, message: string): asserts value {
  if (!value) throw new BootstrapRequestConflict(`Initial Host native launch: ${message}`);
}
function sync(action: () => void) {
  requireProof(action() === undefined, "custody must be synchronous");
}
function same(actual: unknown, expected: unknown, message: string) {
  requireProof(isDeepStrictEqual(actual, expected), message);
}

/** A notice is one bounded frame, not EOF or proof. Handlers stay attached after
 * resolution so additional bytes observed before queueing invalidate release. */
function notice(child: ChildProcess, deadline: number, ports: InitialHostNativeLaunchPorts) {
  const stream = child.stdout;

  let bytes = Buffer.alloc(0),
    failed = false,
    complete = false;
  let resolve!: (value: unknown) => void, reject!: (error: Error) => void;
  const promise = new Promise<unknown>((ok, no) => {
    resolve = ok;
    reject = no;
  });
  void promise.catch(() => undefined);
  const fail = () => {
    failed = true;
    reject(new BootstrapRequestConflict("Initial Host child notice is unavailable"));
  };
  const onData = (chunk: Buffer | string) => {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (complete || bytes.length + part.length > 4100) {
      fail();
      return;
    }
    bytes = Buffer.concat([bytes, part]);
    if (bytes.length < 4) return;
    const size = bytes.readUInt32BE(0);
    if (size === 0 || size > 4096 || bytes.length > size + 4) {
      fail();
      return;
    }
    if (bytes.length === size + 4) {
      try {
        const parsed = InitialHostClaimNoticeSchema.parse(
          JSON.parse(bytes.subarray(4).toString("utf8")),
        );
        requireProof(
          bytes.subarray(4).equals(Buffer.from(JSON.stringify(parsed))),
          "notice bytes are ambiguous",
        );
        complete = true;
        resolve(parsed);
      } catch {
        fail();
      }
    }
  };
  const onEnd = () => {
    if (!complete) fail();
  };
  child.on("error", fail);
  child.on("exit", fail);
  child.on("close", fail);
  if (stream) {
    stream.on("data", onData);
    stream.on("error", fail);
    stream.on("end", onEnd);
  } else fail();
  return {
    promise,
    check() {
      requireProof(!failed, "notice failed or additional bytes were observed");
      requireProof(ports.now() < deadline, "collection deadline expired");
    },
  };
}

function lifetime(actual: Audited, expected: Audited) {
  same(actual, expected, "audited native lifetime changed");
}

function collection(ports: InitialHostNativeLaunchPorts) {
  const deadline = ports.now() + COLLECTION_MS;
  const pending = new Set<Promise<unknown>>();
  const check = () =>
    requireProof(ports.now() < deadline, "collection deadline expired; observe only");
  return {
    deadline,
    pending,
    async wait<T>(start: () => Promise<T>): Promise<T> {
      check();
      const work = start();
      pending.add(work);
      void work.finally(() => pending.delete(work)).catch(() => undefined);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        check();
        const value = await Promise.race([
          work,
          new Promise<never>((_ok, no) => {
            timer = setTimeout(
              () =>
                no(new BootstrapRequestConflict("Initial Host collection timed out; observe only")),
              Math.max(1, deadline - ports.now()),
            );
          }),
        ]);
        check();
        return value;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
function verifyChild(audited: Audited, pid: number, controller: Audited, binding: Binding) {
  requireProof(
    audited.identity.pid === pid &&
      audited.identity.parentPid === controller.identity.pid &&
      audited.identity.uid === controller.identity.uid &&
      audited.identity.bootId === controller.identity.bootId &&
      audited.identity.executable === binding.runtime.node.path &&
      audited.identity.argumentsSha256 === binding.argumentsSha256 &&
      audited.auditToken[1] === controller.identity.uid &&
      audited.auditToken[5] === pid,
    "independent child audit differs from actual launch",
  );
}
/** Actual existing-source preparation. This supplies launch custody only; the
 * activation caller must independently require its genuine interruption proof. */
export async function prepareInitialHostNativeLaunch(
  input: { configuration: InstallationConfig; configurationFile: string },
  supplied: InitialHostNativeLaunchPorts = nativePorts,
) {
  const ports = { ...supplied };
  const originalPorts = retainCustodyBinding(supplied, requireProof);
  const inputBinding = retainCustodyBinding(input, requireProof);
  const preparing = collection(ports);
  const runtime = await preparing.wait(() => ports.observe(inputBinding.snapshot));
  const runtimeProof = retainCustodyProof(runtime, requireProof);
  const reader = runtime.ports.reader,
    readAsync = reader.inspectAuditedProcess,
    readSync = reader.inspectAuditedProcessSync;
  requireProof(typeof readSync === "function", "synchronous audited reader is unavailable");
  const currentReader = () => {
    runtimeProof.check();
    requireProof(
      runtime.ports.reader === reader &&
        reader.inspectAuditedProcess === readAsync &&
        reader.inspectAuditedProcessSync === readSync,
      "native reader changed",
    );
  };
  const configuration = inputBinding.snapshot.configuration;
  const enrollment = ports.readEnrollment(configuration.stateDir);
  requireProof(enrollment.status === "enrolled", "enrollment is unavailable");
  const target = enrollment.grant.manifest.targets.find((entry) => entry.target === "coordinator");
  requireProof(target, "coordinator target is not enrolled");
  const coordinatorIdentitySha256 = target.identitySha256;
  const identity = EnrollmentNativeIdentitySchema.parse(
    ports.readIdentity(configuration.stateDir, coordinatorIdentitySha256),
  );
  requireProof(
    identity.environment === "host" && identity.target === "coordinator",
    "native coordinator identity is required",
  );
  const configuredHost = configuration.public.environments.find((entry) => entry.kind === "host");
  requireProof(configuredHost, "configured Host is missing");
  const host = ports.readHostBinding(input.configurationFile, configuredHost.serverId);
  // Retain public selectors only, never owner credential fields returned by this reader.
  const selectors = {
    installationId: host.binding.installationId,
    stateDirectory: host.stateDirectory,
    service: host.binding.service,
  };
  const service = `${identity.serviceDomain}/${identity.serviceLabel}`;
  same(
    selectors,
    { installationId: identity.installationId, stateDirectory: identity.stateDirectory, service },
    "enrolled coordinator differs from protected configuration",
  );
  requireProof(
    identity.installationId === configuration.public.installationId &&
      identity.stateDirectory === configuration.stateDir &&
      identity.installationRoot === runtime.installationRoot &&
      identity.custodyOwnerUid === runtime.account.uid,
    "coordinator anchor differs",
  );
  const self = ports.self();
  const witness = await preparing.wait(() =>
    ports.witness({
      identity,
      executables: [self.node],
      writableMountRoots: runtime.writableMountRoots,
      ports: runtime.ports,
    }),
  );
  requireProof(witness, "selected coordinator witness is unavailable");
  const witnessProof = retainCustodyProof(witness, requireProof);
  const readTerminal = () =>
    terminalBootstrapRelease(ports.readHistory(identity.stateDirectory), selectors);
  witnessProof.assertCurrent();
  const terminal = readTerminal();
  requireProof(terminal, "approved terminal coordinator history is unavailable");
  const terminalBinding = retainCustodyBinding(terminal, requireProof);
  witnessProof.assertCurrent();
  same(readTerminal(), terminalBinding.snapshot, "terminal history changed after witness");
  const release = terminalBinding.snapshot.release;
  requireProof(
    witness.target === "coordinator" && witness.installationId === identity.installationId,
    "coordinator witness differs",
  );
  same(
    {
      pid: witness.process.pid,
      parentPid: witness.process.parentPid,
      uid: witness.process.uid,
      node: witness.process.executable,
    },
    { pid: self.pid, parentPid: self.parentPid, uid: self.uid, node: self.node },
    "coordinator is not this actual process",
  );
  same(
    self.argv,
    [release.node.path, release.entrypoint.path, release.configuration.path],
    "actual coordinator argv differs from approved runtime",
  );
  requireProof(
    release.node.path === self.node && release.configuration.path === input.configurationFile,
    "approved Node or configuration differs",
  );
  const roots = [...runtime.writableMountRoots];
  const entry = path.join(
    release.directory,
    "packages/server/dist/server/server/execution-installation/maintenance/host-supervisor-native-child.js",
  );
  await preparing.wait(() =>
    ports.protect([entry, release.node.path, release.configuration.path], roots),
  );
  const filesCurrent = ports.retainFiles([entry, release.node.path, release.configuration.path]);
  const artifact = await preparing.wait(() => ports.inspectRelease(release, roots)),
    artifactProof = retainCustodyProof(artifact, requireProof);
  // The retained release verifier streams the exact Node pin above. The
  // document reader below is intentionally limited to configuration JSON.
  const configBytes = await preparing.wait(() => ports.readPin(release.configuration, roots));
  same(
    JSON.parse(configBytes.toString("utf8")),
    configuration,
    "approved configuration bytes differ",
  );
  const entryBytes = await preparing.wait(() => ports.readDocument(entry));
  const entryCurrent = ports.retainBytes(entry, entryBytes);
  const controller = BootstrapAuditedProcessSchema.parse(
    await preparing.wait(() => readAsync.call(reader, self.pid)),
  );
  same(
    controller.identity,
    witness.process,
    "audited controller differs from selected coordinator",
  );
  requireProof(
    controller.auditToken[1] === self.uid && controller.auditToken[5] === self.pid,
    "controller audit token differs",
  );
  same(
    controller.identity.argumentsSha256,
    hash(self.argv),
    "actual controller argv digest differs",
  );
  const prepared = InitialHostPreparedLaunchDataSchema.parse({
    version: 1,
    approval: {
      requestId: terminal.request.id,
      revision: terminal.request.revision,
      planSha256: terminal.request.planSha256,
      executionGeneration: terminal.request.execution!.generation,
    },
    coordinator: controller,
    runtime: release,
    childEntrypoint: { path: entry, sha256: sha(entryBytes) },
  });
  const preparedBinding = retainCustodyBinding(prepared, requireProof);
  let mountsAt = ports.now();
  async function refreshMounts() {
    const next = await ports.mountRoots(runtime.admission);
    same(next, roots, "writable mount roots changed");
    mountsAt = ports.now();
  }
  await preparing.wait(() => refreshMounts());
  function staticCurrent() {
    originalPorts.check();
    inputBinding.check();
    preparedBinding.check();
    terminalBinding.check();
    currentReader();
    runtimeProof.assertCurrent();
    witnessProof.assertCurrent();
    artifactProof.assertCurrent();
    sync(filesCurrent);
    sync(entryCurrent);
    currentReader();
    // All retained custody callbacks precede the final semantic observations.
    // A metadata assertion may itself run native custody; it cannot be allowed
    // to change the terminal or enrolled descriptor after their last read.
    sync(filesCurrent);
    sync(entryCurrent);
    const meaning = () => ({
      terminal: readTerminal(),
      identity: ports.readIdentity(configuration.stateDir, coordinatorIdentitySha256),
      self: ports.self(),
    });
    const expected = { terminal: terminalBinding.snapshot, identity, self };
    same(meaning(), expected, "retained coordinator source meaning changed");
    // Bracket leaf source reads as well. No proof/file/native callback follows
    // these semantic reads; only detached reference checks and the clock remain.
    same(meaning(), expected, "coordinator source relationship changed during reads");
    same(readTerminal(), terminalBinding.snapshot, "terminal changed during source reads");
    requireProof(
      ports.now() >= mountsAt && ports.now() - mountsAt < COLLECTION_MS,
      "mount evidence expired",
    );
    originalPorts.check();
    inputBinding.check();
    preparedBinding.check();
    terminalBinding.check();
    runtimeProof.check();
    witnessProof.check();
    artifactProof.check();
  }
  function assertNative(child?: Audited, cutoff = Infinity) {
    const deadline = Math.min(cutoff, ports.now() + 22_000);
    for (const expected of child ? [controller, child] : [controller]) {
      staticCurrent();
      requireProof(deadline - ports.now() >= SYNC_CALL_MS, "native recheck budget exhausted");
      lifetime(
        BootstrapAuditedProcessSchema.parse(readSync!.call(reader, expected.identity.pid)),
        expected,
      );
      staticCurrent();
      requireProof(ports.now() < deadline, "native recheck deadline expired");
    }
  }
  const assertCurrent = () => assertNative();
  assertNative(undefined, preparing.deadline);
  let attempted = false,
    mechanics: RetainedNativeChild | null = null,
    actualChild: ChildProcess | null = null,
    originalWriter: Writable | null = null;
  let failure: string | null = null,
    releaseAttempted = false;
  // The original constructor owner retains these real objects even if its caller
  // loses the reply or drops the prepared factory. This is local association.
  const channel = { child: null as ChildProcess | null, writer: null as Writable | null };
  let pendingReads: Set<Promise<unknown>> | null = null;
  const snapshot = () => ({
    attempted,
    releaseAttempted,
    // This composition never observes child settlement or target readiness.
    unresolved: true,
    detail: failure,
    child: mechanics?.snapshot() ?? null,
    actualChildPid: actualChild?.pid ?? null,
    pendingReads: pendingReads?.size ?? 0,
    delivery: "unknown" as const,
    settlement: "unknown" as const,
  });
  async function launch(
    invocation: InitialHostLaunchInvocation,
    constructorHandle: InitialHostConstructorHandle,
  ) {
    requireProof(!attempted, "launch already attempted; observe only");
    attempted = true;
    const invocationBinding = retainCustodyBinding(invocation, requireProof);
    const inspected = inspectInitialHostSupervisorMigrationPlan(invocation.plan);
    requireProof(
      invocation.enrollmentStateDirectory === identity.stateDirectory,
      "launch enrollment directory differs",
    );
    const binding = initialHostNativeLaunchBinding({
      prepared: preparedBinding.snapshot,
      address: {
        enrollmentStateDirectory: invocation.enrollmentStateDirectory,
        stepId: invocation.stepId,
        generation: invocation.generation,
      },
    });
    const intentOwner: { value: InitialHostCommandContext["intent"] | undefined } = {
      value: undefined,
    };
    const collecting = collection(ports);
    pendingReads = collecting.pending;
    const deadline = collecting.deadline;
    const noticeOwner: { value: ReturnType<typeof notice> | undefined } = { value: undefined };
    const bounded = collecting.wait;
    try {
      await bounded(() => refreshMounts());
      assertCurrent();
      mechanics = createRetainedNativeChild(
        { file: binding.argv[0], argv: binding.argv.slice(1), env: binding.env, cwd: binding.cwd },
        (file, argv, options) => {
          actualChild = ports.spawn(file, argv, options);
          channel.child = actualChild;
          noticeOwner.value = notice(actualChild, deadline, ports);
          const gate = actualChild.stdio[3];
          originalWriter = gate instanceof Writable ? gate : null;
          channel.writer = originalWriter;
          return actualChild;
        },
      );
      const retainedMechanics = mechanics;
      sync(() =>
        ports.construct(constructorHandle, {
          channel,
          spawn(intent) {
            inspectInitialHostNativeLaunchBinding(intent.nativeLaunch, binding.address);
            same(intent.nativeLaunch, binding, "constructor launch arrangement differs");
            requireProof(
              intent.grantId === invocation.grantId &&
                intent.grantRevision === invocation.grantRevision &&
                intent.planSha256 === inspected.planSha256,
              "constructor authority differs from invocation",
            );
            invocationBinding.check();
            intentOwner.value = structuredClone(intent);
            requireProof(ports.now() < deadline, "collection deadline expired before birth");
            retainedMechanics.attemptSpawn();
          },
        }),
      );
      const born = await bounded(() => retainedMechanics.waitForSpawn());
      requireProof(noticeOwner.value && actualChild, "original child ownership is unavailable");
      const notification = noticeOwner.value;
      const hint = await bounded(() => notification.promise);
      same(
        hint,
        {
          version: 1,
          kind: "initial-host-claimed",
          stepId: invocation.stepId,
          generation: invocation.generation,
        },
        "notice selectors differ",
      );
      requireProof(intentOwner.value, "constructor intent is unavailable");
      const retainedIntent = intentOwner.value;
      const audited = BootstrapAuditedProcessSchema.parse(
        await bounded(() => readAsync.call(reader, born.pid)),
      );
      verifyChild(audited, born.pid, controller, binding);
      const claimFile = path.join(
        invocation.enrollmentStateDirectory,
        `initial-host-claim-${invocation.stepId}-${invocation.generation}.json`,
      );
      await bounded(() => ports.protect([claimFile], roots));
      const claimFiles = ports.retainFiles([claimFile]);
      const stat = lstatSync(claimFile);
      requireProof(
        stat.isFile() &&
          stat.uid === self.uid &&
          (stat.mode & 0o077) === 0 &&
          stat.size <= 64 * 1024,
        "protected child claim is unavailable",
      );
      const raw = readFileSync(claimFile);
      const claimBytes = ports.retainBytes(claimFile, raw);
      sync(claimFiles);
      const claim = InitialHostMigrationClaimSchema.parse(JSON.parse(raw.toString("utf8")));
      same(
        raw,
        Buffer.from(JSON.stringify(claim)),
        "child claim bytes are not exact writer output",
      );
      requireProof(
        claim.intentId === retainedIntent.id &&
          claim.intentSha256 === hash(retainedIntent) &&
          claim.planSha256 === inspected.planSha256 &&
          claim.stepId === invocation.stepId &&
          claim.generation === invocation.generation,
        "child claim bindings differ",
      );
      same(
        { identity: claim.executor, auditToken: claim.executorAuditToken },
        audited,
        "child claim does not attest independently observed lifetime",
      );
      const association = () => {
        requireProof(
          channel.child === actualChild && channel.writer === originalWriter,
          "retained original channel ownership changed",
        );
        requireProof(
          actualChild!.pid === born.pid && actualChild!.stdio[3] === originalWriter,
          "original child/gate association changed",
        );
        same(actualChild!.spawnfile, binding.argv[0], "actual spawn executable changed");
        same(actualChild!.spawnargs, binding.argv, "actual spawn argv changed");
        if (!releaseAttempted) retainedMechanics.assertLocalCurrent();
        else {
          const state = retainedMechanics.snapshot();
          requireProof(
            state.spawnObserved &&
              !state.childExited &&
              !state.childClosed &&
              state.errors.length === 0,
            "released child became unavailable",
          );
        }
      };
      const childProof = {
        file: claimFile,
        claim,
        audited,
        assertCurrent() {
          invocationBinding.check();
          notification!.check();
          association();
          sync(claimFiles);
          sync(claimBytes);
          assertNative(audited, deadline);
          invocationBinding.check();
          notification!.check();
          sync(claimFiles);
          sync(claimBytes);
          association();
        },
      };
      const proof = retainCustodyProof(childProof, requireProof);
      proof.assertCurrent();
      const actor: InitialHostCommandActor = {
        kind: "release",
        constructorHandle,
        channel,
        child: childProof,
      };
      const context: InitialHostCommandContext = {
        enrollmentStateDirectory: invocation.enrollmentStateDirectory,
        ...inspected,
        intent: retainedIntent,
        claim,
        executor: controller.identity,
        actor: "release",
      };
      const paths = initialHostCommandPaths(context, "release");
      // Fence creation has its own fresh real admission. Queue helper independently
      // admits durable attempt creation and the actual original stream queue call.
      sync(() =>
        ports.admit(
          actor,
          (admitted) => {
            same(admitted, context, "release admission context differs");
            proof.assertCurrent();
          },
          (_context, reassert) => {
            reassert();
            sync(() =>
              ports.write(
                invocation.enrollmentStateDirectory,
                paths.fenceFile,
                initialHostCommandFenceRecord({ context, operation: "release" }),
              ),
            );
            reassert();
          },
        ),
      );
      const fenceBytes = Buffer.from(
        JSON.stringify(initialHostCommandFenceRecord({ context, operation: "release" })),
      );
      const command = {
        operation: "initial-host-gate-release",
        byte: 1,
        eof: true,
        child: audited,
      };
      const channelIdentity = {
        kind: "retained-node-child-stdio",
        controller,
        child: audited,
        fd: 3,
        spawnfile: actualChild.spawnfile,
        spawnargs: [...actualChild.spawnargs],
      };
      sync(() =>
        ports.queue(actor, {
          operation: "release",
          executor: controller.identity,
          command,
          channel,
          channelIdentity,
          scope: initialHostCommandScope(context, "release"),
          fence: { file: paths.fenceFile, bytes: fenceBytes },
          assertCurrent() {
            proof.assertCurrent();
          },
          enqueue() {
            releaseAttempted = true;
            retainedMechanics.queueRelease();
          },
        }),
      );
      return snapshot();
    } catch (error) {
      failure = error instanceof Error ? error.message : "Initial Host launch is unresolved";
      throw error;
    }
  }
  // No callbacks or native work follow the absolute preparation cutoff.
  requireProof(ports.now() < preparing.deadline, "preparation collection deadline expired");
  return {
    prepared,
    assertCurrent,
    bindReservation(address: Binding["address"]) {
      preparedBinding.check();
      return {
        binding: initialHostNativeLaunchBinding({ prepared: preparedBinding.snapshot, address }),
        assertCurrent,
      };
    },
    launch,
    snapshot,
  };
}
