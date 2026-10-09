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
}

/** Recover only an abandoned generation. No watchdog path unloads a service,
 * selects a release, starts a replacement or edits the restart journal. */
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
    if (["succeeded", "resumed", "recovery_required"].includes(stage)) return request;
    const advance = (next: "resume_pending" | "resumed" | "recovery_required") => {
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
    if (!["freeze_pending", "frozen", "resume_pending"].includes(stage)) {
      // unload_pending is ambiguous even if the old process can still be seen.
      // Resuming it could race removal or recreate two installation writers.
      return advance("recovery_required");
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
