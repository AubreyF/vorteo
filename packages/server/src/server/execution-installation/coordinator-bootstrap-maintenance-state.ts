import type { CoordinatorBootstrapPreparation } from "@getpaseo/protocol/coordinator-bootstrap";
import { BootstrapRequestConflict, coordinatorPlanDigest } from "./coordinator-bootstrap.js";
import type { BootstrapReviewService } from "./coordinator-bootstrap-session.js";
import { bindMaintenanceReview } from "./coordinator-bootstrap-maintenance-host.js";

/** Controller state never resumes a decision. A retained approved or executing
 * request remains observable even when current-runtime validation cannot reopen
 * the mutating service after selection changes. */
export function createMaintenanceReviewState(input: {
  preparation: CoordinatorBootstrapPreparation;
  readRequests: BootstrapReviewService["list"];
  authenticateAndProvision(password: string): Promise<void>;
  createService(): Promise<BootstrapReviewService>;
}) {
  let phase: "unprovisioned" | "validating" | "ready" | "unavailable" = "unprovisioned";
  let service: BootstrapReviewService | undefined;
  const binding = {
    requestId: input.preparation.id,
    planSha256: coordinatorPlanDigest(input.preparation.plan),
  };
  const refuse = async (): Promise<never> => {
    throw new BootstrapRequestConflict("Maintenance is observation-only");
  };
  const observation = bindMaintenanceReview(
    { list: input.readRequests, prepare: refuse, decide: refuse },
    binding,
  );
  const readOnly: BootstrapReviewService = {
    ...observation,
    available: false,
    unavailableReason: "Retained maintenance is observation-only",
  };
  const activate = async (password?: string) => {
    if (phase === "validating")
      throw new BootstrapRequestConflict("Maintenance validation is already running");
    if (phase === "ready") return;
    phase = "validating";
    service = undefined;
    try {
      // An existing record, including an approved record without an execution,
      // is never reconstructed through prepare or decide on controller startup.
      const retained = observation.list();
      if (retained.length && (retained[0].status !== "pending" || retained[0].execution)) {
        phase = "unavailable";
        return;
      }
      if (password !== undefined) await input.authenticateAndProvision(password);
      const candidate = bindMaintenanceReview(await input.createService(), binding);
      if (observation.list().length === 0) await candidate.prepare(input.preparation);
      // Recheck after asynchronous validation/preparation. Another controller may
      // have decided the request while this one was validating.
      const current = observation.list();
      if (current.length !== 1 || current[0].status !== "pending" || current[0].execution) {
        phase = "unavailable";
        return;
      }
      service = candidate;
      phase = "ready";
    } catch (error) {
      phase = "unavailable";
      throw error;
    }
  };
  return {
    phase: () => phase,
    service: () => service ?? readOnly,
    list: observation.list,
    // The caller must establish the durable admission before calling reopen.
    reopen: () => activate(),
    provision: (password: string) => activate(password),
  };
}
