import type {
  BootstrapClaimedRecoveryInbound,
  BootstrapClaimedRecoveryOutbound,
  BootstrapClaimedRecoveryRequestView,
  BootstrapClaimedObservation,
  CoordinatorBootstrapInbound,
  CoordinatorBootstrapPreparation,
  CoordinatorSubmissionProof,
  CoordinatorBootstrapOutbound,
  CoordinatorBootstrapRequest,
  CoordinatorBootstrapRequestView,
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
  coordinatorAutomaticStatus,
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
  automatic?: {
    prepare?(
      input: CoordinatorBootstrapPreparation,
      proof: CoordinatorSubmissionProof,
    ): Promise<CoordinatorBootstrapRequest>;
    reconcile(id: string): Promise<CoordinatorBootstrapRequest>;
  };
  available?: boolean;
  unavailableReason?: string;
  subscribeAvailability?(listener: () => void): () => void;
  /** Fingerprints of the coordinator history and selected configuration a
   * renewal context depends on: as derived, and as they are now. */
  renewalContext?: { derived: string; current(): string };
  preclaimRecovery?: PreclaimRecoveryReviewService;
  claimedRecovery?: ClaimedRecoveryReviewService;
};

function automaticReviewFeatures(service: BootstrapReviewService | undefined, available: boolean) {
  return {
    coordinatorBootstrapAutomaticReconciliation: available && service?.automatic !== undefined,
    coordinatorBootstrapAuthenticatedSubmission:
      available && service?.automatic?.prepare !== undefined,
  };
}

export function bootstrapReviewFeatures(service: BootstrapReviewService | undefined) {
  const preclaimAvailable = service?.preclaimRecovery?.available === true;
  const claimedAvailable = service?.claimedRecovery?.available === true;
  const available =
    service !== undefined && service.available !== false && service.unavailableReason === undefined;
  return {
    coordinatorBootstrapReview: available,
    coordinatorBootstrapClaimedRecovery: claimedAvailable,
    coordinatorBootstrapClaimedObservation:
      claimedAvailable && typeof service?.claimedRecovery?.reconcile === "function",
    coordinatorBootstrapPreclaimRecovery: preclaimAvailable,
    coordinatorBootstrapPreclaimOwnerCancellation: preclaimAvailable,
    coordinatorBootstrapPreclaimObservation:
      preclaimAvailable && typeof service?.preclaimRecovery?.reconcile === "function",
    coordinatorBootstrapFactoryAdoption: available,
    coordinatorBootstrapCompatibleRecovery: available,
    coordinatorBootstrapPreviewMonitor: available,
    coordinatorBootstrapClaudeHostRefresh: available,
    coordinatorBootstrapSourceUpdateTooling: available,
    coordinatorBootstrapBootRecovery: available,
    coordinatorBootstrapRecoveryBootPlan: preclaimAvailable || claimedAvailable,
    coordinatorBootstrapAutomaticStatus: available,
    ...automaticReviewFeatures(service, available),
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
      assertRetainedBootReview(
        message,
        service.list().find((request) => request.id === message.input.id),
      );
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
    const requests = service.list().map((stored) => {
      const request = Object.assign({}, stored, {
        reason: retainedBootReviewReason(stored, message.recoveryBootPlan === true),
        plan: {
          ...stored.plan,
          original: retainedBootReply(stored.plan.original, message.recoveryBootPlan === true),
          canceled: retainedBootReply(stored.plan.canceled, message.recoveryBootPlan === true),
          ...(stored.plan.ownerCancellation
            ? {
                ownerCancellation: retainedBootReply(
                  stored.plan.ownerCancellation,
                  message.recoveryBootPlan === true,
                ),
              }
            : {}),
        },
      });
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

async function prepareCoordinatorReview(
  service: BootstrapReviewService,
  message: Extract<CoordinatorBootstrapInbound, { type: "installation.bootstrap.prepare.request" }>,
): Promise<void> {
  if (!message.submissionProof) {
    await service.prepare(message.input);
    return;
  }
  if (
    !bootstrapReviewFeatures(service).coordinatorBootstrapAuthenticatedSubmission ||
    !service.automatic?.prepare
  )
    throw new BootstrapRequestConflict(
      "Authenticated coordinator submission is unavailable on this Host",
    );
  await service.automatic.prepare(message.input, message.submissionProof);
}

async function reconcileAutomaticReview(
  service: BootstrapReviewService,
  id: string,
): Promise<void> {
  if (
    !bootstrapReviewFeatures(service).coordinatorBootstrapAutomaticReconciliation ||
    !service.automatic
  )
    throw new BootstrapRequestConflict(
      "Automatic coordinator reconciliation is unavailable on this Host",
    );
  await service.automatic.reconcile(id);
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
    "installation.bootstrap.reconcile_automatic.request":
      "installation.bootstrap.reconcile_automatic.response",
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
    if (message.type === "installation.bootstrap.reconcile_automatic.request")
      await reconcileAutomaticReview(service, message.id);
    if (message.type === "installation.bootstrap.prepare.request")
      await prepareCoordinatorReview(service, message);
    if (message.type === "installation.bootstrap.decide.request") {
      const request = service.list().find((item) => item.id === message.input.id);
      assertSourceUpdateToolingReview(message, request);
      assertBootRecoveryReview(message, request);
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
      assertServiceConfigurationReview(message, request);
      await service.decide(message.input, message.ownerPassword);
    }
    const requests = service.list().map((request) => publicBootstrapReply(request, message));
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

function publicBootstrapReply(
  request: CoordinatorBootstrapRequest,
  message: CoordinatorBootstrapInbound,
): CoordinatorBootstrapRequestView {
  let visible = privateAuthorityReply(request);
  visible = bootstrapReviewReply(visible, message.factoryRuntimeAdoption === true);
  visible = compatibleRecoveryReply(visible, message.compatibleRecovery === true);
  visible = previewMonitorReply(visible, message.previewMonitor === true);
  visible = claudeHostRefreshReply(visible, message.claudeHostRefresh === true);
  visible = sourceUpdateToolingReply(visible, message.sourceUpdateTooling === true);
  visible = bootRecoveryReply(visible, message.bootRecovery === true);
  if (!message.automaticStatus) return visible;
  const automaticStatus = coordinatorAutomaticStatus(request, Date.now());
  return automaticStatus ? { ...visible, automaticStatus } : visible;
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

// COMPAT(bootstrapClaudeHostRefresh): added 2026-10-22; remove after 2027-04-22
// once all supported clients negotiate Claude refresh configuration review.
function claudeHostRefreshReply(
  request: CoordinatorBootstrapRequest,
  supported: boolean,
): CoordinatorBootstrapRequest {
  if (supported || request.plan.claudeHostRefreshConfiguration === undefined) return request;
  const { claudeHostRefreshConfiguration: _configuration, ...plan } = request.plan;
  return {
    ...request,
    plan,
    reason:
      "Reload the client to review this Claude refresh configuration. Cancellation remains available.",
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

/** Configuration changes a client must be able to display before approving them. */
function assertServiceConfigurationReview(
  message: Extract<CoordinatorBootstrapInbound, { type: "installation.bootstrap.decide.request" }>,
  request: CoordinatorBootstrapRequest | undefined,
): void {
  if (message.input.decision !== "approve") return;
  if (request?.plan.previewMonitorConfiguration !== undefined && message.previewMonitor !== true)
    throw new BootstrapRequestConflict(
      "Reload the client to review this preview monitor configuration before approval.",
    );
  if (
    request?.plan.claudeHostRefreshConfiguration !== undefined &&
    message.claudeHostRefresh !== true
  )
    throw new BootstrapRequestConflict(
      "Reload the client to review this Claude refresh configuration before approval.",
    );
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
      assertRetainedBootReview(
        message,
        service.list().find((request) => request.id === message.input.id),
      );
      if (message.input.decision === "approve" && message.claimedRecovery !== true)
        throw new BootstrapRequestConflict(
          "Reload to review exact claimed recovery before approval",
        );
      await service.decide(message.input, message.ownerPassword, message.claimedRecovery === true);
    }
    const requests = service.list().map((request) =>
      Object.assign({}, request, {
        reason: retainedBootReviewReason(request, message.recoveryBootPlan === true),
        plan: {
          ...request.plan,
          original: retainedBootReply(request.plan.original, message.recoveryBootPlan === true),
        },
      }),
    );
    return { type, payload: { requestId, requests, error: null } };
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

// COMPAT(coordinatorAutomaticAuthority): added v534; retain until 2027-04-15.
// Nested recovery views must omit private bookkeeping just like the main list.
function privateAuthorityReply(request: CoordinatorBootstrapRequest): CoordinatorBootstrapRequest {
  const {
    automaticSubmission: _submission,
    automaticApproval: _approval,
    automaticDispatch: _dispatch,
    automaticCheck: _check,
    ...publicRequest
  } = request;
  return publicRequest;
}

// COMPAT(bootRecovery): added 2026-10-15; retain until 2027-04-15.
// Cancellation remains available to strict older clients; hidden startup
// configuration cannot be approved by readers that do not understand it.
function bootRecoveryReply(
  request: CoordinatorBootstrapRequest,
  supported: boolean,
): CoordinatorBootstrapRequest {
  if (supported || !request.plan.bootRecovery) return request;
  const { bootRecovery: _recovery, ...plan } = request.plan;
  return {
    ...request,
    plan,
    reason: "Reload the client to review startup recovery. Cancellation remains available.",
  };
}

function assertBootRecoveryReview(
  message: Extract<CoordinatorBootstrapInbound, { type: "installation.bootstrap.decide.request" }>,
  request: CoordinatorBootstrapRequest | undefined,
): void {
  if (message.input.decision === "approve" && request?.plan.bootRecovery && !message.bootRecovery)
    throw new BootstrapRequestConflict(
      "Reload the client to review startup recovery before approval.",
    );
}

// COMPAT(recoveryBootPlan): added v544; retain until 2027-04-15.
// Recovery preserves the original approval; strict older readers cannot parse
// its retained startup plan and must not approve a review with hidden evidence.
function retainedBootReply(request: CoordinatorBootstrapRequest, supported: boolean) {
  return bootRecoveryReply(privateAuthorityReply(request), supported);
}

function assertRetainedBootReview(
  message: Extract<
    BootstrapPreclaimRecoveryInbound | BootstrapClaimedRecoveryInbound,
    {
      type:
        | "installation.bootstrap_recovery.decide.request"
        | "installation.claimed_recovery.decide.request";
    }
  >,
  request: BootstrapPreclaimRecoveryRequestView | BootstrapClaimedRecoveryRequestView | undefined,
): void {
  if (message.input.decision !== "approve" || message.recoveryBootPlan || !request) return;
  if (hasRetainedBootPlan(request))
    throw new BootstrapRequestConflict(
      "Reload the client to review retained startup recovery before approval.",
    );
}

function hasRetainedBootPlan(
  request: BootstrapPreclaimRecoveryRequestView | BootstrapClaimedRecoveryRequestView,
): boolean {
  const originals = [request.plan.original];
  if (request.plan.operation === "bootstrap-preclaim-recovery") {
    originals.push(request.plan.canceled);
    if (request.plan.ownerCancellation) originals.push(request.plan.ownerCancellation);
  }
  return originals.some((original) => original.plan.bootRecovery !== undefined);
}

function retainedBootReviewReason(
  request: BootstrapPreclaimRecoveryRequestView | BootstrapClaimedRecoveryRequestView,
  supported: boolean,
): string {
  if (!supported && hasRetainedBootPlan(request))
    return "Reload the client to review retained startup recovery. Cancellation remains available.";
  return request.reason;
}
