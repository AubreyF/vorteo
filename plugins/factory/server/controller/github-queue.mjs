import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import Ajv from "ajv";
import { githubRequest } from "./github-transport.mjs";

const prefix = "(AI Generated).\n\n<!-- vorton-factory:approval:v1 -->\n```json\n";
const suffix = "\n```";
const hash = { type: "string", pattern: "^[a-f0-9]{64}$" };
const approvalValid = new Ajv({ allErrors: true }).compile({
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "action",
    "repository",
    "issueNumber",
    "issueContentSha256",
    "baseCommit",
    "configSha256",
    "host",
    "delivery",
    "scope",
  ],
  properties: {
    schemaVersion: { const: 1 },
    action: { enum: ["approve", "revoke"] },
    repository: {
      type: "string",
      pattern: "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$",
    },
    issueNumber: { type: "integer", minimum: 1 },
    issueContentSha256: hash,
    baseCommit: { type: "string", pattern: "^[a-f0-9]{40}$" },
    configSha256: hash,
    host: { const: "linux-container" },
    delivery: { const: "reviewed-draft-only" },
    scope: { type: "string", minLength: 1, maxLength: 12000 },
  },
});

export function issueContentDigest(issue) {
  if (typeof issue.title !== "string" || (issue.body !== null && typeof issue.body !== "string"))
    throw new Error("Incomplete GitHub issue content");
  return createHash("sha256")
    .update(JSON.stringify({ title: issue.title, body: issue.body ?? "" }))
    .digest("hex");
}

export function approvalComment(record) {
  if (!approvalValid(record)) throw new Error("Invalid Factory approval record");
  return prefix + JSON.stringify(record, null, 2) + suffix;
}

export function approvalFor(issue, comments, ownerId) {
  const controls = comments.filter(
    (comment) =>
      comment.user?.id === ownerId &&
      typeof comment.body === "string" &&
      comment.body.includes("<!-- vorton-factory:approval:"),
  );
  if (
    controls.some(
      (comment) =>
        !Number.isSafeInteger(comment.id) ||
        comment.id < 1 ||
        !Number.isFinite(Date.parse(comment.created_at)),
    )
  )
    return { reason: "approval_metadata_invalid" };
  controls.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.id - b.id);
  const comment = controls.at(-1);
  if (!comment) return { reason: "approval_missing" };
  if (!Number.isSafeInteger(comment.id) || !Number.isFinite(Date.parse(comment.created_at)))
    return { reason: "approval_metadata_invalid" };
  try {
    const body = comment.body.trimEnd();
    if (!body.startsWith(prefix) || !body.endsWith(suffix)) throw new Error("incomplete");
    const approval = JSON.parse(body.slice(prefix.length, -suffix.length));
    if (!approvalValid(approval) || approval.issueNumber !== issue.number)
      return { reason: "approval_invalid" };
    if (approval.action !== "approve") return { reason: "approval_revoked" };
    return { approval, comment };
  } catch {
    return { reason: "approval_invalid" };
  }
}

function hasAssignmentEvidence(comments, timeline) {
  return (
    comments.some((comment) =>
      /<!-- vorton-factory:(?:status|publication|claim):/.test(comment.body ?? ""),
    ) ||
    timeline.some(
      (event) =>
        event.event === "connected" ||
        (event.event === "cross-referenced" && event.source?.issue?.pull_request),
    )
  );
}

function selectedQueueLabels({ issue, config, excludedIssues }) {
  if (issue.pull_request || issue.state !== "open" || excludedIssues.includes(issue.number))
    return null;
  const labels = new Set(issue.labels.map((label) => label.name));
  if (
    !config.issues.requiredLabels.every((label) => labels.has(label)) ||
    config.issues.excludedLabels.some((label) => labels.has(label))
  )
    return null;
  return labels;
}

function approvalScopeMatches({ approval, issue, policy }) {
  return (
    approval.repository === policy.config.repository &&
    approval.baseCommit === policy.trustedCommit &&
    approval.configSha256 === policy.configSha256 &&
    approval.issueContentSha256 === issueContentDigest(issue)
  );
}

/** All inputs are authenticated GitHub reads. Labels alone never authorize work.
 * Selection is advisory until the controller rechecks these facts before claiming.
 */
export function selectApprovedIssues({
  policy,
  ownerId,
  issues,
  commentsByIssue,
  dependenciesByIssue,
  timelinesByIssue,
  excludedIssues = [],
}) {
  if (!Number.isSafeInteger(ownerId) || ownerId < 1)
    throw new Error("Factory requires a trusted GitHub owner ID");
  const eligible = [];
  const held = [];
  const { config } = policy;
  for (const issue of issues) {
    const labels = selectedQueueLabels({ issue, config, excludedIssues });
    if (!labels) continue;
    const hold = (reason) => held.push({ issueNumber: issue.number, reason });
    if (!Array.isArray(issue.assignees) || issue.assignees.length) {
      hold("existing_assignment");
      continue;
    }
    const priorities = config.issues.priorityLabels.filter((label) => labels.has(label));
    if (priorities.length > 1) {
      hold("conflicting_priorities");
      continue;
    }
    const dependencies = dependenciesByIssue.get(issue.number);
    if (
      !Array.isArray(dependencies) ||
      dependencies.some((dependency) => dependency.state !== "closed")
    ) {
      hold("dependencies_unresolved");
      continue;
    }
    const comments = commentsByIssue.get(issue.number);
    if (!Array.isArray(comments)) {
      hold("comments_unavailable");
      continue;
    }
    const timeline = timelinesByIssue?.get(issue.number);
    if (!Array.isArray(timeline)) {
      hold("timeline_unavailable");
      continue;
    }
    if (hasAssignmentEvidence(comments, timeline)) {
      hold("prior_assignment_or_pr");
      continue;
    }
    const result = approvalFor(issue, comments, ownerId);
    if (result.reason) {
      hold(result.reason);
      continue;
    }
    const { approval, comment } = result;
    if (!approvalScopeMatches({ approval, issue, policy })) {
      hold("approval_scope_changed");
      continue;
    }
    eligible.push({
      issueNumber: issue.number,
      title: issue.title,
      body: issue.body ?? "",
      approval,
      approvalCommentId: comment.id,
      approvedAt: comment.created_at,
      priority: priorities.length
        ? config.issues.priorityLabels.indexOf(priorities[0])
        : config.issues.priorityLabels.length,
    });
  }
  eligible.sort(
    (a, b) =>
      a.priority - b.priority ||
      Date.parse(a.approvedAt) - Date.parse(b.approvedAt) ||
      a.issueNumber - b.issueNumber,
  );
  return { eligible, held };
}

async function githubPages(endpoint) {
  return githubRequest("GET", endpoint, undefined, true);
}

async function githubIssue(endpoint) {
  return githubRequest("GET", endpoint);
}

/** Refresh the selected issue immediately before recording local ownership.
 * An old status or linked PR requires reconciliation even if its ready label
 * remains. Never infer release from a closed PR or a missing running label.
 */
export async function recheckFactoryAssignment({
  policy,
  ownerId,
  selected,
  excludedIssues = [],
  api = githubPages,
  readIssue = githubIssue,
}) {
  if (!Number.isSafeInteger(selected?.issueNumber) || selected.issueNumber < 1)
    throw new Error("Invalid Factory assignment identity");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(policy.config.repository))
    throw new Error("Invalid Factory repository");
  const endpoint = `repos/${policy.config.repository}/issues/${selected.issueNumber}`;
  const [issue, comments, dependencies, timeline] = await Promise.all([
    readIssue(endpoint),
    api(`${endpoint}/comments?per_page=100`),
    api(`${endpoint}/dependencies/blocked_by?per_page=100`),
    api(`${endpoint}/timeline?per_page=100`),
  ]);
  if (
    issue.number !== selected.issueNumber ||
    !Array.isArray(comments) ||
    !Array.isArray(dependencies) ||
    !Array.isArray(timeline)
  )
    throw new Error("Factory assignment evidence is incomplete");
  const result = selectApprovedIssues({
    policy,
    ownerId,
    issues: [issue],
    commentsByIssue: new Map([[issue.number, comments]]),
    dependenciesByIssue: new Map([[issue.number, dependencies]]),
    timelinesByIssue: new Map([[issue.number, timeline]]),
    excludedIssues,
  });
  const current = result.eligible[0];
  if (result.held[0]?.reason === "prior_assignment_or_pr")
    throw new Error("Factory prior assignment or PR requires reconciliation");
  if (
    !current ||
    current.approvalCommentId !== selected.approvalCommentId ||
    !isDeepStrictEqual(current.approval, selected.approval)
  )
    throw new Error("Factory assignment eligibility changed");
  return current;
}

/** Read-only queue discovery. Fail closed on an API failure, including dependencies. */
export async function readApprovedFactoryQueue({
  policy,
  ownerId,
  excludedIssues = [],
  api = githubPages,
}) {
  const repository = policy.config.repository;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))
    throw new Error("Invalid Factory repository");
  const base = `repos/${repository}/issues`;
  const labels = encodeURIComponent(policy.config.issues.requiredLabels.join(","));
  const issues = await api(`${base}?state=open&per_page=100&labels=${labels}`);
  const commentsByIssue = new Map();
  const dependenciesByIssue = new Map();
  const timelinesByIssue = new Map();
  for (const issue of issues) {
    if (issue.pull_request || excludedIssues.includes(issue.number)) continue;
    if (!Number.isSafeInteger(issue.number) || issue.number < 1)
      throw new Error("Invalid GitHub issue identity");
    const [comments, dependencies, timeline] = await Promise.all([
      api(`${base}/${issue.number}/comments?per_page=100`),
      api(`${base}/${issue.number}/dependencies/blocked_by?per_page=100`),
      api(`${base}/${issue.number}/timeline?per_page=100`),
    ]);
    commentsByIssue.set(issue.number, comments);
    dependenciesByIssue.set(issue.number, dependencies);
    timelinesByIssue.set(issue.number, timeline);
  }
  return selectApprovedIssues({
    policy,
    ownerId,
    issues,
    commentsByIssue,
    dependenciesByIssue,
    timelinesByIssue,
    excludedIssues,
  });
}
