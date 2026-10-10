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
  /** Recheck the original coordinator kernel identity before any resume, and
   * verify the same process running afterward. Never touch another process. */
  resumePrevious(request: CoordinatorBootstrapRequest): Promise<void>;
  /** One rollback of the exact previous release, only when included in the approved plan. */
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
    if (request.plan.automaticRecovery === "restore-compatible") {
      // The watchdog owns execution now. Complete or reconcile promotion before
      // any recovery effect, including failure before the executor's promotion.
      try {
        requests.promoteDispatch(request);
      } catch {
        return request;
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
