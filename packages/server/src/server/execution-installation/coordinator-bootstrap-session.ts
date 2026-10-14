import type {
  BootstrapClaimedRecoveryInbound,
  BootstrapClaimedRecoveryOutbound,
  BootstrapClaimedRecoveryRequestView,
  BootstrapClaimedObservation,
  CoordinatorBootstrapInbound,
  CoordinatorBootstrapOutbound,
  CoordinatorBootstrapRequest,
  BootstrapPreclaimRecoveryInbound,
  BootstrapPreclaimObservation,
  BootstrapPreclaimRecoveryOutbound,
  BootstrapPreclaimRecoveryRequestView,
} from "@getpaseo/protocol/coordinator-bootstrap";
import type { ClaimedRecoveryReviews } from "./coordinator-bootstrap-claimed-recovery.js";
import type { PreclaimRecoveryReviews } from "./coordinator-bootstrap-preclaim-recovery.js";
import {
  BootstrapAuthenticationRequired,
  BootstrapRequestConflict,
  type CoordinatorBootstrapRequests,
} from "./coordinator-bootstrap.js";

export type PreclaimRecoveryReviewService = Pick<PreclaimRecoveryReviews, "prepare" | "decide"> & {
  available: boolean;
  reconcile?(input: BootstrapPreclaimObservation): Promise<void>;
  list(): BootstrapPreclaimRecoveryRequestView[];
};

export type ClaimedRecoveryReviewService = Pick<ClaimedRecoveryReviews, "prepare" | "decide"> & {
  available: boolean;
  list(): BootstrapClaimedRecoveryRequestView[];
  reconcile?(input: BootstrapClaimedObservation): Promise<void>;
};

export type BootstrapReviewService = Pick<
  CoordinatorBootstrapRequests,
  "list" | "prepare" | "decide"
> & {
  available?: boolean;
  unavailableReason?: string;
  subscribeAvailability?(listener: () => void): () => void;
  preclaimRecovery?: PreclaimRecoveryReviewService;
  claimedRecovery?: ClaimedRecoveryReviewService;
};

export function bootstrapReviewFeatures(service: BootstrapReviewService | undefined) {
  const available =
    service !== undefined && service.available !== false && service.unavailableReason === undefined;
  return {
    coordinatorBootstrapReview: available,
    coordinatorBootstrapClaimedRecovery: service?.claimedRecovery?.available === true,
    coordinatorBootstrapClaimedObservation:
      service?.claimedRecovery?.available === true &&
      typeof service.claimedRecovery.reconcile === "function",
    coordinatorBootstrapPreclaimRecovery: service?.preclaimRecovery?.available === true,
    coordinatorBootstrapPreclaimOwnerCancellation: service?.preclaimRecovery?.available === true,
    coordinatorBootstrapPreclaimObservation:
      service?.preclaimRecovery?.available === true &&
      typeof service.preclaimRecovery.reconcile === "function",
    coordinatorBootstrapFactoryAdoption: available,
    coordinatorBootstrapCompatibleRecovery: available,
    coordinatorBootstrapPreviewMonitor: available,
    coordinatorBootstrapSourceUpdateTooling: available,
    ...(service?.unavailableReason
      ? { coordinatorBootstrapUnavailableReason: service.unavailableReason }
      : {}),
  };
}

/** Recovery stays separately unavailable until its selected Host runtime is
 * verified, even when ordinary maintenance review is available (or blocked). */
export async function handlePreclaimRecoveryReview(
  message: BootstrapPreclaimRecoveryInbound,
  service: PreclaimRecoveryReviewService | undefined,
): Promise<BootstrapPreclaimRecoveryOutbound> {
  const responses = {
    "installation.bootstrap_recovery.list_requests.request":
      "installation.bootstrap_recovery.list_requests.response",
    "installation.bootstrap_recovery.prepare.request":
      "installation.bootstrap_recovery.prepare.response",
    "installation.bootstrap_recovery.decide.request":
      "installation.bootstrap_recovery.decide.response",
  } as const;
  const type = responses[message.type];
  const requestId = message.requestId;
  if (service?.available !== true)
    return {
      type,
      payload: {
        requestId,
        requests: null,
        error: "Managed bootstrap recovery is unavailable on this Host.",
      },
    };
  try {
    if (
      message.type === "installation.bootstrap_recovery.list_requests.request" &&
      message.reconcile
    ) {
      if (!service.reconcile)
        throw new BootstrapRequestConflict("Retained recovery observation unavailable");
      await service.reconcile(message.reconcile);
    }
    if (message.type === "installation.bootstrap_recovery.prepare.request")
      await service.prepare(message.input);
    if (message.type === "installation.bootstrap_recovery.decide.request") {
      if (message.input.decision === "approve" && message.preclaimRecovery !== true)
        throw new BootstrapRequestConflict(
          "Reload to review exact preclaim recovery before approval",
        );
      if (
        message.input.decision === "approve" &&
        message.ownerCanceledOriginal !== true &&
        service.list().find((request) => request.id === message.input.id)?.plan.ownerCancellation
      )
        throw new BootstrapRequestConflict(
          "Reload to review the retained owner cancellation before approval",
        );
      await service.decide(message.input, message.ownerPassword, message.preclaimRecovery === true);
    }
    // COMPAT(preclaimOwnerCancellation): added 2026-10-12; retain until 2027-04-12.
    // Strict older readers can still cancel, but cannot approve hidden provenance.
    const requests = service.list().map((request) => {
      if (message.ownerCanceledOriginal || !request.plan.ownerCancellation) return request;
      const {
        ownerCancellation: _cancellation,
        originalApproval: _approval,
        ...plan
      } = request.plan;
      return Object.assign({}, request, {
        plan,
        reason: "Reload to review the retained owner cancellation. Cancellation remains available.",
      });
    });
    return { type, payload: { requestId, requests, error: null } };
  } catch (error) {
    const safe =
      error instanceof BootstrapRequestConflict || error instanceof BootstrapAuthenticationRequired;
    const description = safe
      ? error.message
      : "Managed recovery validation failed. Inspect the prepared Host configuration before retrying.";
    return { type, payload: { requestId, requests: null, error: description } };
  }
}

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
      assertSourceUpdateToolingReview(message, request);
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
      if (
        message.input.decision === "approve" &&
        request?.plan.previewMonitorConfiguration !== undefined &&
        message.previewMonitor !== true
      )
        throw new BootstrapRequestConflict(
          "Reload the client to review this preview monitor configuration before approval.",
        );
      await service.decide(message.input, message.ownerPassword);
    }
    const requests = service
      .list()
      .map((request) => bootstrapReviewReply(request, message.factoryRuntimeAdoption === true))
      .map((request) => compatibleRecoveryReply(request, message.compatibleRecovery === true))
      .map((request) => previewMonitorReply(request, message.previewMonitor === true))
      .map((request) => sourceUpdateToolingReply(request, message.sourceUpdateTooling === true));
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

// COMPAT(bootstrapPreviewMonitor): added 2026-10-11; remove after 2027-04-11
// once all supported clients negotiate monitor configuration review.
function previewMonitorReply(
  request: CoordinatorBootstrapRequest,
  supported: boolean,
): CoordinatorBootstrapRequest {
  if (supported || request.plan.previewMonitorConfiguration === undefined) return request;
  const { previewMonitorConfiguration: _configuration, ...plan } = request.plan;
  return {
    ...request,
    plan,
    reason:
      "Reload the client to review this preview monitor configuration. Cancellation remains available.",
  };
}

function assertSourceUpdateToolingReview(
  message: Extract<CoordinatorBootstrapInbound, { type: "installation.bootstrap.decide.request" }>,
  request: CoordinatorBootstrapRequest | undefined,
): void {
  if (
    message.input.decision === "approve" &&
    request?.plan.sourceUpdateTooling === true &&
    message.sourceUpdateTooling !== true
  )
    throw new BootstrapRequestConflict(
      "Reload the client to review this source update tooling selection before approval.",
    );
}

// COMPAT(sourceUpdateTooling): added 2026-10-11; retain until 2027-04-11.
// Keep strict legacy readers and cancellation working without approving a hidden selection.
function sourceUpdateToolingReply(
  request: CoordinatorBootstrapRequest,
  supported: boolean,
): CoordinatorBootstrapRequest {
  if (supported || request.plan.sourceUpdateTooling === undefined) return request;
  const { sourceUpdateTooling: _selection, ...plan } = request.plan;
  return {
    ...request,
    plan,
    reason:
      "Reload the client to review this source update tooling selection. Cancellation remains available.",
  };
}

/** Claimed recovery never inherits ordinary or legacy recovery readiness.
 * Caller permissions still gate the route before this owner-authenticated service. */
export async function handleClaimedRecoveryReview(
  message: BootstrapClaimedRecoveryInbound,
  service: ClaimedRecoveryReviewService | undefined,
): Promise<BootstrapClaimedRecoveryOutbound> {
  const responses = {
    "installation.claimed_recovery.list_requests.request":
      "installation.claimed_recovery.list_requests.response",
    "installation.claimed_recovery.prepare.request":
      "installation.claimed_recovery.prepare.response",
    "installation.claimed_recovery.decide.request": "installation.claimed_recovery.decide.response",
  } as const;
  const type = responses[message.type];
  const requestId = message.requestId;
  if (service?.available !== true)
    return {
      type,
      payload: {
        requestId,
        requests: null,
        error: "Claimed coordinator recovery is unavailable on this Host.",
      },
    };
  try {
    if (
      message.type === "installation.claimed_recovery.list_requests.request" &&
      message.reconcile
    ) {
      if (!service.reconcile)
        throw new BootstrapRequestConflict("Retained claimed recovery observation is unavailable");
      await service.reconcile(message.reconcile);
    }
    if (message.type === "installation.claimed_recovery.prepare.request")
      await service.prepare(message.input);
    if (message.type === "installation.claimed_recovery.decide.request") {
      if (message.input.decision === "approve" && message.claimedRecovery !== true)
        throw new BootstrapRequestConflict(
          "Reload to review exact claimed recovery before approval",
        );
      await service.decide(message.input, message.ownerPassword, message.claimedRecovery === true);
    }
    return { type, payload: { requestId, requests: service.list(), error: null } };
  } catch (error) {
    const safe =
      error instanceof BootstrapRequestConflict || error instanceof BootstrapAuthenticationRequired;
    return {
      type,
      payload: {
        requestId,
        requests: null,
        error: safe
          ? error.message
          : "Claimed recovery validation failed. Inspect its retained status before retrying.",
      },
    };
  }
}
