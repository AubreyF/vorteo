import {
  closeSync,
  constants,
  fsyncSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, join, relative } from "node:path";
import { isDeepStrictEqual } from "node:util";
import Ajv from "ajv";
import { approvalComment, recheckFactoryAssignment } from "./github-queue.mjs";
import { assertFactoryWorkflow } from "./workflow.mjs";
import { assertFactoryRetirement } from "./retirement.mjs";
import { qualificationAuditBody } from "./qualification.mjs";
import { assertFactoryMergeReceipt } from "./merge-controller.mjs";
import {
  assertFactoryBaseRevision,
  factoryPreparationOperationId,
  hasOnlyPriorRevisionExecutions,
} from "./base-revision.mjs";

const scheduleRunPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

function matches(pattern, value) {
  return typeof value === "string" && pattern.test(value);
}

const custodyIdentityValid = new Ajv().compile({
  type: "object",
  additionalProperties: false,
  required: [
    "version",
    "executionId",
    "authenticationGeneration",
    "attemptId",
    "ownershipGeneration",
    "nonce",
  ],
  properties: {
    version: { const: 1 },
    executionId: { type: "string", pattern: scheduleRunPattern.source },
    authenticationGeneration: { type: "string", minLength: 1, maxLength: 256 },
    attemptId: { type: "string", minLength: 1, maxLength: 256 },
    ownershipGeneration: { type: "integer", minimum: 1 },
    nonce: { type: "string", pattern: scheduleRunPattern.source },
  },
});

const bindingValid = new Ajv().compile({
  type: "object",
  additionalProperties: false,
  required: ["account", "reservationId", "providerId", "stage", "workspace", "occurrenceId"],
  properties: {
    account: {
      type: "object",
      additionalProperties: false,
      required: ["issuer", "accountId"],
      properties: {
        issuer: { type: "string", minLength: 1 },
        accountId: { type: "string", minLength: 1 },
      },
    },
    reservationId: {
      type: "string",
      pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    },
    providerId: { type: "string", minLength: 1 },
    occurrenceId: { type: "string", minLength: 1 },
    stage: { enum: ["implementation", "validation", "review", "repair"] },
    workspace: { type: "string", minLength: 1 },
  },
});

const helperBindingValid = new Ajv().compile({
  type: "object",
  additionalProperties: false,
  required: ["operationId", "kind", "workspace"],
  properties: {
    operationId: { type: "string", pattern: scheduleRunPattern.source },
    kind: { enum: ["preparation", "checkpoint", "publication", "merge"] },
    workspace: { type: "string", minLength: 1 },
  },
});

function contains(parent, child) {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("../") && path !== ".." && !isAbsolute(path));
}

function read(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    if (
      !info.isFile() ||
      info.uid !== process.getuid() ||
      (info.mode & 0o777) !== 0o600 ||
      info.nlink !== 1 ||
      info.size > 1024 * 1024
    )
      throw new Error("Unsafe Factory claim record");
    const bytes = Buffer.alloc(1024 * 1024 + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, length);
      if (count === 0) break;
      length += count;
    }
    const after = fstatSync(fd);
    if (
      length > 1024 * 1024 ||
      length !== info.size ||
      after.size !== info.size ||
      after.mtimeMs !== info.mtimeMs ||
      after.ctimeMs !== info.ctimeMs ||
      after.nlink !== info.nlink
    )
      throw new Error("Factory claim record changed during read");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
    return JSON.parse(text);
  } finally {
    closeSync(fd);
  }
}

function removeTemporary(path) {
  try {
    unlinkSync(path);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function assertOwnedInput(authority, input, captured) {
  authority.assertCurrent();
  if (!isDeepStrictEqual(input, captured))
    throw new Error("Factory invocation changed during operation");
}

function durableWrite(root, name, value, exclusive = false) {
  const temporary = join(root, `.claim-${randomUUID()}`);
  const fd = openSync(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, JSON.stringify(value));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    if (exclusive) {
      let exists = true;
      try {
        if (!isDeepStrictEqual(read(join(root, name)), value))
          throw new Error("Factory archive identity was reused");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        exists = false;
      }
      // The installation lease and serial controller own this private root.
      // Rename avoids leaving a two-link archive after an interrupted publish.
      if (!exists) renameSync(temporary, join(root, name));
    } else renameSync(temporary, join(root, name));
    const directoryFd = openSync(
      root,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      fsyncSync(directoryFd);
    } finally {
      closeSync(directoryFd);
    }
  } finally {
    removeTemporary(temporary);
  }
}

function directory(path) {
  const info = lstatSync(path);
  if (
    !info.isDirectory() ||
    info.uid !== process.getuid() ||
    (info.mode & 0o777) !== 0o700 ||
    realpathSync(path) !== path
  )
    throw new Error("Unsafe Factory custody directory");
}

function invalidReleasedSchedule(released) {
  return (
    typeof released.schedulerRunId !== "string" ||
    !scheduleRunPattern.test(released.schedulerRunId) ||
    typeof released.scheduleId !== "string" ||
    !released.scheduleId ||
    typeof released.occurrenceId !== "string" ||
    !released.occurrenceId ||
    !Number.isSafeInteger(released.issueNumber) ||
    released.issueNumber < 1
  );
}

/** Release metadata is one projection of the sealed active claim. Reuse it for
 * writing and reading so a valid-looking pointer cannot change delivered work.
 */
function releasedMetadata(active) {
  return {
    ...(active.baseRevision ? { baseRevisionId: active.baseRevision.id } : {}),
    ...(active.workflow?.phase === "release"
      ? {
          delivery: {
            repository: active.approval.repository,
            commit: active.workflow.commit,
            draftNumber: active.workflow.draft.number,
            draftUrl: active.workflow.draft.url,
            ...(active.workflow.draft.mergeReceipt
              ? { mergeReceipt: active.workflow.draft.mergeReceipt }
              : {}),
          },
        }
      : {}),
    ...(active.schedulerRunId
      ? {
          schedulerRunId: active.schedulerRunId,
          scheduleId: active.scheduleId,
          occurrenceId: active.occurrenceId,
          issueNumber: active.approval.issueNumber,
        }
      : {}),
  };
}

function assertReleasedArchive(journal, state, released) {
  if (!matches(/^[a-f0-9]{64}$/, released.archiveSha256))
    throw new Error("Invalid Factory delivery archive digest");
  const archive = read(join(journal.authority.root, `delivered-${released.archiveSha256}.json`));
  if (
    createHash("sha256").update(JSON.stringify(archive)).digest("hex") !== released.archiveSha256 ||
    archive.installationId !== state.installationId ||
    archive.active?.attemptId !== released.attemptId ||
    archive.active.publicationOperationId !== released.publicationOperationId ||
    !isDeepStrictEqual(
      releasedMetadata(archive.active),
      Object.fromEntries(
        Object.entries(released).filter(
          ([key]) => !["attemptId", "publicationOperationId", "archiveSha256"].includes(key),
        ),
      ),
    )
  )
    throw new Error("Factory delivery archive changed");
}

function assertReleasedDelivery(journal, state, released) {
  const value = released.delivery;
  if (
    !value ||
    !isDeepStrictEqual(
      Object.keys(value)
        .filter((key) => key !== "mergeReceipt")
        .sort(),
      ["commit", "draftNumber", "draftUrl", "repository"],
    ) ||
    !matches(/^[a-f0-9]{40}$/, value.commit) ||
    !matches(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, value.repository) ||
    !Number.isSafeInteger(value.draftNumber) ||
    value.draftNumber < 1 ||
    value.draftUrl !== `https://github.com/${value.repository}/pull/${value.draftNumber}`
  )
    throw new Error("Invalid Factory released delivery identity");
  if (value.mergeReceipt !== undefined) {
    assertFactoryMergeReceipt(value.mergeReceipt);
    if (
      value.mergeReceipt.head !== value.commit ||
      value.mergeReceipt.number !== value.draftNumber ||
      value.mergeReceipt.repository !== value.repository ||
      value.mergeReceipt.url !== value.draftUrl
    )
      throw new Error("Factory released merge identity differs");
  }
}

function releasedIdentityKeys(released) {
  const associated =
    released &&
    ["schedulerRunId", "scheduleId", "occurrenceId", "issueNumber"].some((key) =>
      Object.hasOwn(released, key),
    );
  const keys = ["attemptId", "publicationOperationId"];
  if (released && Object.hasOwn(released, "archiveSha256")) keys.push("archiveSha256");
  if (released && Object.hasOwn(released, "baseRevisionId")) keys.push("baseRevisionId");
  if (released && Object.hasOwn(released, "delivery")) keys.push("delivery");
  if (associated) keys.push("schedulerRunId", "scheduleId", "occurrenceId", "issueNumber");
  return { keys, associated };
}

function assertReleasedClaim(journal, state) {
  const released = state.lastReleased;
  const { keys, associated } = releasedIdentityKeys(released);
  if (
    !released ||
    typeof released !== "object" ||
    Array.isArray(released) ||
    !isDeepStrictEqual(Object.keys(released).sort(), keys.sort()) ||
    typeof released.attemptId !== "string" ||
    !scheduleRunPattern.test(released.attemptId) ||
    typeof released.publicationOperationId !== "string" ||
    !scheduleRunPattern.test(released.publicationOperationId) ||
    (released.baseRevisionId !== undefined &&
      !matches(scheduleRunPattern, released.baseRevisionId)) ||
    (associated && invalidReleasedSchedule(released))
  )
    throw new Error("Invalid Factory released execution receipt");
  if (released.delivery !== undefined) assertReleasedDelivery(journal, state, released);
  if (released.archiveSha256 !== undefined) assertReleasedArchive(journal, state, released);
}

function assertCustodyRecord(journal, entry) {
  if (
    !entry ||
    !custodyIdentityValid(entry.identity) ||
    typeof entry.directory !== "string" ||
    !entry.directory.startsWith(journal.custodyRoot + "/execution-") ||
    entry.directory.slice(journal.custodyRoot.length + 1).includes("/")
  )
    throw new Error("Invalid Factory custody record");
}

function assertClaimExecutionBindings(journal, attempt) {
  for (const execution of attempt.executions) {
    assertCustodyRecord(journal, execution);
    if (!bindingValid(execution.binding) || !isAbsolute(execution.binding.workspace))
      throw new Error("Factory execution recovery binding is missing or invalid");
  }
  if (attempt.helpers !== undefined && !Array.isArray(attempt.helpers))
    throw new Error("Invalid Factory helper execution records");
  for (const helper of attempt.helpers ?? []) {
    assertCustodyRecord(journal, helper);
    if (!helperBindingValid(helper.binding) || !isAbsolute(helper.binding.workspace))
      throw new Error("Invalid Factory helper recovery binding");
  }
}

function assertActiveClaim(journal, attempt) {
  if (
    typeof attempt.attemptId !== "string" ||
    !Array.isArray(attempt.executions) ||
    !Number.isSafeInteger(attempt.controllerEpoch) ||
    attempt.controllerEpoch < 1 ||
    attempt.approval?.action !== "approve" ||
    !Number.isSafeInteger(attempt.approvalCommentId) ||
    typeof attempt.scheduleId !== "string" ||
    typeof attempt.occurrenceId !== "string"
  )
    throw new Error("Invalid active Factory claim");
  approvalComment(attempt.approval);
  if (attempt.qualification !== undefined) {
    qualificationAuditBody(attempt.qualification);
    if (
      attempt.qualification.commentId !== attempt.approvalCommentId ||
      attempt.qualification.receipt.snapshot.issue.number !== attempt.approval.issueNumber ||
      attempt.qualification.receipt.snapshot.repository !== attempt.approval.repository
    )
      throw new Error("Factory qualification binding changed");
  }
  assertFactoryBaseRevision(attempt);
  if (attempt.workflow !== undefined) assertFactoryWorkflow(attempt.workflow);
  if (
    attempt.schedulerRunId !== undefined &&
    (typeof attempt.schedulerRunId !== "string" || !scheduleRunPattern.test(attempt.schedulerRunId))
  )
    throw new Error("Invalid Factory scheduler run identity");
  assertClaimExecutionBindings(journal, attempt);
}

function validateClaimState(journal, state) {
  if (
    state.schemaVersion !== 1 ||
    state.installationId !== journal.authority.identity.installationId ||
    !Number.isSafeInteger(state.revision) ||
    state.revision < 0 ||
    !isDeepStrictEqual(
      Object.keys(state)
        .filter((key) => key !== "lastRetired")
        .sort(),
      ["active", "installationId", "lastReleased", "revision", "schemaVersion"],
    )
  )
    throw new Error("Invalid Factory claim history");
  if (Object.hasOwn(state, "lastRetired")) assertFactoryRetirement(state.lastRetired);
  if (state.lastReleased !== null) assertReleasedClaim(journal, state);
  if (state.active !== null) assertActiveClaim(journal, state.active);
}

function assertRecoveryWorkspace(journal, binding, helper) {
  if (
    !(helper ? helperBindingValid(binding) : bindingValid(binding)) ||
    !isAbsolute(binding.workspace) ||
    contains(binding.workspace, journal.authority.root) ||
    contains(journal.authority.root, binding.workspace)
  )
    throw new Error("Invalid Factory execution recovery binding");
  const workspace = lstatSync(binding.workspace);
  if (
    !workspace.isDirectory() ||
    workspace.uid !== process.getuid() ||
    workspace.mode & 0o022 ||
    realpathSync(binding.workspace) !== binding.workspace
  )
    throw new Error("Factory workspace is not a prepared physical directory");
}

function assertWorkflowBinding(attempt, binding, helper) {
  const preparation = helper && binding.kind === "preparation";
  if (
    preparation &&
    (binding.operationId !== factoryPreparationOperationId(attempt) ||
      !attempt.schedulerRunId ||
      attempt.workflow !== undefined ||
      (attempt.executions.length !== 0 && !hasOnlyPriorRevisionExecutions(attempt)))
  )
    throw new Error("Factory preparation requires a bound run before workflow dispatch");
  if (
    helper &&
    !preparation &&
    (attempt.workflow?.operation?.id !== binding.operationId ||
      attempt.workflow.operation.kind !== binding.kind)
  )
    throw new Error("Factory helper does not match the retained workflow operation");
  if (
    !helper &&
    binding.occurrenceId !== attempt.occurrenceId &&
    !binding.occurrenceId.startsWith(attempt.occurrenceId + ":")
  )
    throw new Error("Factory quota occurrence differs from its claimed schedule occurrence");
}

function assertRetirementArchive(archive, state, receipt) {
  const attempt = archive.active;
  if (
    createHash("sha256").update(JSON.stringify(archive)).digest("hex") !== receipt.archiveSha256 ||
    archive.installationId !== state.installationId ||
    attempt?.attemptId !== receipt.attemptId ||
    attempt.schedulerRunId !== receipt.schedulerRunId ||
    attempt.scheduleId !== receipt.scheduleId ||
    attempt.occurrenceId !== receipt.occurrenceId ||
    attempt.approval.repository !== receipt.repository ||
    attempt.approval.issueNumber !== receipt.issueNumber
  )
    throw new Error("Factory retirement archive differs");
  if (
    receipt.reason === "blocked" &&
    (attempt.workflow?.phase !== "blocked" ||
      attempt.workflow.operation ||
      attempt.workflow.draft?.mergeReceipt ||
      createHash("sha256")
        .update(attempt.workflow.blocker ?? "")
        .digest("hex") !== receipt.completion.blockerSha256)
  )
    throw new Error("Factory parking archive differs from the held workflow");
}

/** Local execution authority only. Issue descriptions, priorities and workflow
 * progress remain in GitHub. Initialization is an explicit installation action
 * after reconciling historical claims, never an automatic startup fallback.
 */
export class FactoryClaimJournal {
  constructor(authority, readSettlement) {
    this.authority = authority;
    this.readSettlement = readSettlement;
    this.path = join(authority.root, "claim.json");
    this.custodyRoot = join(authority.root, "custody");
  }

  initialize() {
    this.authority.assertCurrent();
    directory(this.custodyRoot);
    if (readdirSync(this.custodyRoot).length)
      throw new Error("Existing custody requires reconciliation");
    try {
      lstatSync(this.path);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      durableWrite(this.authority.root, "claim.json", {
        schemaVersion: 1,
        installationId: this.authority.identity.installationId,
        revision: 0,
        active: null,
        lastReleased: null,
      });
      return;
    }
    throw new Error("Factory claims are already initialized");
  }

  current() {
    this.authority.assertCurrent();
    const state = read(this.path);
    validateClaimState(this, state);
    return state;
  }

  assertUnchanged(state, message = "Factory claim changed during operation") {
    this.authority.assertCurrent();
    if (!isDeepStrictEqual(this.current(), state)) throw new Error(message);
  }

  replace(
    previous,
    active,
    lastReleased = previous.lastReleased,
    lastRetired = previous.lastRetired,
  ) {
    this.assertUnchanged(previous);
    const next = structuredClone({
      ...previous,
      revision: previous.revision + 1,
      active,
      lastReleased,
      ...(lastRetired ? { lastRetired } : {}),
    });
    validateClaimState(this, next);
    this.authority.assertCurrent();
    durableWrite(this.authority.root, "claim.json", next);
  }

  async claim(input) {
    const captured = structuredClone(input);
    const { approval, approvalCommentId, scheduleId, occurrenceId, qualification } = captured;
    assertOwnedInput(this.authority, input, captured);
    approvalComment(approval);
    if (qualification !== undefined) {
      qualificationAuditBody(qualification);
      if (
        qualification.commentId !== approvalCommentId ||
        qualification.receipt.snapshot.issue.number !== approval.issueNumber ||
        qualification.receipt.snapshot.repository !== approval.repository
      )
        throw new Error("Factory qualification binding changed");
    }
    if (
      approval.action !== "approve" ||
      !Number.isSafeInteger(approvalCommentId) ||
      approvalCommentId < 1 ||
      typeof scheduleId !== "string" ||
      !scheduleId ||
      typeof occurrenceId !== "string" ||
      !occurrenceId
    )
      throw new Error("Invalid Factory claim binding");
    await this.reconcile();
    assertOwnedInput(this.authority, input, captured);
    const state = this.current();
    if (state.active) throw new Error("Factory already owns an unfinished attempt");
    const attempt = {
      attemptId: randomUUID(),
      controllerEpoch: this.authority.identity.epoch,
      approval: structuredClone(approval),
      approvalCommentId,
      ...(qualification ? { qualification: structuredClone(qualification) } : {}),
      scheduleId,
      occurrenceId,
      statusOperationId: randomUUID(),
      publicationOperationId: randomUUID(),
      executions: [],
    };
    this.replace(state, attempt);
    return structuredClone(attempt);
  }

  async claimSelected(input) {
    const { api, readIssue, ...data } = input;
    const captured = structuredClone(data);
    const { scheduleId, occurrenceId, ...selection } = captured;
    const assertInvocation = () => {
      if (input.api !== api || input.readIssue !== readIssue)
        throw new Error("Factory assignment callback changed during admission");
      assertOwnedInput(
        this.authority,
        { ...input, api, readIssue },
        { ...captured, api, readIssue },
      );
    };
    assertInvocation();
    await this.reconcile();
    assertInvocation();
    if (this.current().active) throw new Error("Factory already owns an unfinished attempt");
    const current = await recheckFactoryAssignment({ ...selection, api, readIssue });
    assertInvocation();
    return this.claim({
      approval: current.approval,
      approvalCommentId: current.approvalCommentId,
      scheduleId,
      occurrenceId,
    });
  }

  async claimQualified(input) {
    const { verifyQualification, ...data } = input;
    const captured = structuredClone(data);
    const { qualification, scheduleId, occurrenceId } = captured;
    const assertInvocation = () => {
      if (input.verifyQualification !== verifyQualification)
        throw new Error("Factory qualification callback changed during admission");
      assertOwnedInput(
        this.authority,
        { ...input, verifyQualification },
        { ...captured, verifyQualification },
      );
    };
    assertInvocation();
    await this.reconcile();
    assertInvocation();
    if (this.current().active) throw new Error("Factory already owns an unfinished attempt");
    const current = await verifyQualification(structuredClone(qualification));
    assertInvocation();
    if (!isDeepStrictEqual(current.qualification, qualification))
      throw new Error("Factory qualification changed during admission");
    return this.claim({
      approval: current.approval,
      approvalCommentId: current.approvalCommentId,
      qualification,
      scheduleId,
      occurrenceId,
    });
  }

  /** Persist the scheduler association before any stage execution. A restart
   * may reuse this run, but cannot adopt an unrelated running schedule entry.
   */
  bindScheduleRun(attemptId, runId) {
    if (typeof runId !== "string" || !scheduleRunPattern.test(runId))
      throw new Error("Invalid Factory scheduler run identity");
    const state = this.current();
    const attempt = state.active;
    if (attempt?.attemptId !== attemptId)
      throw new Error("Factory scheduler attempt identity mismatch");
    if (attempt.schedulerRunId !== undefined) {
      if (attempt.schedulerRunId !== runId)
        throw new Error("Factory scheduler run requires reconciliation");
      return attempt;
    }
    if (attempt.executions.length || attempt.helpers?.length)
      throw new Error("Existing Factory execution has no scheduler association");
    const bound = { ...attempt, schedulerRunId: runId };
    this.replace(state, bound);
    return structuredClone(bound);
  }

  updateWorkflow(attemptId, previous, workflow) {
    assertFactoryWorkflow(workflow);
    const state = this.current();
    if (
      state.active?.attemptId !== attemptId ||
      !isDeepStrictEqual(state.active.workflow ?? null, previous)
    )
      throw new Error("Factory workflow checkpoint changed during operation");
    this.replace(state, {
      ...state.active,
      workflow: structuredClone(workflow),
    });
  }

  async bindExecution(attemptId, custody, binding) {
    return this.#bindCustody(attemptId, custody, binding, "executions");
  }

  /** Trusted helpers have native custody, but do not reserve model quota. */
  async bindHelperExecution(attemptId, custody, binding) {
    return this.#bindCustody(attemptId, custody, binding, "helpers");
  }

  /** Preparation belongs to the claimed scheduler run before workflow dispatch.
   * Reuse the helper receipt inventory, without adding an inference reservation.
   */
  async bindPreparationExecution(attemptId, custody, workspace) {
    const attempt = this.current().active;
    if (attempt?.attemptId !== attemptId) throw new Error("Factory preparation attempt changed");
    return this.bindHelperExecution(attemptId, custody, {
      operationId: factoryPreparationOperationId(attempt),
      kind: "preparation",
      workspace,
    });
  }

  async #bindCustody(attemptId, custodyInput, bindingInput, collection) {
    const custody = {
      directory: custodyInput.directory,
      identity: structuredClone(custodyInput.identity),
    };
    const binding = structuredClone(bindingInput);
    const assertInvocation = () => {
      assertOwnedInput(
        this.authority,
        { directory: custodyInput.directory, identity: custodyInput.identity },
        custody,
      );
      assertOwnedInput(this.authority, bindingInput, binding);
    };
    assertInvocation();
    const helper = collection === "helpers";
    assertRecoveryWorkspace(this, binding, helper);
    const state = this.current();
    if (state.active?.attemptId !== attemptId) throw new Error("Factory attempt identity mismatch");
    assertWorkflowBinding(state.active, binding, helper);
    if (
      custody.identity.attemptId !== attemptId ||
      custody.identity.ownershipGeneration !== this.authority.identity.epoch ||
      !custody.directory.startsWith(this.custodyRoot + "/execution-") ||
      custody.directory.slice(this.custodyRoot.length + 1).includes("/")
    )
      throw new Error("Factory custody binding mismatch");
    directory(custody.directory);
    if (!isDeepStrictEqual(read(join(custody.directory, "intent.json")), custody.identity))
      throw new Error("Factory custody intent mismatch");
    const all = [...state.active.executions, ...(state.active.helpers ?? [])];
    const existing = all.find((item) => item.identity.executionId === custody.identity.executionId);
    const entry = {
      directory: custody.directory,
      identity: structuredClone(custody.identity),
      binding: structuredClone(binding),
    };
    if (existing) {
      if (!isDeepStrictEqual(existing, entry))
        throw new Error("Factory execution identity was reused");
      return;
    }
    for (const previous of all) {
      await this.readSettlement(previous.directory, structuredClone(previous.identity));
      assertInvocation();
    }
    assertInvocation();
    this.replace(state, {
      ...state.active,
      [collection]: [...(state.active[collection] ?? []), entry],
    });
  }

  async reconcile() {
    const state = this.current();
    directory(this.custodyRoot);
    // An intent created before journal binding still blocks a new assignment.
    // Completed receipts remain here until explicit installation maintenance.
    const known = new Map(
      [...(state.active?.executions ?? []), ...(state.active?.helpers ?? [])].map((item) => [
        item.directory,
        item.identity,
      ]),
    );
    for (const name of readdirSync(this.custodyRoot)) {
      if (!name.startsWith("execution-")) throw new Error("Unknown Factory custody state");
      const path = join(this.custodyRoot, name);
      directory(path);
      const identity = read(join(path, "intent.json"));
      if (known.has(path) && !isDeepStrictEqual(known.get(path), identity))
        throw new Error("Retained Factory custody identity changed");
      await this.readSettlement(path, structuredClone(identity));
      this.authority.assertCurrent();
      known.delete(path);
    }
    if (known.size) throw new Error("Retained Factory custody directory is missing");
    this.authority.assertCurrent();
    if (!isDeepStrictEqual(this.current(), state))
      throw new Error("Factory claim changed during reconciliation");
    return state.active ? "resume_required" : "clear";
  }

  async release(attemptId, verifyDelivery) {
    const state = this.current();
    if (state.active?.attemptId !== attemptId) throw new Error("Factory attempt identity mismatch");
    if (!state.active.executions.length)
      throw new Error("Factory delivery has no execution evidence");
    await this.reconcile();
    // The trusted publication path verifies GitHub draft identity, exact-head
    // independent review and recorded progress before releasing local authority.
    if ((await verifyDelivery(structuredClone(state.active))) !== true)
      throw new Error("Factory delivery evidence is unconfirmed");
    if (
      state.active.workflow?.phase === "release" &&
      state.active.workflow.draft.url !==
        `https://github.com/${state.active.approval.repository}/pull/${state.active.workflow.draft.number}`
    )
      throw new Error("Factory released draft URL differs from its repository");
    this.assertUnchanged(state);
    const archiveSha256 = createHash("sha256").update(JSON.stringify(state)).digest("hex");
    durableWrite(this.authority.root, `delivered-${archiveSha256}.json`, state, true);
    this.replace(state, null, {
      attemptId,
      archiveSha256,
      publicationOperationId: state.active.publicationOperationId,
      // Preserve the exact delivered candidate and scheduler occurrence for
      // crash recovery before the native scheduler records completion.
      ...releasedMetadata(state.active),
    });
  }

  /** Requires settled native custody AND finalized account reservations. The
   * entire prior claim is sealed before releasing authority. Retrying after a
   * crash verifies the same archive; it never invents a delivery or deletes
   * execution evidence. External retirement uses the drained controller owner;
   * parking uses its terminal blocked workflow, after all execution settles.
   */
  async retireCompletedElsewhere(attemptId, completion, verifyCompletion, verifyAccount) {
    return this.retire(
      attemptId,
      "completed_elsewhere",
      completion,
      verifyCompletion,
      verifyAccount,
    );
  }

  async parkBlocked(attemptId, audit, verifyParking, verifyAccount) {
    return this.retire(attemptId, "blocked", audit, verifyParking, verifyAccount);
  }

  async retire(attemptId, reason, completion, verifyCompletion, verifyAccount) {
    const state = this.current();
    if (!state.active && state.lastRetired?.attemptId === attemptId) {
      if (
        state.lastRetired.reason !== reason ||
        !isDeepStrictEqual(state.lastRetired.completion, completion)
      )
        throw new Error("Factory retirement identity was reused");
      await this.verifyRetirement(state.lastRetired, verifyCompletion, verifyAccount);
      return state.lastRetired;
    }
    if (state.active?.attemptId !== attemptId || !state.active.schedulerRunId)
      throw new Error("Factory retirement needs the exact retained scheduler claim");
    if (
      reason === "blocked" &&
      (state.active.workflow?.phase !== "blocked" ||
        state.active.workflow.operation ||
        state.active.workflow.draft?.mergeReceipt ||
        createHash("sha256")
          .update(state.active.workflow.blocker ?? "")
          .digest("hex") !== completion.blockerSha256)
    )
      throw new Error(
        "Factory parking requires a terminal blocked workflow without pending effects",
      );
    const archiveSha256 = createHash("sha256").update(JSON.stringify(state)).digest("hex");
    const receipt = {
      reason,
      attemptId,
      archiveSha256,
      schedulerRunId: state.active.schedulerRunId,
      scheduleId: state.active.scheduleId,
      occurrenceId: state.active.occurrenceId,
      repository: state.active.approval.repository,
      issueNumber: state.active.approval.issueNumber,
      completion: structuredClone(completion),
    };
    assertFactoryRetirement(receipt);
    await this.reconcile();
    if ((await verifyAccount(structuredClone(state.active))) !== true)
      throw new Error("Factory retirement account reservations are unsettled");
    if ((await verifyCompletion(structuredClone(receipt))) !== true)
      throw new Error("Factory external completion is unconfirmed");
    this.authority.assertCurrent();
    if (!isDeepStrictEqual(this.current(), state))
      throw new Error("Factory claim changed during retirement");
    durableWrite(this.authority.root, `retired-${archiveSha256}.json`, state, true);
    this.replace(state, null, state.lastReleased, receipt);
    return structuredClone(receipt);
  }

  async verifyRetirement(input, verifyCompletion, verifyAccount) {
    const receipt = structuredClone(input);
    assertFactoryRetirement(receipt);
    assertOwnedInput(this.authority, input, receipt);
    const state = this.current();
    if (state.active || !isDeepStrictEqual(state.lastRetired, receipt))
      throw new Error("Factory retirement receipt changed");
    const archive = read(join(this.authority.root, `retired-${receipt.archiveSha256}.json`));
    const attempt = archive.active;
    assertRetirementArchive(archive, state, receipt);
    await this.reconcile();
    for (const execution of [...attempt.executions, ...(attempt.helpers ?? [])]) {
      if (
        !contains(this.custodyRoot, execution.directory) ||
        execution.directory === this.custodyRoot
      )
        throw new Error("Factory retired custody path differs");
      directory(execution.directory);
      if (!isDeepStrictEqual(read(join(execution.directory, "intent.json")), execution.identity))
        throw new Error("Factory retired custody identity differs");
      await this.readSettlement(execution.directory, structuredClone(execution.identity));
      assertOwnedInput(this.authority, input, receipt);
    }
    if (
      (await verifyAccount(structuredClone(attempt))) !== true ||
      (await verifyCompletion(structuredClone(receipt))) !== true
    )
      throw new Error("Factory retirement evidence is unconfirmed");
    assertOwnedInput(this.authority, input, receipt);
    this.authority.assertCurrent();
    if (!isDeepStrictEqual(this.current(), state))
      throw new Error("Factory retirement changed during verification");
    return true;
  }
}
