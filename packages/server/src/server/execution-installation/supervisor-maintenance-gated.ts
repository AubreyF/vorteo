import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { Writable } from "node:stream";
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
export interface GatedSupervisorSpawn {
  (file: string, argv: string[], options: SpawnOptions): ChildProcess;
}

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
  spawnChild: GatedSupervisorSpawn = spawn,
) {
  const plan = structuredClone(input.plan),
    job = structuredClone(input.job);
  const host = structuredClone(hostProofData(input.host));
  const hostAssert = input.host.assertCurrent;
  let launchAttempted = false,
    releaseAttempted = false,
    spawnObserved = false;
  let childExited = false,
    childClosed = false,
    queueCallback = false,
    gateClosed = false,
    gateFinished = false;
  let childProcess: ChildProcess | null = null,
    gateWriter: Writable | null = null;
  let retainedProof: DevRegistrationExecutionChildProof | null = null;
  let retainedReservation: SupervisorEffect | null = null;
  let retainedChild: SupervisorEffectChild | null = null;
  let retainedCheck: (() => void) | null = null;
  const errors = new Set<string>();
  const output = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  const truncated = { stdout: false, stderr: false };
  function retainOutput(kind: "stdout" | "stderr", bytes: Buffer | string) {
    const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    const available = 8192 - output[kind].length;
    if (data.length > available) truncated[kind] = true;
    if (available > 0) output[kind] = Buffer.concat([output[kind], data.subarray(0, available)]);
    // Keep the data listener installed after the retained prefix is full.
  }
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
      childProcess !== null &&
        childProcess.pid !== undefined &&
        spawnObserved &&
        !childExited &&
        !childClosed &&
        !gateClosed &&
        !gateFinished &&
        errors.size === 0 &&
        gateWriter !== null &&
        !gateWriter.destroyed &&
        !gateWriter.writableEnded,
      "Retained gated supervisor child is unavailable",
    );
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
        childProcess = spawnChild(plan.node, argv, {
          stdio: ["ignore", "pipe", "pipe", "pipe"],
          env: {
            PATH: "/usr/bin:/bin",
            VORTEO_RESTART_JOB_ID: job.id,
            VORTEO_RESTART_FORCE: job.whenIdle ? "0" : "1",
          },
        });
        const actualChild = childProcess;
        const spawned = new Promise<void>((resolve, reject) => {
          actualChild.once("spawn", () => {
            spawnObserved = true;
            resolve();
          });
          actualChild.on("error", () => {
            errors.add("child");
            reject(new BootstrapRequestConflict("Gated supervisor spawn is unconfirmed"));
          });
          actualChild.on("exit", () => {
            childExited = true;
            reject(new BootstrapRequestConflict("Gated supervisor exited before attestation"));
          });
          actualChild.on("close", () => {
            childClosed = true;
            reject(new BootstrapRequestConflict("Gated supervisor closed before attestation"));
          });
        });
        for (const kind of ["stdout", "stderr"] as const) {
          actualChild[kind]?.on("data", (bytes: Buffer | string) => retainOutput(kind, bytes));
          actualChild[kind]?.on("error", () => {
            errors.add(kind);
          });
        }
        const writer = actualChild.stdio[3];
        if (writer instanceof Writable) {
          gateWriter = writer;
          writer.on("close", () => {
            gateClosed = true;
          });
          writer.on("finish", () => {
            gateFinished = true;
          });
          writer.on("error", () => {
            errors.add("gate");
          });
        }
        await spawned;
        assertInputs();
        assertLocalChild();
        const actualPid = actualChild.pid;
        gatedRequire(actualPid !== undefined, "Gated supervisor has no actual child PID");
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
              actualChild.pid === executor.pid && childProcess === actualChild,
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
      const writer = gateWriter;
      gatedRequire(writer !== null, "Gated supervisor writer is absent");
      try {
        writer.end(Buffer.from([1]), (error?: Error | null) => {
          queueCallback = true;
          if (error) errors.add("queue");
        });
      } catch (error) {
        errors.add("queue");
        throw error;
      }
    },
    /** Local evidence only. Never synthesizes native exit or workload settlement. */
    snapshot() {
      return {
        launchAttempted,
        releaseAttempted,
        spawnObserved,
        childExited,
        childClosed,
        queueCallback,
        gateClosed,
        gateFinished,
        pid: childProcess?.pid ?? null,
        child: retainedChild ? structuredClone(retainedChild) : null,
        errors: [...errors],
        stdout: output.stdout.toString("utf8"),
        stderr: output.stderr.toString("utf8"),
        truncated: { ...truncated },
        delivery: "unknown" as const,
      };
    },
  };
}
