const day = 24 * 60 * 60 * 1000;
const sha = (value) => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const digest = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

/** Shared delivery status for the persistent build coordinator and Factory view.
 * This module does not implement the coordinator's durable request queue. Only a
 * verified successful dev publication advances the
 * clock. Queued jobs, release-prep merges and failed tags cannot satisfy the goal.
 */
export function devReleaseStatus({ repository, lastSuccess, active, now = Date.now() }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? "") || !Number.isFinite(now))
    throw new Error("Invalid dev release status inputs");
  let last = null;
  if (lastSuccess) {
    const receipt = lastSuccess;
    assertSuccessReceipt(receipt, repository, now);
    last = receipt.completedAt;
  }
  const dueAt = last ? new Date(Date.parse(last) + day).toISOString() : null;
  const due = !dueAt || Date.parse(dueAt) <= now;
  assertActiveAttempt(active, repository);
  let state = due ? "due" : "current";
  if (active) state = "in-progress";
  if (active?.phase === "blocked") state = "blocked";
  return {
    lastSuccessfulAt: last,
    dueAt,
    due,
    state,
    active: active
      ? { id: active.id, productCommit: active.productCommit, phase: active.phase }
      : null,
  };
}

function assertSuccessReceipt(receipt, repository, now) {
  if (
    receipt.version !== 1 ||
    receipt.repository !== repository ||
    receipt.channel !== "dev" ||
    receipt.status !== "published" ||
    !/^v\d+\.\d+\.\d+-dev$/.test(receipt.tag ?? "") ||
    !sha(receipt.productCommit) ||
    !sha(receipt.releaseCommit) ||
    !digest(receipt.artifactManifestSha256) ||
    !Number.isSafeInteger(receipt.runId) ||
    receipt.runId < 1 ||
    !Number.isFinite(Date.parse(receipt.completedAt)) ||
    Date.parse(receipt.completedAt) > now
  )
    throw new Error("Dev release success receipt is unverified");
}

function assertActiveAttempt(active, repository) {
  if (
    active &&
    (active.channel !== "dev" ||
      active.repository !== repository ||
      !sha(active.productCommit) ||
      typeof active.id !== "string" ||
      !/^[a-f0-9-]{36}$/.test(active.id) ||
      ![
        "source-review",
        "preparing",
        "validation",
        "review",
        "publication",
        "verification",
        "blocked",
      ].includes(active.phase))
  )
    throw new Error("Dev release attempt requires reconciliation");
}

/** Daily-release planning for the build coordinator's serialized admission.
 * Factory threads submit requests to that coordinator rather than executing
 * this plan themselves. This helper alone does not coalesce requests. The caller
 * persists the intent before any release effect and uses that identity after a
 * restart. It must also obtain native quota admission for any model work.
 * Release scripts and the protected tag publisher retain all release authority.
 */
export function planDevRelease({
  repository,
  lastSuccess,
  active,
  source,
  authorization,
  leadTimeMs = 4 * 60 * 60 * 1000,
  now = Date.now(),
}) {
  return planRelease(
    { repository, lastSuccess, active, source, authorization, leadTimeMs, now },
    false,
  );
}

/** Candidate review uses the same daily/request timing and verified CI, without
 * pretending provider or activation decisions have already been satisfied.
 * The coordinator independently verifies this retained identity before admission.
 */
export function planDevSourceReview({
  repository,
  lastSuccess,
  active,
  source,
  authorization,
  leadTimeMs = 4 * 60 * 60 * 1000,
  now = Date.now(),
}) {
  return planRelease(
    { repository, lastSuccess, active, source, authorization, leadTimeMs, now },
    true,
  );
}

function planRelease(
  { repository, lastSuccess, active, source, authorization, leadTimeMs, now },
  sourceReview,
) {
  if (!Number.isSafeInteger(leadTimeMs) || leadTimeMs <= 0 || leadTimeMs >= day)
    throw new Error("Dev release lead time must be positive and less than one day");
  const status = devReleaseStatus({ repository, lastSuccess, active, now });
  if (active) return { kind: "reconcile", status };
  const requestAt = status.dueAt
    ? new Date(Date.parse(status.dueAt) - leadTimeMs).toISOString()
    : null;
  if (requestAt && now < Date.parse(requestAt)) return { kind: "wait", status, requestAt };
  const heldReason = planningHold(repository, authorization, source);
  if (heldReason) return { kind: "held", reason: heldReason, status };
  if (sourceReview) {
    if (
      source.reviewCandidate?.productCommit !== source.commit ||
      source.reviewCandidate?.validationReceiptSha256 !== source.validation.receiptSha256
    )
      return { kind: "held", reason: "source_review_candidate_unavailable", status };
    return {
      kind: "review",
      status,
      requestAt,
      candidate: structuredClone(source.reviewCandidate),
    };
  }
  if (source.providerDecision !== "satisfied" || source.activationDecision !== "satisfied")
    return { kind: "held", reason: "source_release_decision_required", status };
  return {
    kind: "prepare",
    status,
    requestAt,
    candidate: {
      repository,
      channel: "dev",
      productCommit: source.commit,
      validationReceiptSha256: source.validation.receiptSha256,
      authorityReference: authorization.reference,
    },
  };
}

function planningHold(repository, authorization, source) {
  if (
    authorization?.repository !== repository ||
    authorization.channel !== "dev" ||
    authorization.enabled !== true ||
    typeof authorization.reference !== "string" ||
    !authorization.reference.trim()
  )
    return "dev_release_authority_unavailable";
  if (
    source?.branch !== "dev" ||
    !sha(source.commit) ||
    source.validation?.commit !== source.commit ||
    source.validation?.conclusion !== "success" ||
    !digest(source.validation.receiptSha256)
  )
    return "validated_dev_snapshot_unavailable";
  return null;
}
