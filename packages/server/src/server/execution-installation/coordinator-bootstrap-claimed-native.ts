import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import {
  BootstrapClaimedRecoveryRequestSchema,
  type BootstrapClaimedRecoveryPlan,
  type BootstrapClaimedRecoveryRequest,
} from "@getpaseo/protocol/coordinator-bootstrap";
import { BootstrapRequestConflict } from "./coordinator-bootstrap.js";
import { readBootstrapPreparedFile } from "./coordinator-bootstrap-artifact.js";
import type { NativeBootstrapServiceReader } from "./coordinator-bootstrap-service.js";
import {
  ClaimedRecoveryEffectSchema,
  type FileClaimedRecoveryReviewJournal,
  type ClaimedRecoveryEffect,
} from "./coordinator-bootstrap-claimed-journal.js";
import {
  claimedRecoveryPlanDigest,
  validateClaimedRecoveryPlan,
} from "./coordinator-bootstrap-claimed-recovery.js";
import {
  verifyClaimedLiveProcesses,
  observeClaimedExecutor,
  verifyClaimedSelectedService,
} from "./coordinator-bootstrap-claimed-verification.js";
import { verifyPreclaimRecoveryOwnership } from "./coordinator-bootstrap-preclaim-recovery.js";
import type { ClaimedRecoveryOperations } from "./coordinator-bootstrap-claimed-executor.js";

/** Constructed by a protected runner, never accepted from an RPC payload.
 * The helper pin is the installed recovery helper, not the stalled runner's
 * historical ownerLauncher. Both histories must remain independently pinned. */
export interface ClaimedNativeContext {
  stateDirectory: string;
  recoveryDescriptor: number;
  helper: BootstrapClaimedRecoveryPlan["ownerLauncher"];
  inspector: BootstrapClaimedRecoveryPlan["setup"];
  reader: NativeBootstrapServiceReader;
  launcherFile: string;
  configurationFile: string;
  writableMountRoots: readonly string[];
  journal: Pick<FileClaimedRecoveryReviewJournal, "inspectEffects">;
  /** Must verify the immutable runtime without requiring the old claim still
   * current after fencing. The journal independently verifies that transition. */
  verifySupportedPlan(plan: BootstrapClaimedRecoveryPlan): Promise<void>;
}

async function invoke(
  context: ClaimedNativeContext,
  request: BootstrapClaimedRecoveryRequest,
  role: "claimed-effect" | "claimed-verify",
  effect?: "terminate" | "kill",
  executionDescriptor?: number,
): Promise<void> {
  const source = await readBootstrapPreparedFile(context.helper, context.writableMountRoots);
  await new Promise<void>((resolve, reject) => {
    let diagnostic = "";
    const failed = () => {
      const known =
        /^preclaim:(review_changed|execution_lock_changed|executor_exit_unproven|process_changed|children_unproven|effect_unreserved|effect_outcome_uncertain|verification_failed)\n$/.exec(
          diagnostic,
        );
      reject(
        new BootstrapRequestConflict(
          `Claimed native recovery refused: ${known?.[1] ?? "verification_failed"}`,
        ),
      );
    };
    const child = spawn(
      "/usr/bin/python3",
      [
        "-I",
        "-B",
        "-c",
        source.toString("utf8"),
        role,
        context.stateDirectory,
        request.id,
        request.revision,
        request.execution!.generation,
        request.planSha256,
        ...(effect ? [effect, context.inspector.path, context.inspector.sha256] : []),
      ],
      {
        env: { PATH: "/usr/bin:/bin" },
        stdio: [
          "ignore",
          "ignore",
          "pipe",
          context.recoveryDescriptor,
          ...(executionDescriptor === undefined ? [] : [executionDescriptor]),
        ],
        timeout: 10_000,
        killSignal: "SIGKILL",
      },
    );
    child.stderr!.on("data", (bytes: Buffer) => {
      diagnostic = (diagnostic + bytes.toString("utf8")).slice(0, 256);
    });
    child.once("error", failed);
    child.once("close", (code) => (code === 0 ? resolve() : failed()));
  });
}

/** This adapter verifies inherited exclusion; it does not create a runner,
 * acquire authority, expose arbitrary signals, or advertise installed support. */
export function createClaimedNativeOperations(
  input: ClaimedNativeContext,
): ClaimedRecoveryOperations {
  const context = {
    ...input,
    helper: { ...input.helper },
    inspector: { ...input.inspector },
    writableMountRoots: [...input.writableMountRoots],
  };
  let active = false;
  const owned = () => verifyPreclaimRecoveryOwnership(context);
  const check = async (value: BootstrapClaimedRecoveryRequest) => {
    const request = BootstrapClaimedRecoveryRequestSchema.parse(value);
    validateClaimedRecoveryPlan(request.plan);
    if (
      !active ||
      request.plan.original.plan.state.directory !== context.stateDirectory ||
      request.status !== "approved" ||
      !request.decisionAt ||
      !request.execution ||
      request.planSha256 !== claimedRecoveryPlanDigest(request.plan)
    )
      throw new BootstrapRequestConflict("Exact owned claimed recovery required");
    await owned();
    await context.verifySupportedPlan(request.plan);
    return request;
  };
  const observe = (request: BootstrapClaimedRecoveryRequest) =>
    observeClaimedExecutor({ ...context, plan: request.plan });
  return {
    withOwnership: async (request, operation) => {
      if (active) throw new BootstrapRequestConflict("Claimed recovery is already active");
      active = true;
      try {
        await check(request);
        return await operation();
      } finally {
        active = false;
      }
    },
    verifyBeforeFence: async (request) => {
      await check(request);
      await verifyClaimedSelectedService({ ...context, plan: request.plan });
      await observe(request);
    },
    observeExecutor: async (request) => {
      await check(request);
      return observe(request);
    },
    dispatchEffect: async (value: ClaimedRecoveryEffect) => {
      const record = ClaimedRecoveryEffectSchema.parse(value);
      const request = await check(record.request);
      const reserved = () => {
        if (
          request.execution!.stage !== "effect_pending" ||
          !isDeepStrictEqual(context.journal.inspectEffects(request)[record.effect], record)
        )
          throw new BootstrapRequestConflict("Exact retained effect reservation required");
      };
      reserved();
      await verifyClaimedLiveProcesses({ ...context, plan: request.plan });
      await verifyClaimedSelectedService({ ...context, plan: request.plan });
      reserved();
      await invoke(context, request, "claimed-effect", record.effect);
    },
    waitForExit: async (request) => {
      await check(request);
      const deadline = performance.now() + request.plan.signalPolicy.graceSeconds * 1000;
      for (;;) {
        if ((await observe(request)) === "exited") return true;
        if (performance.now() >= deadline) return false;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    },
    withVerifiedExitAndSelection: async (value, operation) => {
      const request = await check(value);
      if (!["verifying", "succeeded"].includes(request.execution!.stage))
        throw new BootstrapRequestConflict("Exact claimed recovery terminal verification required");
      context.journal.inspectEffects(request);
      const handle = await open(
        request.plan.executionLock.path,
        constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        await invoke(context, request, "claimed-verify", undefined, handle.fd);
        // The inherited open file description retains flock after the helper
        // exits. Keep it through selected-service proof and durable commit.
        await verifyClaimedSelectedService({ ...context, plan: request.plan });
        await context.reader.verifyProcessExited(request.plan.executor.identity.pid);
        await owned();
        context.journal.inspectEffects(request);
        return await operation();
      } finally {
        await handle.close();
      }
    },
  };
}
