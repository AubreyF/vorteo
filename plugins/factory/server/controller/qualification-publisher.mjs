import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { prepareQualification, qualificationAuditBody } from "./qualification.mjs";
import { openQualificationJournal } from "./qualification-journal.mjs";

const check = (value, message) => {
  if (!value) throw new Error(message);
};
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function requirePublisherConfiguration({ authorize, readInputs, ownerId, readyLabel }) {
  check(
    typeof authorize === "function" &&
      typeof readInputs === "function" &&
      Number.isSafeInteger(ownerId) &&
      ownerId > 0 &&
      typeof readyLabel === "string" &&
      readyLabel.length > 0 &&
      readyLabel.length <= 50,
    "Qualification publisher is not configured",
  );
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

/** Installation supplies the private journal directory and all trusted readers.
 * Serialize publication so two turns cannot race the same pending HTTP intent.
 */
export function createFactoryQualificationPublisher({ root, ...options }) {
  let flight = Promise.resolve();
  return (decision) => {
    const captured = structuredClone(decision);
    const operation = flight
      .catch(() => {})
      .then(() =>
        publishQualification({
          ...options,
          decision: captured,
          journal: openQualificationJournal({
            root,
            receiptSha256: captured.receiptSha256,
            authority: options.authority,
          }),
        }),
      );
    flight = operation;
    return operation;
  };
}

/** Runs only in the trusted controller under its lifetime lock. The journal
 * retains this exact plan and pending HTTP intent across restarts. A worker
 * assessment cannot supply the grant, credentials, transport, or fresh inputs.
 * No issue title/body is rewritten and unrelated labels remain untouched.
 */
export async function publishQualification({
  decision,
  authority,
  authorize,
  readInputs,
  journal,
  request,
  ownerId,
  readyLabel = "factory:ready",
  now = Date.now,
}) {
  requirePublisherConfiguration({ authorize, readInputs, ownerId, readyLabel });
  const { receipt, receiptSha256 } = structuredClone(decision);
  check(
    receipt?.version === 1 && hash(receipt) === receiptSha256,
    "Qualification decision changed",
  );
  const repository = receipt.snapshot.repository;
  check(/^[\w.-]+\/[\w.-]+$/.test(repository), "Invalid qualification repository");
  const number = receipt.snapshot.issue.number;
  const endpoint = `repos/${repository}/issues/${number}`;
  const guard = async () => {
    authority.assertCurrent();
    check(
      (await authorize({ repository, issueNumber: number, receiptSha256 })) === true,
      "Qualification publication is outside standing authority",
    );
    authority.assertCurrent();
  };
  const api = async (...args) => {
    await guard();
    const value = await request(...args);
    await guard();
    return value;
  };
  const fresh = async () => {
    await guard();
    const input = await readInputs(receipt.snapshot);
    await guard();
    const rebuilt = prepareQualification({
      input,
      assessment: receipt.assessment,
      executionId: receipt.executionId,
      reviewedAt: receipt.reviewedAt,
      validUntil: receipt.validUntil,
    });
    check(
      rebuilt.receiptSha256 === receiptSha256 &&
        Date.parse(receipt.reviewedAt) <= now() &&
        now() < Date.parse(receipt.validUntil),
      "Qualification publication needs fresh review",
    );
  };
  await fresh();
  check((await api("GET", "user")).id === ownerId, "Qualification publisher account changed");
  let state = await journal.read();
  if (!state) {
    state = {
      version: 1,
      decision: { receipt, receiptSha256 },
      phase: "audit",
      commentIntent: false,
      commentId: null,
      labelIntent: false,
    };
    await guard();
    await journal.write(structuredClone(state));
  }
  check(
    state.version === 1 &&
      isDeepStrictEqual(state.decision, { receipt, receiptSha256 }) &&
      ["audit", "label", "complete"].includes(state.phase),
    "Another qualification operation needs reconciliation",
  );
  const marker = `<!-- vorton-factory:qualification:v1:${receiptSha256} -->`;
  const body = qualificationAuditBody({ receipt, receiptSha256 });
  const findAudit = async () => {
    const comments = await api("GET", `${endpoint}/comments?per_page=100`, undefined, true);
    check(Array.isArray(comments), "Qualification audit read is incomplete");
    const matches = comments.filter((item) => item.body?.includes(marker));
    check(
      matches.length <= 1 &&
        matches.every(
          (item) =>
            item.user?.id === ownerId &&
            item.body === body &&
            isGitHubTimestamp(item.created_at) &&
            isGitHubTimestamp(item.updated_at) &&
            item.created_at === item.updated_at &&
            Number.isSafeInteger(item.id) &&
            item.id > 0,
        ),
      "Qualification audit identity changed",
    );
    return matches[0];
  };
  let comment = await findAudit();
  if (!comment) {
    check(
      state.phase === "audit" && state.commentIntent === false,
      "Uncertain qualification audit POST requires reconciliation",
    );
    state.commentIntent = true;
    await guard();
    await journal.write(structuredClone(state));
    await fresh();
    const created = await api("POST", `${endpoint}/comments`, { body });
    check(
      created.body === body && created.user?.id === ownerId,
      "Qualification audit write is unconfirmed",
    );
    comment = await findAudit();
  }
  check(
    comment && (state.commentId === null || state.commentId === comment.id),
    "Qualification audit receipt is missing",
  );
  if (state.phase === "audit") {
    state.commentId = comment.id;
    state.phase = "label";
    await guard();
    await journal.write(structuredClone(state));
  }
  await fresh();
  const isReady = receipt.assessment.decision === "ready";
  const readIssue = async () => {
    const issue = await api("GET", endpoint);
    check(
      issue.number === number &&
        issue.state === receipt.snapshot.issue.state &&
        Array.isArray(issue.labels) &&
        issue.labels.every((label) => typeof label.name === "string"),
      "Qualification label read is incomplete",
    );
    return issue;
  };
  let issue = await readIssue();
  const present = issue.labels.some((label) => label.name === readyLabel);
  if (state.phase === "complete") {
    check(
      present === isReady,
      "Completed qualification label changed; do not restore an owner hold",
    );
    return { receiptSha256, commentId: comment.id };
  }
  if (present !== isReady) {
    // After a lost response, absence could be an owner removal following a
    // successful write. Do not turn idempotence into permission to undo it.
    check(
      state.labelIntent === false,
      "Uncertain qualification label write requires reconciliation; preserve owner changes",
    );
    await fresh();
    if (isReady) {
      const label = await api(
        "GET",
        `repos/${repository}/labels/${encodeURIComponent(readyLabel)}`,
      );
      check(label.name === readyLabel, "Qualification cannot create a repository label");
      state.labelIntent = true;
      await guard();
      await journal.write(structuredClone(state));
      await api("POST", `${endpoint}/labels`, { labels: [readyLabel] });
    } else {
      state.labelIntent = true;
      await guard();
      await journal.write(structuredClone(state));
      await api("DELETE", `${endpoint}/labels/${encodeURIComponent(readyLabel)}`);
    }
    issue = await readIssue();
  }
  check(
    issue.labels.some((label) => label.name === readyLabel) === isReady,
    "Qualification label write is unconfirmed",
  );
  await fresh();
  check((await findAudit())?.id === comment.id, "Qualification audit changed before completion");
  state.phase = "complete";
  await guard();
  await journal.write(structuredClone(state));
  return { receiptSha256, commentId: comment.id };
}
