import { createHash } from "node:crypto";
import Ajv from "ajv";

const criteria = [
  "outcome",
  "scope",
  "acceptance",
  "verification",
  "dependencies",
  "duplicates",
  "ownership",
  "authority",
];
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const digestPattern = /^[a-f0-9]{64}$/;
const commitPattern = /^[a-f0-9]{40}$/;
export function qualificationAuditBody({ receipt, receiptSha256 }) {
  if (receipt?.version !== 1 || hash(receipt) !== receiptSha256)
    throw new Error("Qualification audit identity changed");
  const body =
    `(AI Generated).\n\n<!-- vorton-factory:qualification:v1:${receiptSha256} -->\n\nQualification: ${receipt.assessment.decision}\n\n` +
    `${receipt.assessment.summary}\n\n\`\`\`json\n${JSON.stringify({ receipt, receiptSha256 }, null, 2)}\n\`\`\``;
  if (Buffer.byteLength(body) > 60000)
    throw new Error("Qualification audit exceeds the comment bound");
  return body;
}
const text = { type: "string", minLength: 1, maxLength: 4000 };
const assessmentValid = new Ajv({ strict: true }).compile({
  type: "object",
  additionalProperties: false,
  required: ["issueNumber", "decision", "summary", "criteria"],
  properties: {
    issueNumber: { type: "integer", minimum: 1 },
    decision: {
      enum: ["ready", "needs-information", "blocked", "duplicate", "out-of-scope"],
    },
    summary: text,
    criteria: {
      type: "object",
      additionalProperties: false,
      required: criteria,
      properties: Object.fromEntries(
        criteria.map((name) => [
          name,
          {
            type: "object",
            additionalProperties: false,
            required: ["verdict", "reason", "evidence"],
            properties: {
              verdict: { enum: ["pass", "blocked", "unknown"] },
              reason: text,
              evidence: {
                type: "array",
                maxItems: 16,
                uniqueItems: true,
                items: { type: "string", minLength: 1, maxLength: 200 },
              },
            },
          },
        ]),
      ),
    },
  },
});

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function requireQualificationIssue(issue) {
  requireValue(
    Number.isSafeInteger(issue?.number) &&
      issue.number > 0 &&
      !issue.pull_request &&
      typeof issue.title === "string" &&
      issue.title.length <= 1000 &&
      (issue.body === null || (typeof issue.body === "string" && issue.body.length <= 100000)) &&
      ["open", "closed"].includes(issue.state) &&
      Array.isArray(issue.assignees) &&
      issue.assignees.length <= 100 &&
      issue.assignees.every((person) => Number.isSafeInteger(person.id) && person.id > 0),
    "Incomplete qualification issue",
  );
}

/** Inputs originate in controller reads, never in the model's proposal. Source
 * blobs pin the inspected surface, rather than invalidating qualification for
 * every unrelated dev commit. The dispatcher must reread the same surface.
 */
export function qualificationSnapshot(input) {
  const {
    repository,
    issue,
    dependencies,
    relatedPulls,
    sourceInputs,
    evidence,
    policySha256,
    permitted,
  } = input;
  requireValue(
    /^[\w.-]+\/[\w.-]+$/.test(repository ?? "") && digestPattern.test(policySha256 ?? ""),
    "Invalid qualification policy",
  );
  requireQualificationIssue(issue);
  requireValue(
    Array.isArray(dependencies) &&
      dependencies.length <= 100 &&
      dependencies.every(
        (item) =>
          /^[\w.-]+\/[\w.-]+$/.test(item.repository) &&
          Number.isSafeInteger(item.number) &&
          item.number > 0 &&
          ["open", "closed"].includes(item.state),
      ),
    "Incomplete qualification dependencies",
  );
  requireValue(
    Array.isArray(relatedPulls) &&
      relatedPulls.length <= 100 &&
      relatedPulls.every(
        (item) =>
          Number.isSafeInteger(item.number) &&
          item.number > 0 &&
          ["open", "closed"].includes(item.state) &&
          commitPattern.test(item.head),
      ),
    "Incomplete qualification pull requests",
  );
  requireValue(
    Array.isArray(sourceInputs) &&
      sourceInputs.length > 0 &&
      sourceInputs.length <= 256 &&
      sourceInputs.every(
        (item) =>
          typeof item.path === "string" &&
          item.path.length <= 1000 &&
          !item.path.startsWith("/") &&
          !item.path.includes("\\") &&
          !item.path.split("/").some((part) => !part || part === "." || part === "..") &&
          (item.blob === null || commitPattern.test(item.blob)),
      ) &&
      new Set(sourceInputs.map((item) => item.path)).size === sourceInputs.length,
    "Invalid qualification source inputs",
  );
  requireValue(
    Array.isArray(evidence) &&
      evidence.length > 0 &&
      evidence.length <= 128 &&
      evidence.every(
        (item) =>
          typeof item.id === "string" &&
          item.id.length > 0 &&
          item.id.length <= 200 &&
          digestPattern.test(item.sha256 ?? ""),
      ) &&
      new Set(evidence.map((item) => item.id)).size === evidence.length,
    "Invalid qualification evidence",
  );
  requireValue(typeof permitted === "boolean", "Qualification needs a trusted scope decision");
  const ordered = (values) =>
    [...values].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), "en"));
  return {
    repository,
    policySha256,
    issue: {
      number: issue.number,
      title: issue.title,
      body: issue.body ?? "",
      state: issue.state,
      assignees: issue.assignees.map((person) => person.id).sort((a, b) => a - b),
    },
    dependencies: ordered(
      dependencies.map(({ repository: dependencyRepository, number, state }) => ({
        repository: dependencyRepository,
        number,
        state,
      })),
    ),
    relatedPulls: ordered(relatedPulls.map(({ number, state, head }) => ({ number, state, head }))),
    sourceInputs: ordered(sourceInputs.map(({ path, blob }) => ({ path, blob }))),
    evidence: ordered(evidence.map(({ id, sha256 }) => ({ id, sha256 }))),
    permitted,
  };
}

/** A model recommendation cannot grant execution authority. This produces an
 * auditable decision; a trusted publisher still checks its standing owner grant,
 * records the receipt durably, and only then updates the visible ready label.
 */
export function prepareQualification({ input, assessment, executionId, reviewedAt, validUntil }) {
  const snapshot = qualificationSnapshot(input);
  requireValue(
    typeof executionId === "string" && /^[a-f0-9-]{36}$/.test(executionId),
    "Qualification needs its execution identity",
  );
  requireValue(
    Number.isFinite(Date.parse(reviewedAt)) &&
      Number.isFinite(Date.parse(validUntil)) &&
      Date.parse(validUntil) > Date.parse(reviewedAt) &&
      Date.parse(validUntil) - Date.parse(reviewedAt) <= 86400000,
    "Qualification validity must be positive and at most 24 hours",
  );
  requireValue(
    assessmentValid(assessment) && assessment.issueNumber === snapshot.issue.number,
    "Invalid qualification assessment",
  );
  const evidenceIds = new Set(snapshot.evidence.map((item) => item.id));
  requireValue(
    criteria.every((name) => assessment.criteria[name].evidence.every((id) => evidenceIds.has(id))),
    "Qualification cites evidence outside its packet",
  );
  if (assessment.decision === "ready") {
    requireValue(
      snapshot.issue.state === "open" &&
        snapshot.issue.assignees.length === 0 &&
        snapshot.permitted &&
        snapshot.dependencies.every((item) => item.state === "closed") &&
        snapshot.relatedPulls.every((item) => item.state !== "open"),
      "Issue is not eligible for qualification",
    );
    requireValue(
      criteria.every(
        (name) =>
          assessment.criteria[name].verdict === "pass" &&
          assessment.criteria[name].evidence.length > 0,
      ),
      "Ready qualification requires evidence for every criterion",
    );
  }
  const receipt = {
    version: 1,
    executionId,
    reviewedAt,
    validUntil,
    inputSha256: hash(snapshot),
    snapshot,
    assessment: structuredClone(assessment),
  };
  return { receipt, receiptSha256: hash(receipt) };
}

/** Labels are only a projection. Admission requires an intact, unexpired receipt
 * and freshly captured matching inputs. Removing a label or owner hold is checked
 * separately by the queue; an old ready decision never restores it implicitly.
 */
export function assertQualificationCurrent({ receipt, receiptSha256, input, now = Date.now() }) {
  requireValue(
    Number.isFinite(now) && receipt?.version === 1 && hash(receipt) === receiptSha256,
    "Qualification receipt changed",
  );
  const rebuilt = prepareQualification({
    input,
    assessment: receipt.assessment,
    executionId: receipt.executionId,
    reviewedAt: receipt.reviewedAt,
    validUntil: receipt.validUntil,
  });
  requireValue(
    rebuilt.receiptSha256 === receiptSha256 &&
      receipt.assessment.decision === "ready" &&
      Date.parse(receipt.reviewedAt) <= now &&
      now < Date.parse(receipt.validUntil),
    "Qualification requires fresh review",
  );
  return receipt;
}
