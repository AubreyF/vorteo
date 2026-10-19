import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { githubRequest } from "./github-transport.mjs";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const sha = /^[a-f0-9]{40}$/;
const check = (ok, message) => {
  if (!ok) throw new Error(message);
};

function matches(pattern, value) {
  return typeof value === "string" && pattern.test(value);
}

function isGitHubTimestamp(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    return false;
  return new Date(value).toISOString().slice(0, 19) === value.slice(0, 19);
}

function captureRetirement(receipt, authority) {
  assertFactoryRetirement(receipt);
  const captured = structuredClone(receipt);
  const assertCurrent = () => {
    authority.assertCurrent();
    check(
      isDeepStrictEqual(receipt, captured),
      "Factory retirement receipt changed during verification",
    );
  };
  assertCurrent();
  return { captured, assertCurrent };
}

function assertParkingIdentity(c) {
  check(
    c &&
      isDeepStrictEqual(Object.keys(c).sort(), [
        "blockerSha256",
        "commentId",
        "commentSha256",
        "pull",
      ]) &&
      matches(/^[a-f0-9]{64}$/, c.blockerSha256) &&
      matches(/^[a-f0-9]{64}$/, c.commentSha256) &&
      Number.isSafeInteger(c.commentId) &&
      c.commentId > 0 &&
      (c.pull === null ||
        (Number.isSafeInteger(c.pull.number) && c.pull.number > 0 && matches(sha, c.pull.head))),
    "Invalid Factory parking identity",
  );
}

export function assertFactoryRetirement(value) {
  check(
    value &&
      isDeepStrictEqual(Object.keys(value).sort(), [
        "archiveSha256",
        "attemptId",
        "completion",
        "issueNumber",
        "occurrenceId",
        "reason",
        "repository",
        "scheduleId",
        "schedulerRunId",
      ]) &&
      ["completed_elsewhere", "blocked"].includes(value.reason) &&
      matches(uuid, value.attemptId) &&
      matches(uuid, value.schedulerRunId) &&
      matches(/^[a-f0-9]{64}$/, value.archiveSha256) &&
      matches(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, value.repository) &&
      Number.isSafeInteger(value.issueNumber) &&
      value.issueNumber > 0 &&
      typeof value.scheduleId === "string" &&
      value.scheduleId.length > 0 &&
      typeof value.occurrenceId === "string" &&
      value.occurrenceId.length > 0,
    "Invalid Factory retirement receipt",
  );
  const c = value.completion;
  if (value.reason === "blocked") {
    assertParkingIdentity(c);
    return;
  }
  check(
    c &&
      isDeepStrictEqual(Object.keys(c).sort(), ["devCommit", "mergeCommit", "pullRequest"]) &&
      matches(sha, c.devCommit) &&
      matches(sha, c.mergeCommit) &&
      Number.isSafeInteger(c.pullRequest) &&
      c.pullRequest > 0,
    "Invalid Factory external completion identity",
  );
}

/** Administrative recovery, not a Factory merge receipt. A closed issue alone
 * is insufficient: the named merged PR must reference it, target dev in the
 * same repository, and remain an ancestor of the current dev head.
 */
export function createFactoryExternalCompletionVerifier({ authority, request = githubRequest }) {
  return async (input) => {
    const { captured: receipt, assertCurrent } = captureRetirement(input, authority);
    const api = async (endpoint, paginate = false) => {
      assertCurrent();
      const result = await request("GET", endpoint, undefined, paginate);
      assertCurrent();
      return structuredClone(result);
    };
    check(receipt.reason === "completed_elsewhere", "Parking is not external completion");
    const base = `repos/${receipt.repository}`;
    const issuePath = `${base}/issues/${receipt.issueNumber}`;
    const issue = await api(issuePath);
    const completed = (value) =>
      value.number === receipt.issueNumber &&
      !value.pull_request &&
      value.state === "closed" &&
      value.state_reason === "completed" &&
      isGitHubTimestamp(value.updated_at);
    check(completed(issue), "External issue completion is unconfirmed");
    const pr = await api(`${base}/pulls/${receipt.completion.pullRequest}`);
    check(
      pr.number === receipt.completion.pullRequest &&
        pr.merged === true &&
        pr.state === "closed" &&
        pr.base?.ref === "dev" &&
        pr.base.repo?.full_name === receipt.repository &&
        pr.merge_commit_sha === receipt.completion.mergeCommit,
      "External merged PR identity differs",
    );
    const timeline = await api(`${issuePath}/timeline?per_page=100`, true);
    check(
      Array.isArray(timeline) &&
        timeline.some(
          (event) =>
            event.event === "cross-referenced" &&
            event.source?.issue?.pull_request?.url ===
              `https://api.github.com/repos/${receipt.repository}/pulls/${pr.number}`,
        ),
      "External PR has no issue reference",
    );
    const head = await api(`${base}/git/ref/heads/dev`);
    check(head.object?.type === "commit" && matches(sha, head.object.sha), "Invalid dev head");
    // Both the original observation and the live head must retain the merge.
    for (const commit of new Set([receipt.completion.devCommit, head.object.sha])) {
      const comparison = await api(`${base}/compare/${pr.merge_commit_sha}...${commit}`);
      check(
        ["ahead", "identical"].includes(comparison.status) &&
          comparison.merge_base_commit?.sha === pr.merge_commit_sha,
        "External merge is absent from dev",
      );
    }
    const finalIssue = await api(issuePath);
    check(
      completed(finalIssue) && finalIssue.updated_at === issue.updated_at,
      "External issue changed during reconciliation",
    );
    assertCurrent();
    return true;
  };
}

function assertParkedPull(pull, receipt, ownerId) {
  check(
    pull.number === receipt.completion.pull.number &&
      pull.head?.sha === receipt.completion.pull.head &&
      pull.head.repo?.full_name === receipt.repository &&
      pull.base?.ref === "dev" &&
      pull.base.repo?.full_name === receipt.repository &&
      pull.state === "open" &&
      !pull.merged &&
      pull.auto_merge == null &&
      pull.user?.id === ownerId,
    "Factory parked PR requires reconciliation",
  );
}

/** A parked attempt is not a delivery. Its existing issue status remains the
 * public hold, while the full private claim and native evidence stay archived.
 */
export function createFactoryParkingVerifier({ authority, ownerId, request = githubRequest }) {
  return async (input) => {
    const { captured: receipt, assertCurrent } = captureRetirement(input, authority);
    const api = async (path) => {
      assertCurrent();
      const result = await request("GET", path);
      assertCurrent();
      return structuredClone(result);
    };
    check(receipt.reason === "blocked", "Factory parking reason differs");
    const base = `repos/${receipt.repository}`;
    const comment = await api(`${base}/issues/comments/${receipt.completion.commentId}`);
    check(
      comment.id === receipt.completion.commentId &&
        comment.user?.id === ownerId &&
        comment.issue_url === `https://api.github.com/${base}/issues/${receipt.issueNumber}` &&
        typeof comment.body === "string" &&
        comment.body.startsWith("(AI Generated).\n\n") &&
        createHash("sha256").update(comment.body).digest("hex") ===
          receipt.completion.commentSha256,
      "Factory parked status changed",
    );
    const record = /\n```json\n([\s\S]+)\n```$/.exec(comment.body);
    const status = record && JSON.parse(record[1]);
    check(
      status?.attemptId === receipt.attemptId &&
        status.issueNumber === receipt.issueNumber &&
        status.stage === "blocked",
      "Factory parked status belongs to another attempt",
    );
    if (receipt.completion.pull) {
      const pull = await api(`${base}/pulls/${receipt.completion.pull.number}`);
      assertParkedPull(pull, receipt, ownerId);
    }
    assertCurrent();
    return true;
  };
}
