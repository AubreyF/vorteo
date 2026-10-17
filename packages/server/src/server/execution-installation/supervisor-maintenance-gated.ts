import { createRetainedNativeChild, type NativeGatedChildSpawn } from "./native-gated-child.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import {
  SupervisorEffectSchema,
  SupervisorEffectExecutorSchema,
  type SupervisorEffect,
  type SupervisorEffectExecutor,
  type SupervisorEffectChild,
} from "@getpaseo/protocol/execution-installation";
import { BootstrapRequestConflict } from "./coordinator-bootstrap.js";
import { DEV_REGISTRATION_GATE_PREFIX } from "./maintenance/dev-registration-provisioner.js";
import type {
  DevRegistrationExecutionPreflight,
  DevRegistrationExecutionChildProof,
} from "./maintenance/dev-registration-execution.js";
import type { RestartJob } from "@getpaseo/protocol/execution-installation";
import type { InstallationConfig } from "./config.js";

export interface GatedSupervisorHostProof {
  node: { path: string; sha256: string };
  artifactSha256: string;
  /** Independently retained protected Host artifacts, not the Linux candidate. */
  assertCurrent(): void;
}
export interface GatedSupervisorChildAttestation {
  executor: SupervisorEffectExecutor;
  assertCurrent(): void;
}
export interface GatedSupervisorMaintenanceInput {
  plan: NonNullable<InstallationConfig["container"]["supervisorMaintenance"]>;
  job: RestartJob;
  host: GatedSupervisorHostProof;
  /** Uses the existing pinned audited reader on the actual spawned PID. No
   * expected descriptor may substitute for this independent observation. */
  attestChild(pid: number): Promise<GatedSupervisorChildAttestation>;
  now(): string;
}
export type GatedSupervisorSpawn = NativeGatedChildSpawn;

function gatedRequire(ok: boolean, message: string): asserts ok {
  if (!ok) throw new BootstrapRequestConflict(message);
}
function gatedDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function gatedSync(check: () => void): void {
  const result: unknown = check();
  gatedRequire(result === undefined, "Gated supervisor custody must be synchronous");
}
function hostProofData(proof: GatedSupervisorHostProof) {
  return { node: proof.node, artifactSha256: proof.artifactSha256 };
}
function preflightData(proof: DevRegistrationExecutionPreflight) {
  return {
    controller: proof.controller,
    nativeIdentitySha256: proof.nativeIdentitySha256,
    preconditionSha256: proof.preconditionSha256,
    settlementSha256: proof.settlementSha256,
  };
}

interface GatedSupervisorChildBinding {
  executor: SupervisorEffectExecutor;
  pid: number;
  controller: SupervisorEffectExecutor;
  host: ReturnType<typeof hostProofData>;
  plan: GatedSupervisorMaintenanceInput["plan"];
  argv: string[];
}
function verifyGatedSupervisorChild({
  executor,
  pid,
  controller,
  host,
  plan,
  argv,
}: GatedSupervisorChildBinding): void {
  gatedRequire(
    executor.pid === pid &&
      executor.parentPid === controller.pid &&
      executor.uid === controller.uid &&
      executor.bootId === controller.bootId &&
      executor.executable.path === host.node.path &&
      executor.executable.sha256 === host.node.sha256 &&
      executor.entrypoint.path === plan.script &&
      executor.entrypoint.sha256 === plan.sha256 &&
      executor.artifactSha256 === host.artifactSha256 &&
      executor.argumentsSha256 === gatedDigest([plan.node, ...argv]) &&
      executor.auditToken[1] === executor.uid &&
      executor.auditToken[5] === pid,
    "Independent gated supervisor child identity differs",
  );
}

/** Retains one actual child and one private writer. Native proof collection and
 * lifecycle admission remain mandatory caller dependencies. No native factory,
 * root dispatch, retry or legacy-runner fallback is provided here. */
export function createGatedSupervisorMaintenance(
  input: GatedSupervisorMaintenanceInput,
  spawnChild?: GatedSupervisorSpawn,
) {
  const plan = structuredClone(input.plan),
    job = structuredClone(input.job);
  const host = structuredClone(hostProofData(input.host));
  const hostAssert = input.host.assertCurrent;
  let launchAttempted = false,
    releaseAttempted = false;
  let child: ReturnType<typeof createRetainedNativeChild> | null = null;
  let retainedProof: DevRegistrationExecutionChildProof | null = null;
  let retainedReservation: SupervisorEffect | null = null;
  let retainedChild: SupervisorEffectChild | null = null;
  let retainedCheck: (() => void) | null = null;
  const errors = new Set<string>();
  function assertStatic() {
    gatedRequire(
      isDeepStrictEqual(input.plan, plan) &&
        isDeepStrictEqual(input.job, job) &&
        isDeepStrictEqual(hostProofData(input.host), host) &&
        input.host.assertCurrent === hostAssert,
      "Gated supervisor launch inputs changed",
    );
  }
  function assertLocalChild() {
    gatedRequire(
      child !== null && errors.size === 0,
      "Retained gated supervisor child is unavailable",
    );
    child.assertLocalCurrent();
  }
  return {
    async launch(
      reservation: SupervisorEffect,
      preflight: DevRegistrationExecutionPreflight,
    ): Promise<DevRegistrationExecutionChildProof> {
      gatedRequire(!launchAttempted, "Gated supervisor launch was already attempted; observe only");
      launchAttempted = true;
      try {
        const saved = SupervisorEffectSchema.parse(structuredClone(reservation));
        const savedPreflight = structuredClone(preflightData(preflight));
        const preflightAssert = preflight.assertCurrent;
        retainedReservation = saved;
        function assertInputs() {
          assertStatic();
          gatedRequire(
            isDeepStrictEqual(reservation, saved) &&
              isDeepStrictEqual(preflightData(preflight), savedPreflight) &&
              preflight.assertCurrent === preflightAssert,
            "Gated supervisor reservation or controller changed",
          );
        }
        gatedRequire(
          saved.phase === "reserved" &&
            job.status === "running" &&
            job.target === "container-daemon" &&
            job.id === saved.binding.requestId &&
            job.revision === saved.binding.requestRevision &&
            job.supervisorPlanSha256 === plan.sha256 &&
            saved.binding.supervisorPlanSha256 === plan.sha256 &&
            isDeepStrictEqual(savedPreflight, {
              controller: saved.binding.controller,
              nativeIdentitySha256: saved.binding.nativeIdentitySha256,
              preconditionSha256: saved.binding.preconditionSha256,
              settlementSha256: saved.binding.settlementSha256,
            }) &&
            savedPreflight.controller.pid === process.pid &&
            savedPreflight.controller.uid === process.getuid?.(),
          "Gated supervisor reservation differs from the actual controller",
        );
        gatedSync(hostAssert);
        assertInputs();
        gatedSync(preflightAssert);
        assertInputs();
        gatedRequire(
          plan.node === host.node.path,
          "Protected Host Node differs from the launch plan",
        );
        const script = readFileSync(plan.script);
        gatedRequire(
          createHash("sha256").update(script).digest("hex") === plan.sha256 &&
            script.toString("utf8").startsWith(DEV_REGISTRATION_GATE_PREFIX),
          "Gated supervisor requires the exact whole gated script",
        );
        const argv = ["--input-type=module", "--eval", script.toString("utf8")];
        child = createRetainedNativeChild(
          {
            file: plan.node,
            argv,
            env: {
              PATH: "/usr/bin:/bin",
              VORTEO_RESTART_JOB_ID: job.id,
              VORTEO_RESTART_FORCE: job.whenIdle ? "0" : "1",
            },
          },
          spawnChild,
        );
        const actualChild = child;
        actualChild.attemptSpawn();
        const { pid: actualPid } = await actualChild.waitForSpawn();
        assertInputs();
        assertLocalChild();
        const attestation = await input.attestChild(actualPid);
        const executor = SupervisorEffectExecutorSchema.parse(attestation.executor);
        const attestationAssert = attestation.assertCurrent;
        verifyGatedSupervisorChild({
          executor,
          pid: actualPid,
          controller: savedPreflight.controller,
          host,
          plan,
          argv,
        });
        const claim = {
          reservationSha256: gatedDigest({ binding: saved.binding, reservedAt: saved.reservedAt }),
          executor,
          acknowledgedAt: input.now(),
        };
        const savedClaim = structuredClone(claim);
        function assertCustody() {
          assertInputs();
          gatedRequire(
            attestation.assertCurrent === attestationAssert &&
              isDeepStrictEqual(attestation.executor, executor) &&
              isDeepStrictEqual(proof.claim, savedClaim),
            "Gated supervisor child custody changed",
          );
        }
        const proof: DevRegistrationExecutionChildProof = {
          claim: structuredClone(claim),
          assertCurrent() {
            gatedSync(hostAssert);
            assertCustody();
            gatedSync(preflightAssert);
            assertCustody();
            gatedSync(attestationAssert);
            assertCustody();
            assertLocalChild();
            gatedRequire(
              actualChild.snapshot().pid === executor.pid && child === actualChild,
              "Gated supervisor retained handle changed",
            );
          },
        };
        proof.assertCurrent();
        retainedProof = proof;
        retainedCheck = proof.assertCurrent;
        retainedChild = structuredClone(savedClaim);
        return proof;
      } catch (error) {
        errors.add("launch");
        throw error;
      }
    },
    /** One synchronous queue attempt. Stream callbacks are diagnostic only;
     * delivery, authority at root effects and settlement remain unknown. */
    invoke(effect: SupervisorEffect, proof: DevRegistrationExecutionChildProof): void {
      gatedRequire(
        !releaseAttempted,
        "Gated supervisor release was already attempted; observe only",
      );
      releaseAttempted = true;
      const savedEffect = SupervisorEffectSchema.parse(structuredClone(effect));
      gatedRequire(
        retainedProof !== null &&
          proof === retainedProof &&
          retainedReservation !== null &&
          savedEffect.phase === "consumed" &&
          isDeepStrictEqual(savedEffect.binding, retainedReservation.binding) &&
          savedEffect.reservedAt === retainedReservation.reservedAt &&
          isDeepStrictEqual(savedEffect.child, retainedChild),
        "Gated supervisor release lacks its retained consumed child",
      );
      gatedRequire(retainedCheck !== null, "Retained gated supervisor custody is absent");
      retainedCheck();
      gatedRequire(
        isDeepStrictEqual(effect, savedEffect) && isDeepStrictEqual(proof.claim, savedEffect.child),
        "Gated supervisor consumed authority changed before queueing",
      );
      gatedRequire(child !== null, "Gated supervisor writer is absent");
      child.queueRelease();
    },
    /** Local evidence only. Never synthesizes native exit or workload settlement. */
    snapshot() {
      const local = child?.snapshot() ?? {
        spawnObserved: false,
        childExited: false,
        childClosed: false,
        queueCallback: false,
        gateClosed: false,
        gateFinished: false,
        pid: null,
        errors: [],
        stdout: "",
        stderr: "",
        truncated: { stdout: false, stderr: false },
      };
      return {
        launchAttempted,
        releaseAttempted,
        spawnObserved: local.spawnObserved,
        childExited: local.childExited,
        childClosed: local.childClosed,
        queueCallback: local.queueCallback,
        gateClosed: local.gateClosed,
        gateFinished: local.gateFinished,
        pid: local.pid,
        child: retainedChild ? structuredClone(retainedChild) : null,
        errors: [...local.errors, ...errors],
        stdout: local.stdout,
        stderr: local.stderr,
        truncated: local.truncated,
        delivery: "unknown" as const,
      };
    },
  };
}
