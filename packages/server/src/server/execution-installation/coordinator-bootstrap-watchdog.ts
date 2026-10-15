import { z } from "zod";
import type { CoordinatorBootstrapRequest } from "@getpaseo/protocol/coordinator-bootstrap";
import { BootstrapRequestConflict, CoordinatorBootstrapRequests } from "./coordinator-bootstrap.js";

const OwnershipSchema = z.strictObject({
  id: z.string().uuid(),
  generation: z.string().uuid(),
});
export type BootstrapWatchdogOwnership = z.infer<typeof OwnershipSchema>;

export interface BootstrapWatchdogOperations {
  /** Same native exclusion as the executor. Reading a stale lock file is not
   * enough: the executor must be unable to perform another native operation. */
  withOwnership<T>(operation: () => Promise<T>): Promise<T>;
  /** Prove the bound executor process exited. An observation timeout, missing
   * heartbeat or recycled PID alone is insufficient; uncertainty must reject. */
  verifyExecutorExited(): Promise<void>;
  /** Native observation, not a caller-supplied boot string. Used only by the
   * separately approved startup service while holding executor exclusion. */
  verifyBootChanged?(): Promise<void>;
  /** Recheck the original coordinator kernel identity before any resume, and
   * verify the same process running afterward. Never touch another process. */
  resumePrevious(request: CoordinatorBootstrapRequest): Promise<void>;
  /** Read-only proof that the exact candidate completed replacement before the executor died. */
  verifyReplacement?(request: CoordinatorBootstrapRequest): Promise<void>;
  /** One rollback of the exact previous release, only when included in the approved plan. */
  /** Read-only proof that an already attempted rollback completed before its receipt. */
  verifyRollback?(request: CoordinatorBootstrapRequest): Promise<void>;
  restorePrevious?(request: CoordinatorBootstrapRequest): Promise<void>;
}

/** Recover only an abandoned generation under the same kernel exclusion.
 * Never replay the update or restore task, session or credential state. */
export async function recoverAbandonedBootstrap(
  requests: CoordinatorBootstrapRequests,
  expected: BootstrapWatchdogOwnership,
  operations: BootstrapWatchdogOperations,
): Promise<CoordinatorBootstrapRequest> {
  const ownership = OwnershipSchema.parse(expected);
  return operations.withOwnership(async () => {
    await operations.verifyExecutorExited();
    let request = requests.list().find((item) => item.id === ownership.id);
    if (!request?.execution || request.execution.generation !== ownership.generation)
      throw new BootstrapRequestConflict("Bootstrap watchdog ownership changed");
    const stage = request.execution.stage;
    if (["succeeded", "resumed", "rolled_back"].includes(stage)) return request;
    await verifyBootRecovery(request, operations);
    if (await replacementVerified(request, operations)) {
      return requests.advanceDispatch(
        {
          id: request.id,
          revision: request.revision,
          planSha256: request.planSha256,
          generation: ownership.generation,
        },
        "succeeded",
      );
    }
    if (await rollbackVerified(request, operations)) {
      return requests.advanceDispatch(
        {
          id: request.id,
          revision: request.revision,
          planSha256: request.planSha256,
          generation: ownership.generation,
        },
        "rolled_back",
      );
    }
    if (request.plan.automaticRecovery === "restore-compatible") {
      // The watchdog owns execution now. Complete or reconcile promotion before
      // any recovery effect, including failure before the executor's promotion.
      try {
        requests.promoteDispatch(request);
      } catch {
        return recordPromotionRefusal(requests, request, ownership.generation);
      }
    }
    const advance = (
      next: "resume_pending" | "resumed" | "recovery_required" | "rollback_pending" | "rolled_back",
    ) => {
      if (!request?.execution)
        throw new BootstrapRequestConflict("Bootstrap generation is missing");
      request = requests.advanceDispatch(
        {
          id: request.id,
          revision: request.revision,
          planSha256: request.planSha256,
          generation: request.execution.generation,
        },
        next,
      );
      return request;
    };
    if (
      operations.verifyBootChanged ||
      request.plan.automaticRecovery === "restore-compatible" ||
      !["freeze_pending", "frozen", "resume_pending"].includes(stage)
    ) {
      if (stage !== "recovery_required") advance("recovery_required");
      const authorized = request.plan.automaticRecovery !== undefined;
      if (!authorized || request.execution?.rollbackAttemptedAt || !operations.restorePrevious)
        return request;
      advance("rollback_pending");
      try {
        await operations.restorePrevious(request);
      } catch {
        return advance("recovery_required");
      }
      return advance("rolled_back");
    }
    if (stage !== "resume_pending") advance("resume_pending");
    try {
      await operations.resumePrevious(request);
    } catch {
      return advance("recovery_required");
    }
    return advance("resumed");
  });
}

function recordPromotionRefusal(
  requests: CoordinatorBootstrapRequests,
  request: CoordinatorBootstrapRequest,
  generation: string,
) {
  // Refusal grants no effects and consumes no rollback authority. Record the
  // failure with compare-and-swap; changed ownership or storage must still fail.
  if (request.execution?.stage === "recovery_required") return request;
  return requests.advanceDispatch(
    { id: request.id, revision: request.revision, planSha256: request.planSha256, generation },
    "recovery_required",
  );
}

async function replacementVerified(
  request: CoordinatorBootstrapRequest,
  operations: BootstrapWatchdogOperations,
): Promise<boolean> {
  if (request.execution?.stage !== "verifying" || !operations.verifyReplacement) return false;
  try {
    await operations.verifyReplacement(request);
    return true;
  } catch {
    // Observation failure grants no success; the existing recovery rules still apply.
    return false;
  }
}

async function verifyBootRecovery(
  request: CoordinatorBootstrapRequest,
  operations: BootstrapWatchdogOperations,
): Promise<void> {
  if (!operations.verifyBootChanged) return;
  if (!request.plan.bootRecovery || request.plan.bootRecovery.requestId !== request.id)
    throw new BootstrapRequestConflict("Startup recovery is not approved for this request");
  await operations.verifyBootChanged();
}

async function rollbackVerified(
  request: CoordinatorBootstrapRequest,
  operations: BootstrapWatchdogOperations,
): Promise<boolean> {
  if (
    !request.execution?.rollbackAttemptedAt ||
    !request.plan.automaticRecovery ||
    !operations.verifyRollback ||
    !["rollback_pending", "recovery_required"].includes(request.execution.stage)
  )
    return false;
  try {
    await operations.verifyRollback(request);
    return true;
  } catch {
    return false;
  }
}
