import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { approvalFor, issueContentDigest } from "./github-queue.mjs";
import { factoryPublicationBranch } from "./base-revision.mjs";
import { githubRequest } from "./github-transport.mjs";
import { verifyFactoryMergedReceipt } from "./merge-controller.mjs";
export { githubRequest } from "./github-transport.mjs";

const prefix = "(AI Generated).\n\n";
const marker = (kind, id) => `<!-- vorton-factory:${kind}:v1:${id} -->`;
const commitPattern = /^[a-f0-9]{40}$/;
const stringMatches = (pattern, value) => typeof value === "string" && pattern.test(value);

function publicationBodyMatches(body, operationId) {
  return (
    typeof body === "string" &&
    body.startsWith(prefix) &&
    body.includes(marker("publication", operationId))
  );
}

function pullBranchMatches(pull, repository, branch, baseBranch) {
  return (
    pull.head?.repo?.full_name === repository &&
    pull.head?.ref === branch &&
    pull.base?.ref === baseBranch
  );
}

function assertReleasedEvidence(receipt, saved) {
  if (
    !saved ||
    !stringMatches(commitPattern, saved.commit) ||
    !stringMatches(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, saved.repository) ||
    !Number.isSafeInteger(saved.draftNumber) ||
    saved.draftNumber < 1 ||
    !Number.isSafeInteger(receipt.issueNumber) ||
    receipt.issueNumber < 1
  )
    throw new Error("Factory released receipt lacks exact delivery evidence");
}

function assertReleasedPull(pull, receipt, saved, ownerId, baseBranch) {
  const lifecycleMatches = saved.mergeReceipt
    ? pull.state === "closed" && pull.merged === true
    : pull.state === "open" && pull.draft === true;
  const branch = factoryPublicationBranch(
    receipt.attemptId,
    receipt.issueNumber,
    receipt.baseRevisionId,
  );
  if (
    !lifecycleMatches ||
    pull.number !== saved.draftNumber ||
    pull.html_url !== saved.draftUrl ||
    pull.user?.id !== ownerId ||
    pull.head?.sha !== saved.commit ||
    !pullBranchMatches(pull, saved.repository, branch, baseBranch) ||
    !publicationBodyMatches(pull.body, receipt.publicationOperationId)
  )
    throw new Error("Factory released draft differs from its verified delivery");
}

function assertOwnedPull(pull, expected) {
  const lifecycleMatches =
    pull.state === "open" ||
    (expected.allowMerged && pull.state === "closed" && pull.merged === true);
  const identityMatches =
    Number.isSafeInteger(pull.number) &&
    pull.number > 0 &&
    pull.html_url === `https://github.com/${expected.repository}/pull/${pull.number}` &&
    pull.user?.id === expected.ownerId;
  const headMatches =
    stringMatches(commitPattern, pull.head?.sha) &&
    pullBranchMatches(pull, expected.repository, expected.branch, expected.baseBranch);
  if (
    !lifecycleMatches ||
    !identityMatches ||
    !headMatches ||
    typeof pull.draft !== "boolean" ||
    typeof pull.title !== "string" ||
    !publicationBodyMatches(pull.body, expected.operationId)
  )
    throw new Error("Factory existing draft differs from reviewed delivery");
}

function assertDraftContent(commit, title, summary) {
  if (
    !stringMatches(commitPattern, commit) ||
    typeof title !== "string" ||
    !title.trim() ||
    title.length > 200 ||
    /codex|claude|chatgpt|copilot/i.test(title) ||
    typeof summary !== "string" ||
    summary.length > 12000
  )
    throw new Error("Invalid Factory draft content");
}

function assertIndependentReview(attempt, review, commit) {
  const implementations = attempt.executions.filter((item) =>
    ["implementation", "repair"].includes(item.binding.stage),
  );
  const reviewer = attempt.executions.find(
    (item) => item.identity.executionId === review?.executionId && item.binding.stage === "review",
  );
  if (
    !implementations.length ||
    !reviewer ||
    review.approved !== true ||
    review.commit !== commit ||
    implementations.some((item) => item.identity.executionId === review.executionId)
  )
    throw new Error("Factory draft lacks independent exact-commit review");
}

function assertRequiredValidation(attempt, validations, commit, required) {
  if (
    !Array.isArray(validations) ||
    validations.length !== required.length ||
    validations.some(
      (result, index) =>
        result.commit !== commit ||
        result.exitCode !== 0 ||
        !isDeepStrictEqual(result.command, required[index]) ||
        !attempt.executions.some(
          (item) =>
            item.identity.executionId === result.executionId && item.binding.stage === "validation",
        ),
    )
  )
    throw new Error("Factory draft lacks required validation evidence");
}

function assertRepairIdentity(existing, previous, commit) {
  if (
    !existing ||
    existing.number !== previous.number ||
    existing.html_url !== previous.url ||
    existing.auto_merge !== null ||
    ![previous.commit, commit].includes(existing.head.sha)
  )
    throw new Error(
      "Factory repair publication lost its prior PR identity or automatic merge hold",
    );
}

function exactDraftMatches(existing, commit, title, body) {
  return (
    existing &&
    existing.head.sha === commit &&
    existing.draft === true &&
    existing.title === title &&
    existing.body === body &&
    existing.auto_merge === null
  );
}

function assertPriorContent(existing, previous) {
  if (
    !previous ||
    !stringMatches(/^[a-f0-9]{64}$/, previous.publicationSha256) ||
    createHash("sha256")
      .update(JSON.stringify({ title: existing.title, body: existing.body }))
      .digest("hex") !== previous.publicationSha256
  )
    throw new Error("Factory publication content changed outside the reviewed delivery");
}

function assertCreatedDraft(created, title, body, previous) {
  if (
    !created ||
    created.title !== title ||
    created.body !== body ||
    created.auto_merge !== null ||
    (previous && created.number !== previous.number)
  )
    throw new Error("Factory draft creation is unconfirmed");
}

/** Recover scheduler completion only for the original verified delivery. Legacy
 * receipts without a commit cannot establish an exact completed candidate.
 */
export async function verifyFactoryReleasedDelivery({
  authority,
  claims,
  receipt,
  ownerId,
  baseBranch,
  request = githubRequest,
}) {
  const invocationReceipt = receipt;
  receipt = structuredClone(receipt);
  const assertCurrent = authority.assertCurrent;
  const current = claims.current;
  const assertInputs = () => {
    if (
      authority.assertCurrent !== assertCurrent ||
      claims.current !== current ||
      !isDeepStrictEqual(invocationReceipt, receipt)
    )
      throw new Error("Factory released verification input changed");
  };
  const guard = () => {
    assertInputs();
    assertCurrent.call(authority);
    assertInputs();
    const state = current.call(claims);
    assertInputs();
    if (state.active || !isDeepStrictEqual(state.lastReleased, receipt))
      throw new Error("Factory released receipt changed");
  };
  guard();
  const saved = receipt.delivery;
  assertReleasedEvidence(receipt, saved);
  const pull = await request("GET", `repos/${saved.repository}/pulls/${saved.draftNumber}`);
  guard();
  assertReleasedPull(pull, receipt, saved, ownerId, baseBranch);
  if (saved.mergeReceipt)
    await verifyFactoryMergedReceipt({
      receipt: saved.mergeReceipt,
      assertCurrent: guard,
      request,
    });
  guard();
  return saved.draftUrl;
}

/** One trusted publisher. All callbacks and evidence originate in controller code.
 * Losing a response never authorizes a second comment or PR without reconciliation.
 */
class FactoryGitHubDelivery {
  constructor({
    authority,
    claims,
    policy,
    ownerId,
    request = githubRequest,
    publish,
    checkpointPublisher,
    verifyQualified,
  }) {
    if (!Number.isSafeInteger(ownerId) || ownerId < 1)
      throw new Error("Factory publication requires its trusted owner ID");
    if (!stringMatches(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, policy.config.repository))
      throw new Error("Invalid Factory publication repository");
    if (publish !== undefined && typeof publish !== "function")
      throw new Error("Invalid Factory trusted publication callback");
    if (checkpointPublisher !== undefined && typeof checkpointPublisher !== "function")
      throw new Error("Invalid Factory checkpoint publication callback");
    Object.assign(this, {
      authority,
      claims,
      policy,
      ownerId,
      request,
      publish,
      checkpointPublisher,
      verifyQualified,
    });
    this.captured = {
      authority,
      claims,
      policy,
      ownerId,
      request,
      publish,
      checkpointPublisher,
      verifyQualified,
    };
    this.portMethods = {
      assertCurrent: authority.assertCurrent,
      current: claims.current,
      reconcile: claims.reconcile,
      bindHelperExecution: claims.bindHelperExecution,
    };
    this.policySnapshot = structuredClone(policy);
    this.base = `repos/${policy.config.repository}`;
    this.pending = Promise.resolve();
  }

  serialize(operation) {
    const work = this.pending.catch(() => {}).then(operation);
    this.pending = work;
    return work;
  }

  assertPorts() {
    for (const [name, value] of Object.entries(this.captured)) {
      if (this[name] !== value) throw new Error("Factory publication port changed");
    }
    if (
      this.authority.assertCurrent !== this.portMethods.assertCurrent ||
      this.claims.current !== this.portMethods.current ||
      this.claims.reconcile !== this.portMethods.reconcile ||
      this.claims.bindHelperExecution !== this.portMethods.bindHelperExecution
    )
      throw new Error("Factory publication native port changed");
    if (!isDeepStrictEqual(this.policy, this.policySnapshot))
      throw new Error("Factory publication policy changed");
  }

  assertAttempt(attempt) {
    this.assertPorts();
    this.portMethods.assertCurrent.call(this.authority);
    this.assertPorts();
    const state = this.portMethods.current.call(this.claims);
    this.assertPorts();
    if (!isDeepStrictEqual(state.active, attempt))
      throw new Error("Factory publication attempt changed");
    if (
      attempt.approval.repository !== this.policy.config.repository ||
      attempt.approval.baseCommit !== this.policy.trustedCommit ||
      attempt.approval.configSha256 !== this.policy.configSha256
    )
      throw new Error("Factory publication policy changed");
  }

  captureRead(invocationAttempt, invocationValue) {
    const attempt = structuredClone(invocationAttempt);
    const value = structuredClone(invocationValue);
    const assertInputs = () => {
      if (
        !isDeepStrictEqual(invocationAttempt, attempt) ||
        !isDeepStrictEqual(invocationValue, value)
      )
        throw new Error("Factory publication read input changed");
    };
    const guard = () => {
      assertInputs();
      this.assertAttempt(attempt);
      assertInputs();
    };
    guard();
    return { attempt, value, guard };
  }

  async currentApproval(invocationAttempt) {
    const { attempt, guard } = this.captureRead(invocationAttempt);
    if (attempt.qualification !== undefined) {
      if (typeof this.verifyQualified !== "function")
        throw new Error("Factory qualified assignment verifier is unavailable");
      const verified = await this.verifyQualified(structuredClone(attempt));
      guard();
      if (
        !isDeepStrictEqual(verified.approval, attempt.approval) ||
        verified.approvalCommentId !== attempt.approvalCommentId
      )
        throw new Error("Factory qualified publication binding changed");
      return { issue: verified.issue, comments: verified.comments };
    }
    const number = attempt.approval.issueNumber;
    const [actor, issue, comments] = await Promise.all([
      this.request("GET", "user"),
      this.request("GET", `${this.base}/issues/${number}`),
      this.request("GET", `${this.base}/issues/${number}/comments?per_page=100`, undefined, true),
    ]);
    guard();
    const control = approvalFor(issue, comments, this.ownerId);
    if (
      actor.id !== this.ownerId ||
      issue.state !== "open" ||
      issue.pull_request ||
      control.reason ||
      control.comment.id !== attempt.approvalCommentId ||
      !isDeepStrictEqual(control.approval, attempt.approval) ||
      issueContentDigest(issue) !== attempt.approval.issueContentSha256
    )
      throw new Error("Factory publication approval requires reconciliation");
    return { issue, comments };
  }

  writeProgress(attempt, progress) {
    const capturedAttempt = structuredClone(attempt);
    const capturedProgress = structuredClone(progress);
    return this.serialize(() => this.writeProgressSerial(capturedAttempt, capturedProgress));
  }

  async writeProgressSerial(attempt, progress) {
    const allowed = new Set(["stage", "commit", "branch", "pr", "message"]);
    if (
      Object.keys(progress).some((key) => !allowed.has(key)) ||
      !["working", "reviewing", "draft published", "blocked"].includes(progress.stage) ||
      (progress.commit !== undefined && !stringMatches(commitPattern, progress.commit)) ||
      Object.values(progress).some((value) => typeof value !== "string" || value.length > 12000)
    )
      throw new Error("Invalid Factory public progress");
    const { comments } = await this.currentApproval(attempt);
    const tag = marker("status", attempt.statusOperationId);
    const matches = comments.filter((comment) => comment.body?.includes(tag));
    if (
      matches.length > 1 ||
      matches.some(
        (comment) =>
          comment.user?.id !== this.ownerId || !Number.isSafeInteger(comment.id) || comment.id < 1,
      )
    )
      throw new Error("Factory status comment requires reconciliation");
    const record = {
      schemaVersion: 1,
      issueNumber: attempt.approval.issueNumber,
      attemptId: attempt.attemptId,
      ownershipGeneration: attempt.controllerEpoch,
      ...progress,
      updatedAt: new Date().toISOString(),
    };
    const body = prefix + tag + "\n```json\n" + JSON.stringify(record, null, 2) + "\n```";
    this.assertAttempt(attempt);
    const result = matches.length
      ? await this.request("PATCH", `${this.base}/issues/comments/${matches[0].id}`, { body })
      : await this.request("POST", `${this.base}/issues/${attempt.approval.issueNumber}/comments`, {
          body,
        });
    this.assertAttempt(attempt);
    if (
      !Number.isSafeInteger(result.id) ||
      result.id < 1 ||
      result.html_url !==
        `https://github.com/${this.policy.config.repository}/issues/${attempt.approval.issueNumber}#issuecomment-${result.id}` ||
      result.user?.id !== this.ownerId ||
      result.body !== body
    )
      throw new Error("Factory status write is unconfirmed");
    return { id: result.id, url: result.html_url };
  }

  branch(attempt) {
    return factoryPublicationBranch(
      attempt.attemptId,
      attempt.approval.issueNumber,
      attempt.baseRevision?.id,
    );
  }

  async findOwnedPull(invocationAttempt, allowMerged = false) {
    const { attempt, guard } = this.captureRead(invocationAttempt);
    const branch = this.branch(attempt);
    const owner = this.policy.config.repository.split("/")[0];
    const pulls = await this.request(
      "GET",
      `${this.base}/pulls?state=all&per_page=100&head=${encodeURIComponent(owner + ":" + branch)}`,
      undefined,
      true,
    );
    guard();
    if (!pulls.length) return null;
    if (pulls.length !== 1) throw new Error("Factory draft identity is ambiguous");
    let pull = pulls[0];
    if (allowMerged && pull.state === "closed") {
      // The list endpoint omits `merged`. Recovery needs the exact detail
      // response, not a fabricated boolean or an inference from closed state.
      const number = pull.number;
      if (!Number.isSafeInteger(number) || number < 1)
        throw new Error("Factory closed publication identity is invalid");
      pull = await this.request("GET", `${this.base}/pulls/${number}`);
      guard();
      if (pull.number !== number)
        throw new Error("Factory closed publication detail identity changed");
    }
    assertOwnedPull(pull, {
      repository: this.policy.config.repository,
      ownerId: this.ownerId,
      branch,
      baseBranch: this.policy.config.baseBranch,
      operationId: attempt.publicationOperationId,
      allowMerged,
    });
    guard();
    return pull;
  }

  async findDraft(invocationAttempt, commit) {
    const { attempt, guard } = this.captureRead(invocationAttempt);
    const pull = await this.findOwnedPull(attempt);
    guard();
    if (pull && (pull.draft !== true || pull.head.sha !== commit))
      throw new Error("Factory existing draft differs from reviewed delivery");
    guard();
    return pull;
  }

  publishDraft(input) {
    const { signal, ...data } = input;
    const captured = { ...structuredClone(data), signal };
    return this.serialize(() => this.publishDraftSerial(captured));
  }

  /** Match the retained publication, including content, before merge admission.
   * A matching head alone cannot authorize promotion after an owner edit.
   */
  async verifyPublication(invocationAttempt, invocationCandidate) {
    const {
      attempt,
      value: candidate,
      guard,
    } = this.captureRead(invocationAttempt, invocationCandidate);
    const saved = attempt.workflow?.draft;
    const recoveringMerge = Boolean(attempt.workflow?.operation?.mergeState?.intent);
    const pull = await this.findOwnedPull(attempt, recoveringMerge);
    guard();
    if (
      !saved ||
      !pull ||
      candidate.commit !== attempt.workflow.commit ||
      saved.commit !== candidate.commit ||
      saved.number !== candidate.number ||
      pull.number !== candidate.number ||
      pull.html_url !== saved.url ||
      pull.head.sha !== candidate.commit ||
      pull.auto_merge !== null ||
      !stringMatches(/^[a-f0-9]{64}$/, saved.publicationSha256 ?? "") ||
      createHash("sha256")
        .update(JSON.stringify({ title: pull.title, body: pull.body }))
        .digest("hex") !== saved.publicationSha256
    )
      throw new Error("Factory reviewed publication requires reconciliation");
    // A completed squash can close the issue and delete the branch. Its retained
    // merge intent is independently reconciled by the merge controller.
    if (pull.state === "open") await this.verifyRemoteCheckpoint(attempt, candidate.commit);
    guard();
    return pull;
  }

  promoteReviewed(input) {
    let attempt = structuredClone(input.attempt);
    const candidate = structuredClone(input.candidate);
    const signal = input.signal;
    return this.serialize(async () => {
      const pull = await this.verifyPublication(attempt, candidate);
      // Recover a helper that completed before its response was retained.
      if (!pull.draft) return pull;
      const operation = attempt.workflow?.operation;
      if (operation?.kind !== "merge" || typeof this.publish !== "function")
        throw new Error("Factory READY promotion has no retained merge operation");
      await this.publish({
        attemptId: attempt.attemptId,
        operationId: operation.id,
        repository: this.policy.config.repository,
        commit: candidate.commit,
        expectedBase: this.policy.trustedCommit,
        title: pull.title,
        body: pull.body,
        branch: this.branch(attempt),
        base: this.policy.config.baseBranch,
        draft: false,
        expectedRemote: candidate.commit,
        verifyRemote: async () => {
          const current = await this.verifyPublication(attempt, candidate);
          if (!isDeepStrictEqual(current, pull))
            throw new Error("Factory PR changed before READY helper dispatch");
        },
        signal,
        assertCurrent: () => this.assertAttempt(attempt),
        retainHelper: async (custody, workspace) => {
          this.assertAttempt(attempt);
          const binding = {
            operationId: operation.id,
            kind: "merge",
            workspace,
          };
          const expected = {
            ...attempt,
            helpers: [
              ...(attempt.helpers ?? []),
              {
                directory: custody.directory,
                identity: structuredClone(custody.identity),
                binding,
              },
            ],
          };
          await this.claims.bindHelperExecution(attempt.attemptId, custody, binding);
          this.assertAttempt(expected);
          attempt = expected;
        },
      });
      const ready = await this.verifyPublication(attempt, candidate);
      if (ready.draft) throw new Error("Factory READY promotion is unconfirmed");
      return ready;
    });
  }

  async verifyRemoteCheckpoint(invocationAttempt, commit) {
    const { attempt, guard } = this.captureRead(invocationAttempt);
    if (!stringMatches(commitPattern, commit)) throw new Error("Invalid Factory checkpoint commit");
    await this.currentApproval(attempt);
    guard();
    const reference = await this.request(
      "GET",
      `${this.base}/git/ref/heads/${this.branch(attempt)}`,
    );
    guard();
    if (reference.object?.type !== "commit" || reference.object.sha !== commit)
      throw new Error("Factory remote checkpoint differs from candidate");
    return true;
  }

  pushCheckpoint(input) {
    let attempt = structuredClone(input.attempt);
    const commit = input.commit;
    const signal = input.signal;
    return this.serialize(async () => {
      if (!stringMatches(commitPattern, commit) || typeof this.checkpointPublisher !== "function")
        throw new Error("Factory trusted checkpoint publisher is unavailable");
      this.assertAttempt(attempt);
      await this.claims.reconcile();
      await this.currentApproval(attempt);
      if (await this.findDraft(attempt, commit))
        throw new Error("Factory checkpoint branch already has a draft");
      const operation = attempt.workflow?.operation;
      if (operation?.kind !== "checkpoint")
        throw new Error("Factory checkpoint has no retained workflow operation");
      await this.checkpointPublisher({
        attemptId: attempt.attemptId,
        operationId: operation.id,
        repository: this.policy.config.repository,
        commit,
        expectedBase: this.policy.trustedCommit,
        base: this.policy.config.baseBranch,
        branch: this.branch(attempt),
        title: "chore: checkpoint factory candidate",
        signal,
        assertCurrent: () => this.assertAttempt(attempt),
        retainHelper: async (custody, workspace) => {
          this.assertAttempt(attempt);
          const binding = {
            operationId: operation.id,
            kind: "checkpoint",
            workspace,
          };
          const entry = {
            directory: custody.directory,
            identity: structuredClone(custody.identity),
            binding,
          };
          const expected = {
            ...attempt,
            helpers: [...(attempt.helpers ?? []), entry],
          };
          await this.claims.bindHelperExecution(attempt.attemptId, custody, binding);
          this.assertAttempt(expected);
          attempt = expected;
        },
      });
      if (signal?.aborted) throw new Error("Factory checkpoint stopped; reconcile remote branch");
      await this.verifyRemoteCheckpoint(attempt, commit);
      return commit;
    });
  }

  async publishDraftSerial({ attempt, commit, title, summary, review, validations, signal }) {
    assertDraftContent(commit, title, summary);
    this.assertAttempt(attempt);
    await this.claims.reconcile();
    this.assertAttempt(attempt);
    assertIndependentReview(attempt, review, commit);
    assertRequiredValidation(attempt, validations, commit, this.policy.config.validation);
    await this.currentApproval(attempt);
    const previous = attempt.workflow?.draft;
    const existing = previous
      ? await this.findOwnedPull(attempt)
      : await this.findDraft(attempt, commit);
    if (previous) assertRepairIdentity(existing, previous, commit);
    const reference = await this.request(
      "GET",
      `${this.base}/git/ref/heads/${this.branch(attempt)}`,
    );
    this.assertAttempt(attempt);
    const expectedRemote = existing?.head.sha ?? commit;
    if (reference.object?.type !== "commit" || reference.object.sha !== expectedRemote)
      throw new Error("Factory remote branch differs from reviewed commit");
    const body =
      prefix +
      marker("publication", attempt.publicationOperationId) +
      `\n\n${summary}\n\nAddresses #${attempt.approval.issueNumber}.\n\n` +
      `Validated and independently reviewed commit: ${commit}.\n\n` +
      "```json\n" +
      JSON.stringify(
        { schemaVersion: 1, attemptId: attempt.attemptId, review, validations },
        null,
        2,
      ) +
      "\n```";
    // A helper can finish before its response is retained. Recover only the
    // exact reviewed body, head and draft state, never infer completion from SHA.
    if (exactDraftMatches(existing, commit, title, body)) return existing;
    if (existing) assertPriorContent(existing, previous);
    if (!this.publish) throw new Error("Factory trusted repository publication is not installed");
    this.assertAttempt(attempt);
    // The installed callback invokes the trusted repository helper. Never fall
    // back to direct PR creation if that helper is absent or refuses delivery.
    // Its return value is not evidence; GitHub reconciliation below is required.
    await this.publish({
      attemptId: attempt.attemptId,
      operationId: attempt.publicationOperationId,
      repository: this.policy.config.repository,
      commit,
      expectedBase: this.policy.trustedCommit,
      title,
      body,
      branch: this.branch(attempt),
      base: this.policy.config.baseBranch,
      draft: true,
      expectedRemote,
      verifyRemote: async () => {
        const head = await this.request(
          "GET",
          `${this.base}/git/ref/heads/${this.branch(attempt)}`,
        );
        this.assertAttempt(attempt);
        if (
          head.object?.type !== "commit" ||
          head.object.sha !== expectedRemote ||
          !isDeepStrictEqual(await this.findOwnedPull(attempt), existing)
        )
          throw new Error("Factory publication remote changed before helper dispatch");
      },
      signal,
      assertCurrent: () => this.assertAttempt(attempt),
      retainHelper: async (custody, workspace) => {
        this.assertAttempt(attempt);
        const operation = attempt.workflow?.operation;
        if (operation?.kind !== "publication")
          throw new Error("Factory publication has no retained helper operation");
        const binding = {
          operationId: operation.id,
          kind: "publication",
          workspace,
        };
        const entry = {
          directory: custody.directory,
          identity: structuredClone(custody.identity),
          binding,
        };
        const expected = {
          ...attempt,
          helpers: [...(attempt.helpers ?? []), entry],
        };
        await this.claims.bindHelperExecution(attempt.attemptId, custody, binding);
        // Only this exact appended helper may refresh the snapshot. Changes to
        // approval, workflow, previous executions or another helper still hold.
        this.assertAttempt(expected);
        attempt = expected;
      },
    });
    // Read the authoritative result even after a successful response. Helper
    // failure returns to the controller; retry runs findDraft first.
    const created = await this.findDraft(attempt, commit);
    assertCreatedDraft(created, title, body, previous);
    return created;
  }
}

export function createFactoryGitHubDelivery(input) {
  return new FactoryGitHubDelivery(input);
}
