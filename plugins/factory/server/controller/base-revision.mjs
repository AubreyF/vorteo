import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { approvalComment } from "./github-queue.mjs";
import { assertFactoryWorkflow } from "./workflow.mjs";

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const sha256 = /^[a-f0-9]{64}$/;
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function matches(pattern, value) {
  return typeof value === "string" && pattern.test(value);
}

function pristine(workflow) {
  assertFactoryWorkflow(workflow);
  if (
    !["implementation", "checkpoint"].includes(workflow.phase) ||
    workflow.commit !== null ||
    workflow.validations.length !== 0 ||
    workflow.review !== null ||
    workflow.draft !== null ||
    workflow.blocker !== null ||
    workflow.repairAttempts !== 0
  )
    throw new Error("Factory base revision requires an unpublished pristine workflow");
}

function sameScope(previous, current) {
  approvalComment(previous);
  approvalComment(current);
  if (
    previous.action !== "approve" ||
    current.action !== "approve" ||
    previous.baseCommit === current.baseCommit ||
    !isDeepStrictEqual({ ...previous, baseCommit: current.baseCommit }, current)
  )
    throw new Error("Factory base revision changed approved issue scope");
}

function assertPriorCustody(attempt, previous) {
  for (const collection of ["executions", "helpers"]) {
    const count = previous[`${collection}Count`];
    const expected = previous[`${collection}Sha256`];
    const entries = attempt[collection] ?? [];
    if (
      !Number.isSafeInteger(count) ||
      count < 0 ||
      !Array.isArray(entries) ||
      entries.length < count ||
      !matches(sha256, expected) ||
      digest(entries.slice(0, count)) !== expected
    )
      throw new Error("Factory base revision lost prior custody history");
  }
}

/** Revision metadata is protected controller state. Its receipt binds the
 * offline, independently reviewed pristine/remote/custody checks. This module
 * does not infer owner authority or perform those external checks itself.
 */
export function assertFactoryBaseRevision(attempt) {
  if (
    !matches(uuid, attempt.attemptId) ||
    (attempt.schedulerRunId !== undefined && !matches(uuid, attempt.schedulerRunId))
  )
    throw new Error("Invalid Factory retained attempt identity");
  const revision = attempt.baseRevision;
  if (revision === undefined) return;
  const previous = revision.previous;
  if (
    revision.version !== 1 ||
    !matches(uuid, revision.id) ||
    !matches(sha256, revision.receiptSha256) ||
    !previous ||
    !Number.isSafeInteger(previous.approvalCommentId) ||
    previous.approvalCommentId < 1 ||
    !Number.isSafeInteger(attempt.approvalCommentId) ||
    attempt.approvalCommentId <= previous.approvalCommentId
  )
    throw new Error("Invalid Factory base revision");
  sameScope(previous.approval, attempt.approval);
  pristine(previous.workflow);
  assertPriorCustody(attempt, previous);
}

/** Pure state transition for the stopped, journaled operator transaction.
 * The caller must first verify fresh owner evidence, a current fast-forward
 * base, clean checkouts, absent remote delivery and native custody settlement.
 * Retrying the transaction reuses its exact planned result, not a new revision.
 */
export function createPristineBaseRevision(attempt, input) {
  if (attempt.baseRevision !== undefined)
    throw new Error("A further Factory base revision requires reconciliation");
  if (!matches(uuid, attempt.attemptId) || !matches(uuid, attempt.schedulerRunId))
    throw new Error("Factory base revision requires a retained attempt and run");
  pristine(attempt.workflow);
  const previous = {
    approval: structuredClone(attempt.approval),
    approvalCommentId: attempt.approvalCommentId,
    workflow: structuredClone(attempt.workflow),
  };
  for (const collection of ["executions", "helpers"]) {
    const entries = attempt[collection] ?? [];
    if (!Array.isArray(entries)) throw new Error("Invalid Factory custody history");
    previous[`${collection}Count`] = entries.length;
    previous[`${collection}Sha256`] = digest(entries);
  }
  const revised = structuredClone(attempt);
  revised.approval = structuredClone(input.approval);
  revised.approvalCommentId = input.approvalCommentId;
  revised.baseRevision = {
    version: 1,
    id: input.id,
    receiptSha256: input.receiptSha256,
    previous,
  };
  // The superseded operation remains in previous.workflow. Normal preparation
  // creates a fresh implementation operation, never resumes its provider turn.
  delete revised.workflow;
  assertFactoryBaseRevision(revised);
  return revised;
}

export function factoryPreparationKey(attempt) {
  assertFactoryBaseRevision(attempt);
  return attempt.baseRevision
    ? `${attempt.attemptId}-base-${attempt.baseRevision.id}`
    : attempt.attemptId;
}

export function factoryPreparationOperationId(attempt) {
  assertFactoryBaseRevision(attempt);
  return attempt.baseRevision?.id ?? attempt.attemptId;
}

export function factoryPublicationBranch(attemptId, issueNumber, revisionId) {
  if (
    !matches(uuid, attemptId) ||
    !Number.isSafeInteger(issueNumber) ||
    issueNumber < 1 ||
    (revisionId !== undefined && !matches(uuid, revisionId))
  )
    throw new Error("Invalid Factory publication identity");
  return `chore/factory-issue-${issueNumber}-${attemptId}${revisionId ? `-base-${revisionId}` : ""}`;
}

export function hasOnlyPriorRevisionExecutions(attempt) {
  assertFactoryBaseRevision(attempt);
  return (
    attempt.baseRevision !== undefined &&
    attempt.executions.length === attempt.baseRevision.previous.executionsCount
  );
}
