import { isDeepStrictEqual } from "node:util";
import { assertQualificationCurrent, qualificationAuditBody } from "./qualification.mjs";
import { issueContentDigest, approvalComment, approvalFor } from "./github-queue.mjs";
import { githubRequest } from "./github-transport.mjs";

const check = (ok, message) => {
  if (!ok) throw new Error(message);
};

function isGitHubTimestamp(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    return false;
  return new Date(value).toISOString().slice(0, 19) === value.slice(0, 19);
}

function validQualificationAuditMetadata(item) {
  return (
    Number.isSafeInteger(item.id) &&
    item.id > 0 &&
    isGitHubTimestamp(item.created_at) &&
    isGitHubTimestamp(item.updated_at)
  );
}

function qualificationStillCurrent({ decision, issue, policy, now }) {
  return (
    decision.receipt.snapshot.policySha256 === policy.configSha256 &&
    issueContentDigest(issue) === issueContentDigest(decision.receipt.snapshot.issue) &&
    now() < Date.parse(decision.receipt.validUntil)
  );
}

/** Read-only intake discovery, before qualification grants any assignment.
 * Ready-label removal remains an owner hold. Unchanged non-ready assessments
 * are reconsidered at most daily, rather than spending a turn every heartbeat.
 */
export function createFactoryIntakeSelector({
  authority,
  ownerId,
  excludedIssues: sourceExcludedIssues = [],
  readyLabel = "factory:ready",
  request = githubRequest,
  now = Date.now,
}) {
  const excludedIssues = new Set(sourceExcludedIssues);
  return async (policyInput) => {
    const policy = structuredClone(policyInput);
    authority.assertCurrent();
    const base = `repos/${policy.config.repository}/issues`;
    const issues = await request("GET", `${base}?state=open&per_page=100`, undefined, true);
    authority.assertCurrent();
    check(
      Array.isArray(issues) && issues.length <= 1000,
      "Factory intake queue is incomplete or exceeds its bound",
    );
    const candidates = issues.filter(
      (issue) =>
        !issue.pull_request &&
        !excludedIssues.has(issue.number) &&
        issue.state === "open" &&
        Array.isArray(issue.assignees) &&
        issue.assignees.length === 0 &&
        Array.isArray(issue.labels) &&
        !issue.labels.some((item) => policy.config.issues.excludedLabels.includes(item.name)),
    );
    const priority = (issue) => {
      const priorities = policy.config.issues.priorityLabels.filter((label) =>
        issue.labels.some((item) => item.name === label),
      );
      return priorities.length === 1
        ? policy.config.issues.priorityLabels.indexOf(priorities[0])
        : policy.config.issues.priorityLabels.length;
    };
    candidates.sort((a, b) => priority(a) - priority(b) || a.number - b.number);
    for (const issue of candidates) {
      check(
        Number.isSafeInteger(issue.number) && issue.number > 0,
        "Factory intake issue identity is invalid",
      );
      const comments = await request(
        "GET",
        `${base}/${issue.number}/comments?per_page=100`,
        undefined,
        true,
      );
      authority.assertCurrent();
      check(Array.isArray(comments), "Factory intake audit read is incomplete");
      if (
        comments.some((item) =>
          /<!-- vorton-factory:(?:status|publication|claim):/.test(item.body ?? ""),
        )
      )
        continue;
      if (
        comments.some(
          (item) =>
            item.user?.id === ownerId && item.body?.includes("<!-- vorton-factory:approval:"),
        ) &&
        approvalFor(issue, comments, ownerId).reason
      )
        continue;
      const decisions = comments.filter(
        (item) =>
          item.user?.id === ownerId && item.body?.includes("<!-- vorton-factory:qualification:"),
      );
      if (!decisions.every(validQualificationAuditMetadata)) continue;
      decisions.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.id - b.id);
      const latest = decisions.at(-1);
      if (latest) {
        let decision;
        try {
          const match = /\n```json\n([\s\S]+)\n```$/.exec(latest.body);
          decision = match && JSON.parse(match[1]);
          if (
            !decision ||
            qualificationAuditBody(decision) !== latest.body ||
            latest.created_at !== latest.updated_at ||
            decision.receipt.snapshot.issue.number !== issue.number ||
            decision.receipt.snapshot.repository !== policy.config.repository
          )
            continue;
        } catch {
          continue;
        }
        if (
          decision.receipt.assessment.decision === "ready" &&
          !issue.labels.some((item) => item.name === readyLabel)
        )
          continue;
        if (qualificationStillCurrent({ decision, issue, policy, now })) continue;
      }
      return { issueNumber: issue.number };
    }
    return null;
  };
}

function requireQualifiedBinding({ receipt, commentId, policy, excludedIssues }) {
  check(
    receipt.snapshot.repository === policy.config.repository &&
      !excludedIssues.has(receipt.snapshot.issue.number) &&
      receipt.snapshot.policySha256 === policy.configSha256 &&
      receipt.assessment.decision === "ready" &&
      Number.isSafeInteger(commentId) &&
      commentId > 0,
    "Qualified assignment policy differs",
  );
}

/** The controller's standing grant replaces manual per-issue approval only for
 * qualified assignments. Legacy approvals retain their existing path. Workers
 * still receive a bounded draft-publication assignment, never merge authority.
 */
export function createQualifiedAssignmentVerifier({
  authority,
  policy: policyInput,
  ownerId,
  authorize,
  readInputs,
  excludedIssues: sourceExcludedIssues = [],
  request = githubRequest,
  now = Date.now,
}) {
  const policy = structuredClone(policyInput);
  const excludedIssues = new Set(sourceExcludedIssues);
  check(
    typeof authorize === "function" &&
      typeof readInputs === "function" &&
      Number.isSafeInteger(ownerId) &&
      ownerId > 0,
    "Qualified assignment authority is incomplete",
  );
  const guard = async (binding) => {
    authority.assertCurrent();
    check(
      (await authorize({
        repository: policy.config.repository,
        issueNumber: binding.receipt.snapshot.issue.number,
        receiptSha256: binding.receiptSha256,
      })) === true,
      "Qualified assignment standing authority is unavailable",
    );
    authority.assertCurrent();
  };
  const inspect = async (binding, admission) => {
    const captured = structuredClone(binding);
    const body = qualificationAuditBody(captured);
    const { receipt, receiptSha256, commentId } = captured;
    requireQualifiedBinding({ receipt, commentId, policy, excludedIssues });
    await guard(captured);
    const base = `repos/${policy.config.repository}/issues/${receipt.snapshot.issue.number}`;
    const [actor, issue, comments, dependencies] = await Promise.all([
      request("GET", "user"),
      request("GET", base),
      request("GET", `${base}/comments?per_page=100`, undefined, true),
      request("GET", `${base}/dependencies/blocked_by?per_page=100`, undefined, true),
    ]);
    await guard(captured);
    check(
      actor.id === ownerId &&
        issue.number === receipt.snapshot.issue.number &&
        issue.state === "open" &&
        !issue.pull_request &&
        issueContentDigest(issue) === issueContentDigest(receipt.snapshot.issue) &&
        Array.isArray(issue.labels) &&
        Array.isArray(issue.assignees) &&
        issue.assignees.length === 0 &&
        Array.isArray(comments) &&
        Array.isArray(dependencies),
      "Qualified issue ownership or content changed",
    );
    const labels = new Set(issue.labels.map((label) => label.name));
    check(
      policy.config.issues.requiredLabels.every((label) => labels.has(label)) &&
        !policy.config.issues.excludedLabels.some((label) => labels.has(label)),
      "Qualified issue has an owner hold or missing ready label",
    );
    check(
      policy.config.issues.priorityLabels.filter((label) => labels.has(label)).length <= 1,
      "Qualified issue has conflicting priorities",
    );
    check(
      dependencies.every((item) => item.state === "closed"),
      "Qualified dependencies require reconciliation",
    );
    if (
      comments.some(
        (item) => item.user?.id === ownerId && item.body?.includes("<!-- vorton-factory:approval:"),
      )
    )
      check(
        !approvalFor(issue, comments, ownerId).reason,
        "Existing owner approval control requires reconciliation",
      );
    const decisions = comments.filter(
      (item) =>
        item.user?.id === ownerId && item.body?.includes("<!-- vorton-factory:qualification:"),
    );
    check(
      decisions.every(validQualificationAuditMetadata),
      "Qualification audit metadata is incomplete",
    );
    decisions.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.id - b.id);
    const audit = decisions.at(-1);
    check(
      audit?.id === commentId && audit.body === body && audit.created_at === audit.updated_at,
      "Qualification audit changed or was superseded",
    );
    if (admission) {
      check(
        !comments.some((item) =>
          /<!-- vorton-factory:(?:status|publication|claim):/.test(item.body ?? ""),
        ),
        "Qualified issue has a prior assignment requiring reconciliation",
      );
      const input = await readInputs(receipt.snapshot);
      await guard(captured);
      assertQualificationCurrent({ receipt, receiptSha256, input, now: now() });
    }
    const approval = {
      schemaVersion: 1,
      action: "approve",
      repository: policy.config.repository,
      issueNumber: issue.number,
      issueContentSha256: issueContentDigest(issue),
      baseCommit: policy.trustedCommit,
      configSha256: policy.configSha256,
      host: "linux-container",
      delivery: "reviewed-draft-only",
      scope: `${receipt.assessment.summary}\n\n${receipt.assessment.criteria.scope.reason}`,
    };
    approvalComment(approval); // Validate the internal assignment shape, not a fabricated public approval.
    return {
      approval,
      approvalCommentId: commentId,
      qualification: captured,
      issue,
      comments,
    };
  };
  return {
    async readQueue() {
      authority.assertCurrent();
      const labels = encodeURIComponent(policy.config.issues.requiredLabels.join(","));
      const base = `repos/${policy.config.repository}/issues`;
      const issues = await request(
        "GET",
        `${base}?state=open&per_page=100&labels=${labels}`,
        undefined,
        true,
      );
      authority.assertCurrent();
      check(
        Array.isArray(issues) && issues.length <= 1000,
        "Qualified queue response is incomplete or exceeds its bound",
      );
      const eligible = [],
        held = [];
      for (const issue of issues) {
        if (issue.pull_request || excludedIssues.has(issue.number)) continue;
        check(
          Number.isSafeInteger(issue.number) && issue.number > 0,
          "Qualified queue issue identity is invalid",
        );
        const comments = await request(
          "GET",
          `${base}/${issue.number}/comments?per_page=100`,
          undefined,
          true,
        );
        authority.assertCurrent();
        check(Array.isArray(comments), "Qualified queue audit response is incomplete");
        const audits = comments.filter(
          (item) =>
            item.user?.id === ownerId && item.body?.includes("<!-- vorton-factory:qualification:"),
        );
        if (!audits.every(validQualificationAuditMetadata)) {
          held.push({ issueNumber: issue.number, reason: "qualification_metadata_invalid" });
          continue;
        }
        audits.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.id - b.id);
        const latest = audits.at(-1);
        if (!latest) {
          held.push({
            issueNumber: issue.number,
            reason: "qualification_missing",
          });
          continue;
        }
        let binding;
        try {
          const match = /\n```json\n([\s\S]+)\n```$/.exec(latest.body);
          check(match, "qualification_invalid");
          binding = { ...JSON.parse(match[1]), commentId: latest.id };
          check(
            binding.receipt?.snapshot?.issue?.number === issue.number &&
              qualificationAuditBody(binding) === latest.body,
            "qualification_invalid",
          );
          await inspect(binding, true);
        } catch (error) {
          authority.assertCurrent();
          const reason =
            error instanceof Error && error.message
              ? error.message
              : "qualification_verification_failed";
          held.push({ issueNumber: issue.number, reason });
          continue;
        }
        const priorities = policy.config.issues.priorityLabels.filter((label) =>
          issue.labels.some((item) => item.name === label),
        );
        if (priorities.length > 1) {
          held.push({
            issueNumber: issue.number,
            reason: "conflicting_priorities",
          });
          continue;
        }
        eligible.push({
          issueNumber: issue.number,
          qualification: binding,
          approvedAt: latest.created_at,
          priority: priorities.length
            ? policy.config.issues.priorityLabels.indexOf(priorities[0])
            : policy.config.issues.priorityLabels.length,
        });
      }
      eligible.sort(
        (a, b) =>
          a.priority - b.priority ||
          Date.parse(a.approvedAt) - Date.parse(b.approvedAt) ||
          a.issueNumber - b.issueNumber,
      );
      authority.assertCurrent();
      return { eligible, held };
    },
    admit: (binding) => inspect(binding, true),
    async ongoing(attempt) {
      const captured = structuredClone({
        qualification: attempt.qualification,
        approval: attempt.approval,
        approvalCommentId: attempt.approvalCommentId,
      });
      const verified = await inspect(captured.qualification, false);
      check(
        isDeepStrictEqual(verified.approval, captured.approval) &&
          verified.approvalCommentId === captured.approvalCommentId &&
          isDeepStrictEqual(attempt.qualification, captured.qualification) &&
          isDeepStrictEqual(attempt.approval, captured.approval) &&
          attempt.approvalCommentId === captured.approvalCommentId,
        "Qualified assignment binding changed",
      );
      return verified;
    },
  };
}
