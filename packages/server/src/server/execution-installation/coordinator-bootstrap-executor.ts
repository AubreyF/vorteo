import type {
  CoordinatorBootstrapRequest,
  CoordinatorBootstrapStage,
} from "@getpaseo/protocol/coordinator-bootstrap";
import {
  assertFrozenCoordinatorIdle,
  BootstrapRequestConflict,
  CoordinatorBootstrapRequests,
} from "./coordinator-bootstrap.js";

interface FrozenCoordinatorState {
  restartJournal: unknown;
  childPids: unknown;
}

/** Native implementations must bind every operation to the approved process,
 * artifacts and generation. No arbitrary command or process identifier enters
 * this boundary from a browser. These ports are not production wiring. */
export interface BootstrapExecutorOperations {
  armWatchdog(request: CoordinatorBootstrapRequest): Promise<void>;
  freeze(request: CoordinatorBootstrapRequest): Promise<void>;
  inspectFrozen(request: CoordinatorBootstrapRequest): Promise<FrozenCoordinatorState>;
  /** Fsync the accepted journal and revalidate stopped identity and inventory. */
  preserveTransfer(request: CoordinatorBootstrapRequest): Promise<void>;
  /** The executor and watchdog share exclusion for this complete callback.
   * The native implementation must recover abandoned ownership after a crash. */
  withOwnership<T>(request: CoordinatorBootstrapRequest, operation: () => Promise<T>): Promise<T>;
  /** Resolve only after both old-process exit and service removal are proven. */
  unload(request: CoordinatorBootstrapRequest): Promise<void>;
  select(request: CoordinatorBootstrapRequest): Promise<void>;
  /** Replacement starts fenced and claims this generation before queue work. */
  start(request: CoordinatorBootstrapRequest): Promise<void>;
  verifyReplacement(request: CoordinatorBootstrapRequest): Promise<void>;
  releaseReplacement(request: CoordinatorBootstrapRequest): Promise<void>;
  /** Resume only the same verified old process, then verify it is running. */
  resumePrevious(request: CoordinatorBootstrapRequest): Promise<void>;
}

/** Runs a newly claimed approval once. Recovery never calls this with an
 * existing execution record: an ambiguous side effect must not be repeated. */
export async function executeCoordinatorBootstrap(
  requests: CoordinatorBootstrapRequests,
  approval: Pick<CoordinatorBootstrapRequest, "id" | "revision" | "planSha256">,
  operations: BootstrapExecutorOperations,
): Promise<CoordinatorBootstrapRequest> {
  let request = await requests.claimDispatch(approval);
  const advance = (stage: CoordinatorBootstrapStage) => {
    if (!request.execution) throw new BootstrapRequestConflict("Bootstrap execution is missing");
    request = requests.advanceDispatch(
      {
        id: request.id,
        revision: request.revision,
        planSha256: request.planSha256,
        generation: request.execution.generation,
      },
      stage,
    );
  };
  return operations.withOwnership(request, async () => {
    try {
      await operations.armWatchdog(request);
      requests.promoteDispatch(request);
      advance("freeze_pending");
      await operations.freeze(request);
      const frozen = await operations.inspectFrozen(request);
      advance("frozen");
      assertFrozenCoordinatorIdle(frozen.restartJournal, frozen.childPids);
      await operations.preserveTransfer(request);
      // Durable intent precedes the first operation that prevents resuming the
      // legacy writer. A failure from unload onward requires observed recovery.
      advance("unload_pending");
      await operations.unload(request);
      advance("unloaded");
      advance("selection_pending");
      await operations.select(request);
      advance("selected");
      advance("start_pending");
      await operations.start(request);
      advance("started");
      advance("verifying");
      await operations.verifyReplacement(request);
      await operations.releaseReplacement(request);
      advance("succeeded");
    } catch {
      // Errors can contain private command/configuration data. Persist only the
      // bounded state; native diagnostics belong in the private evidence store.
      const stage = request.execution?.stage;
      if (
        request.plan.automaticRecovery !== "restore-compatible" &&
        (stage === "freeze_pending" || stage === "frozen")
      ) {
        advance("resume_pending");
        try {
          await operations.resumePrevious(request);
          advance("resumed");
        } catch {
          advance("recovery_required");
        }
      } else {
        advance("recovery_required");
      }
    }
    return request;
  });
}
