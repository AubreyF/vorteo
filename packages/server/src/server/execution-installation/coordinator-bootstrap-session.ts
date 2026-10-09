import type {
  CoordinatorBootstrapInbound,
  CoordinatorBootstrapOutbound,
} from "@getpaseo/protocol/coordinator-bootstrap";
import {
  BootstrapAuthenticationRequired,
  BootstrapRequestConflict,
  type CoordinatorBootstrapRequests,
} from "./coordinator-bootstrap.js";

export type BootstrapReviewService = Pick<
  CoordinatorBootstrapRequests,
  "list" | "prepare" | "decide"
>;

/** Called only after the session's daemon.manage permission check. An absent
 * Host service refuses all operations, including forged direct RPCs on Dev. */
export async function handleBootstrapReview(
  message: CoordinatorBootstrapInbound,
  service: BootstrapReviewService | undefined,
): Promise<CoordinatorBootstrapOutbound> {
  const responses = {
    "installation.bootstrap.list_requests.request": "installation.bootstrap.list_requests.response",
    "installation.bootstrap.prepare.request": "installation.bootstrap.prepare.response",
    "installation.bootstrap.decide.request": "installation.bootstrap.decide.response",
  } as const;
  const type = responses[message.type];
  const requestId = message.requestId;
  if (!service)
    return {
      type,
      payload: {
        requestId,
        requests: null,
        error: "Coordinator bootstrap is unavailable on this daemon.",
      },
    };
  try {
    if (message.type === "installation.bootstrap.prepare.request")
      await service.prepare(message.input);
    if (message.type === "installation.bootstrap.decide.request")
      await service.decide(message.input, message.ownerPassword);
    return { type, payload: { requestId, requests: service.list(), error: null } };
  } catch (error) {
    // Filesystem, schema and verifier failures can carry private configuration.
    // Return only explicit safe domain errors; never log a decision payload.
    const safe =
      error instanceof BootstrapRequestConflict || error instanceof BootstrapAuthenticationRequired;
    const description = safe
      ? error.message
      : "Bootstrap validation failed. Inspect the prepared Host configuration before retrying.";
    return { type, payload: { requestId, requests: null, error: description } };
  }
}
