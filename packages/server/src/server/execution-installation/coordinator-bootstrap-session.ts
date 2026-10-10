import type {
  CoordinatorBootstrapInbound,
  CoordinatorBootstrapOutbound,
  CoordinatorBootstrapRequest,
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
    if (message.type === "installation.bootstrap.decide.request") {
      const request = service.list().find((item) => item.id === message.input.id);
      if (
        message.input.decision === "approve" &&
        request?.plan.factoryRuntimeAdoptionConfiguration !== undefined &&
        message.factoryRuntimeAdoption !== true
      )
        throw new BootstrapRequestConflict(
          "Reload the client to review this Factory startup configuration before approval.",
        );
      if (
        message.input.decision === "approve" &&
        request?.plan.compatibleRecovery &&
        message.compatibleRecovery !== true
      )
        throw new BootstrapRequestConflict(
          "Reload the client to review the compatible recovery executable before approval.",
        );
      await service.decide(message.input, message.ownerPassword);
    }
    const requests = service
      .list()
      .map((request) => bootstrapReviewReply(request, message.factoryRuntimeAdoption === true))
      .map((request) => compatibleRecoveryReply(request, message.compatibleRecovery === true));
    return { type, payload: { requestId, requests, error: null } };
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

// COMPAT(factoryRuntimeAdoption): older clients use a strict plan schema. Keep
// cancellation and unrelated requests readable, but never approve a hidden change.
function bootstrapReviewReply(
  request: CoordinatorBootstrapRequest,
  supported: boolean,
): CoordinatorBootstrapRequest {
  if (supported || request.plan.factoryRuntimeAdoptionConfiguration === undefined) return request;
  const { factoryRuntimeAdoptionConfiguration: _configuration, ...plan } = request.plan;
  return {
    ...request,
    plan,
    reason:
      "Reload the client to review this Factory startup configuration. Cancellation remains available.",
  };
}

// COMPAT(bootstrapCompatibleRecovery): introduced after .287; retain until all
// supported clients can review the separately approved recovery executable.
function compatibleRecoveryReply(
  request: CoordinatorBootstrapRequest,
  supported: boolean,
): CoordinatorBootstrapRequest {
  if (supported || !request.plan.compatibleRecovery) return request;
  const { compatibleRecovery: _recovery, automaticRecovery: _policy, ...plan } = request.plan;
  return {
    ...request,
    plan,
    reason:
      "Reload the client to review the compatible recovery executable. Cancellation remains available.",
  };
}
