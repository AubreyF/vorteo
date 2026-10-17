import { createHash } from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { CoordinatorBootstrapPlan } from "@getpaseo/protocol/coordinator-bootstrap";
import { SupervisorEffectExecutorSchema } from "@getpaseo/protocol/execution-installation";
import { BootstrapRequestConflict } from "../coordinator-bootstrap.js";
import { AuditedProcessObservationSchema } from "../coordinator-bootstrap-process.js";
import {
  assertBootstrapPathsProtected,
  inspectBootstrapReleaseArtifacts,
  readBootstrapPreparedFile,
  readProtectedDocument,
} from "../coordinator-bootstrap-artifact.js";
import {
  BootstrapAdmissionSetupSchema,
  inspectBootstrapWritableMountRoots,
} from "../coordinator-bootstrap-host.js";
import type { MaintenanceObservationRuntime } from "../coordinator-bootstrap-maintenance-observation-runtime.js";
import { retainServiceFiles } from "../coordinator-bootstrap-maintenance-service-inspection.js";
import type {
  GatedSupervisorHostProof,
  GatedSupervisorChildAttestation,
} from "../supervisor-maintenance-gated.js";
import { DEV_REGISTRATION_GATE_PREFIX } from "./dev-registration-provisioner.js";

type HostRelease = CoordinatorBootstrapPlan["candidate"];
type FilePin = HostRelease["node"];

export interface DevRegistrationNativeExecutorInput {
  /** Obtained from the protected Host observation anchor, never a request body. */
  runtime: MaintenanceObservationRuntime;
  /** Independently selected Host release. This is never the Dev Linux candidate. */
  hostRelease: HostRelease;
  script: FilePin;
  hostInspector: FilePin;
}

/** Trusted composition ports. Substitutions are for inert unit tests only and
 * do not turn their supplied observations into native acceptance evidence. */
export interface DevRegistrationNativeExecutorPorts {
  inspectRelease: typeof inspectBootstrapReleaseArtifacts;
  readFile: typeof readBootstrapPreparedFile;
  readDocument: typeof readProtectedDocument;
  protect: typeof assertBootstrapPathsProtected;
  mountRoots: typeof inspectBootstrapWritableMountRoots;
  retainFiles: typeof retainServiceFiles;
  now(): number;
}

const nativePorts: DevRegistrationNativeExecutorPorts = {
  inspectRelease: inspectBootstrapReleaseArtifacts,
  readFile: readBootstrapPreparedFile,
  readDocument: readProtectedDocument,
  protect: assertBootstrapPathsProtected,
  mountRoots: inspectBootstrapWritableMountRoots,
  retainFiles: retainServiceFiles,
  now: () => performance.now(),
};
const FRESH_MS = 30_000;
// Two existing reader calls can each take ten seconds. Never start another
// call without its full timeout remaining; check the total again on return.
const SYNC_BUDGET_MS = 22_000;
const NATIVE_CALL_MS = 10_000;

function requireProof(ok: boolean, message: string): asserts ok {
  if (!ok) throw new BootstrapRequestConflict(message);
}
function hash(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function sync(check: () => void): void {
  const result: unknown = check();
  requireProof(result === undefined, "Host executor custody must be synchronous");
}
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

/** Read-only proof factories. No lock, launch, grant, dispatch or settlement is
 * supplied here. A missing sync reader refuses rather than weakening custody. */
export async function createDevRegistrationNativeExecutor(
  input: DevRegistrationNativeExecutorInput,
  ports: DevRegistrationNativeExecutorPorts = nativePorts,
): Promise<{
  gatedHostProof: GatedSupervisorHostProof;
  attestChild(pid: number): Promise<GatedSupervisorChildAttestation>;
}> {
  ports = { ...ports };
  const runtime = input.runtime;
  const runtimeAssert = runtime.assertCurrent;
  const reader = runtime.ports.reader;
  const inspectAsync = reader.inspectAuditedProcess;
  const optionalInspectSync = reader.inspectAuditedProcessSync;
  requireProof(
    typeof optionalInspectSync === "function",
    "Synchronous audited child reader is unavailable",
  );
  const inspectSync = optionalInspectSync;
  const pins = structuredClone({
    runtime: runtimeData(runtime),
    release: input.hostRelease,
    script: input.script,
    inspector: input.hostInspector,
  });
  const { release, script, inspector } = pins;
  const uid = process.getuid?.();
  requireProof(
    uid !== undefined && uid === pins.runtime.account.uid,
    "Host executor account differs",
  );
  requireProof(
    inspector.path === pins.runtime.admission.helperPath &&
      inspector.sha256 === pins.runtime.admission.helperSha256 &&
      release.configuration.path === pins.runtime.admission.configurationFile,
    "Host executor release or inspector differs from protected admission",
  );
  function assertInputs() {
    requireProof(
      input.runtime === runtime &&
        isDeepStrictEqual(pins, {
          runtime: runtimeData(runtime),
          release: input.hostRelease,
          script: input.script,
          inspector: input.hostInspector,
        }) &&
        runtime.assertCurrent === runtimeAssert &&
        runtime.ports.reader === reader &&
        reader.inspectAuditedProcess === inspectAsync &&
        reader.inspectAuditedProcessSync === inspectSync,
      "Host executor inputs or callbacks changed",
    );
  }
  function assertRuntime() {
    assertInputs();
    sync(runtimeAssert);
    assertInputs();
  }
  assertRuntime();
  const roots = [...(await ports.mountRoots(structuredClone(pins.runtime.admission)))];
  assertRuntime();
  requireProof(
    isDeepStrictEqual(roots, pins.runtime.writableMountRoots),
    "Host writable mounts changed",
  );
  let mountsAt = ports.now();
  const anchor = path.join(pins.runtime.installationRoot, "coordinator-bootstrap-runner.json");
  const files = [
    anchor,
    pins.runtime.nativeAdmission.path,
    inspector.path,
    script.path,
    pins.runtime.admission.configurationFile,
    pins.runtime.admission.launcherFile,
    pins.runtime.admission.docker,
    pins.runtime.admission.socket,
  ];
  await ports.protect([...files], [...roots]);
  assertRuntime();
  // The Docker socket is not a regular file. Its endpoint is bound by the
  // protected admission and fresh Docker inspection, never by a file receipt.
  const assertFiles = ports.retainFiles(
    files.filter((file) => file !== pins.runtime.admission.socket),
  );
  const runner = JSON.parse((await ports.readDocument(anchor)).toString("utf8"));
  requireProof(
    runner.admissionSetupFile === pins.runtime.nativeAdmission.path,
    "Host admission anchor changed",
  );
  const admission = BootstrapAdmissionSetupSchema.parse(
    JSON.parse(
      (await ports.readFile(structuredClone(pins.runtime.nativeAdmission), [...roots])).toString(
        "utf8",
      ),
    ),
  );
  requireProof(isDeepStrictEqual(admission, pins.runtime.admission), "Host admission bytes differ");
  await ports.readFile(structuredClone(inspector), [...roots]);
  const bytes = await ports.readFile(structuredClone(script), [...roots]);
  requireProof(
    hash(bytes) === script.sha256 &&
      bytes.toString("utf8").startsWith(DEV_REGISTRATION_GATE_PREFIX),
    "Reviewed whole registration script or fixed gate differs",
  );
  const argvSha256 = hash(
    JSON.stringify([release.node.path, "--input-type=module", "--eval", bytes.toString("utf8")]),
  );
  const artifact = await ports.inspectRelease(structuredClone(release), [...roots]);
  const assertArtifact = artifact.assertCurrent;
  function assertStatic() {
    assertRuntime();
    sync(assertFiles);
    sync(assertArtifact);
    assertRuntime();
    requireProof(artifact.assertCurrent === assertArtifact, "Host artifact callback changed");
    const age = ports.now() - mountsAt;
    requireProof(age >= 0 && age < FRESH_MS, "Host mount evidence expired");
  }
  async function refreshMounts() {
    assertRuntime();
    const current = await ports.mountRoots(structuredClone(pins.runtime.admission));
    assertRuntime();
    requireProof(isDeepStrictEqual(current, roots), "Host writable mounts changed");
    mountsAt = ports.now();
    assertStatic();
  }
  await refreshMounts();
  const controller = AuditedProcessObservationSchema.parse(
    await inspectAsync.call(reader, process.pid),
  );
  assertStatic();
  requireProof(
    controller.identity.pid === process.pid &&
      controller.identity.parentPid === process.ppid &&
      controller.identity.uid === uid &&
      controller.identity.executable === release.node.path &&
      controller.auditToken[1] === uid &&
      controller.auditToken[5] === process.pid,
    "Observed Host controller differs from pinned runtime",
  );
  const controllerAt = ports.now();
  function assertNative(child?: ReturnType<typeof AuditedProcessObservationSchema.parse>) {
    const started = ports.now();
    const deadline = started + SYNC_BUDGET_MS;
    for (const expected of child ? [controller, child] : [controller]) {
      assertStatic();
      const age = ports.now() - controllerAt;
      requireProof(age >= 0 && age < FRESH_MS, "Host controller observation expired");
      requireProof(
        deadline - ports.now() >= NATIVE_CALL_MS,
        "Host native recheck budget exhausted",
      );
      const actual = AuditedProcessObservationSchema.parse(
        inspectSync.call(reader, expected.identity.pid),
      );
      assertStatic();
      requireProof(
        ports.now() - controllerAt >= 0 && ports.now() - controllerAt < FRESH_MS,
        "Host controller observation expired",
      );
      requireProof(ports.now() < deadline, "Host native recheck exceeded total budget");
      requireProof(isDeepStrictEqual(actual, expected), "Host executor native lifetime changed");
    }
    assertStatic();
    requireProof(
      ports.now() >= started && ports.now() < deadline,
      "Host native recheck exceeded total budget",
    );
    requireProof(ports.now() - controllerAt < FRESH_MS, "Host controller observation expired");
  }
  const gatedHostProof: GatedSupervisorHostProof = {
    node: structuredClone(release.node),
    artifactSha256: release.artifactSha256,
    assertCurrent() {
      assertNative();
      requireProof(
        isDeepStrictEqual(gatedHostProof.node, release.node) &&
          gatedHostProof.artifactSha256 === release.artifactSha256,
        "Host proof snapshot changed",
      );
    },
  };
  gatedHostProof.assertCurrent();
  return {
    gatedHostProof,
    async attestChild(pid) {
      requireProof(
        Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid,
        "Actual gated child PID is required",
      );
      assertNative();
      await refreshMounts();
      const observed = AuditedProcessObservationSchema.parse(await inspectAsync.call(reader, pid));
      assertStatic();
      const actual = observed.identity;
      requireProof(
        actual.pid === pid &&
          actual.parentPid === controller.identity.pid &&
          actual.uid === uid &&
          actual.bootId === controller.identity.bootId &&
          actual.executable === release.node.path &&
          actual.argumentsSha256 === argvSha256 &&
          observed.auditToken[1] === uid &&
          observed.auditToken[5] === pid,
        "Observed gated child differs from direct Host launch",
      );
      const executor = SupervisorEffectExecutorSchema.parse({
        ...actual,
        auditToken: observed.auditToken,
        executable: release.node,
        entrypoint: script,
        artifactSha256: release.artifactSha256,
      });
      const proof: GatedSupervisorChildAttestation = {
        executor: structuredClone(executor),
        assertCurrent() {
          assertNative(observed);
          requireProof(isDeepStrictEqual(proof.executor, executor), "Child proof snapshot changed");
        },
      };
      proof.assertCurrent();
      return proof;
    },
  };
}
