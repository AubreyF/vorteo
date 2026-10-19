import type { BootstrapClaimedRecoveryRequest } from "@getpaseo/protocol/coordinator-bootstrap";
import { BootstrapRequestConflict } from "./coordinator-bootstrap.js";
import { ClaimedRecoveryReviews } from "./coordinator-bootstrap-claimed-recovery.js";
import type {
  FileClaimedRecoveryReviewJournal,
  ClaimedRecoveryEffect,
} from "./coordinator-bootstrap-claimed-journal.js";

type Request = BootstrapClaimedRecoveryRequest;
type Identity = Pick<Request, "id" | "revision" | "planSha256">;
type Journal = Pick<
  FileClaimedRecoveryReviewJournal,
  "fenceClaim" | "reserveEffect" | "inspectEffects" | "abortBeforeEffects"
>;

/** Only the protected runner constructs these ports. They are not public RPC
 * inputs. Native dispatch must consume its own durable send slot and enforce
 * audited identity and monotonic grace independently of the Node caller. */
export interface ClaimedRecoveryOperations {
  withOwnership<T>(request: Request, operation: () => Promise<T>): Promise<T>;
  verifyBeforeFence(request: Request): Promise<void>;
  observeExecutor(request: Request): Promise<"running" | "exited">;
  dispatchEffect(record: ClaimedRecoveryEffect): Promise<void>;
  /** False requires the same audited target still alive after the grace period.
   * Missing, ambiguous or timed-out inspection must reject, never return false. */
  waitForExit(request: Request): Promise<boolean>;
  /** Prove executor/descendant exit, unchanged selection and retained kernel
   * ownership through the caller's subsequent terminal journal commit. */
  withVerifiedExitAndSelection<T>(request: Request, operation: () => Promise<T>): Promise<T>;
}

/** Executes a fresh recovery approval once. Every ambiguous return is retained
 * for observation; neither the original bootstrap nor an effect is replayed.
 * Success retires only this executor. The original remains recovery_required;
 * later bootstrap admission must consume this exact verified recovery receipt. */
export async function executeClaimedRecovery(
  reviews: ClaimedRecoveryReviews,
  journal: Journal,
  approval: Identity,
  operations: ClaimedRecoveryOperations,
): Promise<Request> {
  let request = await reviews.claim(approval);
  const advance = (stage: NonNullable<Request["execution"]>["stage"]) => {
    request = reviews.advance(request, stage);
  };
  try {
    return await operations.withOwnership(request, async () => {
      await operations.verifyBeforeFence(request);
      journal.fenceClaim(request);
      advance("claim_fenced");
      if ((await operations.observeExecutor(request)) === "running") {
        advance("effect_pending");
        const terminate = journal.reserveEffect(request, "terminate");
        await operations.dispatchEffect(terminate);
        if (!(await operations.waitForExit(request))) {
          if (request.plan.signalPolicy.escalation !== "SIGKILL")
            throw new BootstrapRequestConflict("Executor exit remains unproven");
          const kill = journal.reserveEffect(request, "kill");
          await operations.dispatchEffect(kill);
          if (!(await operations.waitForExit(request)))
            throw new BootstrapRequestConflict("Executor exit remains unproven");
        }
      }
      advance("verifying");
      return operations.withVerifiedExitAndSelection(request, async () => {
        journal.inspectEffects(request);
        advance("succeeded");
        return request;
      });
    });
  } catch {
    // A compare failure can mean an earlier write succeeded but its reply was
    // lost. Do not replace a newer durable revision or expose private errors.
    if (request.execution?.stage === "succeeded")
      throw new BootstrapRequestConflict(
        "Recovery completion reply is uncertain; observe retained history",
      );
    advance("recovery_required");
    return request;
  }
}

/** The observation API deliberately has no dispatch method. Reconciliation
 * retains the same generation and can only establish a newly verified result. */
export async function reconcileClaimedRecovery(
  reviews: ClaimedRecoveryReviews,
  journal: Pick<Journal, "inspectEffects" | "abortBeforeEffects">,
  identity: Identity & { generation: string },
  operations: Pick<ClaimedRecoveryOperations, "withOwnership" | "withVerifiedExitAndSelection">,
): Promise<Request> {
  let request = reviews.list().find((record) => record.id === identity.id);
  if (
    !request ||
    request.revision !== identity.revision ||
    request.planSha256 !== identity.planSha256 ||
    request.status !== "approved" ||
    request.execution?.generation !== identity.generation ||
    ![
      "claimed",
      "claim_fenced",
      "effect_pending",
      "verifying",
      "recovery_required",
      "succeeded",
    ].includes(request.execution.stage)
  )
    throw new BootstrapRequestConflict("Exact retained claimed recovery generation required");
  const retained = request;
  return operations.withOwnership(retained, async () => {
    request = retained;
    const aborted = journal.abortBeforeEffects(request);
    if (aborted) return aborted;
    journal.inspectEffects(request);
    if (request.execution!.stage === "succeeded") {
      return operations.withVerifiedExitAndSelection(request, async () => {
        journal.inspectEffects(retained);
        return retained;
      });
    }
    let committed = false;
    try {
      if (request.execution!.stage === "claimed")
        request = reviews.advance(request, "recovery_required");
      if (request.execution!.stage !== "verifying") request = reviews.advance(request, "verifying");
      const verifying = request;
      return await operations.withVerifiedExitAndSelection(verifying, async () => {
        journal.inspectEffects(verifying);
        request = reviews.advance(verifying, "succeeded");
        committed = true;
        return request;
      });
    } catch {
      if (committed)
        throw new BootstrapRequestConflict(
          "Recovery completion reply is uncertain; observe retained history",
        );
      request = reviews.advance(request, "recovery_required");
      return request;
    }
  });
}
