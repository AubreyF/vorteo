import { isDeepStrictEqual } from "node:util";
import { QuotaAccountSchema } from "@getpaseo/protocol/quota-governor";

/** Call once before this installation starts quota sampling or dispatch. */
async function recoverAccount({ authority, claims, store, account, intake, releases, providerId }) {
  return store.recoverAbandonedAccountLock({
    account,
    assertExclusiveWriter: () => authority.assertCurrent(),
    reconcileCustody: async ({ ledger }) => {
      await claims.reconcile();
      await intake?.reconcile();
      const releaseOwners = releases ? await releases.reconcileCustody() : [];
      if (!Array.isArray(releaseOwners)) throw new Error("Factory release recovery is incomplete");
      const issue = claims.current().active;
      const intakeJob = intake?.current().active;
      if (issue && intakeJob) throw new Error("Factory account has overlapping execution owners");
      let attempt = issue ?? intakeJob;
      if (isEmptyOrReleasedLedger(ledger, attempt, releaseOwners)) return { reconciled: true };
      // Released, completed history can use an older provider alias for this
      // same account. The native store checked account identity and the custody
      // scan above checked retained executions. Never rewrite that history or
      // extend this exception to an outstanding reservation.
      if (providerId && ledger.providerId !== providerId)
        throw new Error("Factory quota ledger provider changed");
      const matching = releaseOwners.filter((owner) =>
        matchesReleaseLedger(owner, ledger, account),
      );
      if (matching.length > 1) throw new Error("Factory release quota ownership is ambiguous");
      if (matching.length) {
        if (matchesAttemptLedger(attempt, ledger))
          throw new Error("Factory quota ledger matches multiple execution owners");
        attempt = matching[0];
      }
      if (!matchesAttemptLedger(attempt, ledger))
        throw new Error("Factory quota ledger has no matching active claim");
      if (ledger.execution.state === "reserved") {
        if (ledger.execution.executionId !== null)
          throw new Error("Factory reserved execution identity is ambiguous");
        return { reconciled: true };
      }
      const entry = attempt.executions.find(
        (item) => item.identity.executionId === ledger.execution.executionId,
      );
      assertLedgerExecution(entry, ledger, account);
      return { reconciled: true };
    },
  });
}

function isEmptyOrReleasedLedger(ledger, attempt, releaseOwners) {
  if (ledger === null) {
    if (attempt?.executions.length || releaseOwners.some((owner) => owner.executions.length))
      throw new Error("Factory execution has no retained quota ledger");
    return true;
  }
  // A released ledger can belong to the previous completed issue. Its native
  // records were still checked by the complete custody scan before this call.
  if (ledger.released) {
    if (ledger.execution.state !== "completed")
      throw new Error("Factory released quota ledger is not completed");
    return true;
  }
  return false;
}

function matchesAttemptLedger(attempt, ledger) {
  return (
    attempt !== null &&
    attempt !== undefined &&
    attempt.scheduleId === ledger.scheduleId &&
    (attempt.occurrenceId === ledger.occurrenceId ||
      ledger.occurrenceId.startsWith(attempt.occurrenceId + ":"))
  );
}

function matchesReleaseLedger(owner, ledger, account) {
  return (
    owner.scheduleId === ledger.scheduleId &&
    owner.occurrenceId === ledger.occurrenceId &&
    owner.reservationId === ledger.reservationId &&
    owner.providerId === ledger.providerId &&
    isDeepStrictEqual(owner.account, account)
  );
}
function assertLedgerExecution(entry, ledger, account) {
  if (
    !entry ||
    !isDeepStrictEqual(entry.binding.account, account) ||
    entry.binding.reservationId !== ledger.reservationId ||
    entry.binding.providerId !== ledger.providerId ||
    entry.binding.occurrenceId !== ledger.occurrenceId ||
    entry.identity.authenticationGeneration !== ledger.execution.authenticationGeneration
  )
    throw new Error("Factory quota ledger has no matching native execution");
}

/** Run after startup has recovered the account's directory lock. This reconciles
 * execution capacity only. It neither declares the issue complete nor releases
 * its claim, and it never resumes a provider conversation.
 */
async function reconcileAttempt({
  authority,
  claims,
  store,
  readObservation,
  authenticationGeneration,
}) {
  return reconcileExecutionOwner({
    authority,
    records: claims,
    store,
    readObservation,
    authenticationGeneration,
  });
}

/** Intake and issue records share execution accounting, not admission authority.
 * Each caller supplies its own protected record and custody reconciliation.
 */
async function reconcileExecutionOwner({
  authority,
  records: claims,
  store,
  readObservation,
  authenticationGeneration,
}) {
  authority.assertCurrent();
  await claims.reconcile();
  const before = claims.current();
  if (!before.active) return { kind: "clear" };
  const assertUnchanged = () => {
    authority.assertCurrent();
    if (!isDeepStrictEqual(claims.current(), before))
      throw new Error("Factory claim changed during quota recovery");
  };
  const reservations = new Map();
  for (const entry of before.active.executions) {
    const key = JSON.stringify([entry.binding.account, entry.binding.reservationId]);
    // The last execution in a reservation supersedes earlier settled executions.
    reservations.set(key, entry);
  }
  const recovered = [];
  for (const entry of reservations.values()) {
    assertUnchanged();
    const { account, reservationId, providerId } = entry.binding;
    const saved = await store.reservationState(account, reservationId);
    assertUnchanged();
    if (saved.kind === "finalized") {
      recovered.push({ ...entry, kind: "finalized" });
      continue;
    }
    if (
      saved.providerId !== providerId ||
      saved.scheduleId !== before.active.scheduleId ||
      saved.occurrenceId !== entry.binding.occurrenceId
    )
      throw new Error("Factory quota reservation binding changed");
    let execution = saved.execution;
    if (
      execution.executionId !== entry.identity.executionId ||
      execution.authenticationGeneration !== entry.identity.authenticationGeneration
    )
      throw new Error("Factory quota execution identity changed");
    const transition = async (event) => {
      assertUnchanged();
      const result = await store.transition({
        account,
        reservationId,
        expectedGeneration: execution.generation,
        event,
      });
      assertUnchanged();
      if (result.kind !== "transitioned")
        throw new Error(`Factory recovery held: ${result.reason}`);
      execution = result.execution;
    };
    // Native receipts prove termination, not successful work. Interrupted work
    // becomes frozen and remains attached to the same issue and reservation.
    if (["starting", "running"].includes(execution.state))
      await transition({ type: "freeze", reason: "quota" });
    if (execution.state === "freezing")
      await transition({
        type: "settled",
        executionId: entry.identity.executionId,
        settlementId: entry.identity.nonce,
      });
    if (execution.settlementId !== entry.identity.nonce)
      throw new Error("Factory quota settlement identity changed");
    if (execution.state === "completed") {
      const observation = await readObservation(providerId);
      assertUnchanged();
      const result = await store.finalize({
        account,
        reservationId,
        observation,
      });
      assertUnchanged();
      if (result.kind !== "finalized")
        throw new Error(`Factory completion accounting held: ${result.reason}`);
      recovered.push({ ...entry, kind: "finalized" });
      continue;
    }
    if (execution.state !== "frozen") throw new Error("Factory execution requires reconciliation");
    const generation = await authenticationGeneration(providerId);
    assertUnchanged();
    if (generation !== execution.authenticationGeneration)
      throw new Error("Factory authentication changed during recovery");
    recovered.push({
      ...entry,
      kind: execution.pauseReason === "manual" ? "manual_resume_required" : "resumable",
    });
  }
  assertUnchanged();
  return {
    kind: "resume_required",
    attempt: before.active,
    executions: recovered,
  };
}

export class FactoryRecoveryUncertainError extends Error {
  constructor(operation, cause) {
    super(
      `Factory recovery ${operation} may have persisted; reconcile the retained native state before retrying`,
      { cause },
    );
    this.name = "FactoryRecoveryUncertainError";
    this.operation = operation;
    this.writeAttempted = true;
  }
}

/** Capture one invocation. This is not an owner grant or an all-writer fence. */
function captureRecovery(input, accountRecovery) {
  const captured = { ...input };
  const originalAccount = accountRecovery ? structuredClone(input.account) : undefined;
  const methods = [];
  let uncertain;
  const owner = captured.authority;
  const ownerCurrent = owner.assertCurrent;
  function assertCaptured() {
    if (
      Object.keys(input).length !== Object.keys(captured).length ||
      Object.entries(captured).some(([key, value]) => input[key] !== value) ||
      owner.assertCurrent !== ownerCurrent ||
      methods.some(([source, name, method]) => source[name] !== method) ||
      (accountRecovery && !isDeepStrictEqual(input.account, originalAccount))
    )
      throw new Error("Factory recovery invocation changed");
  }
  function assertCurrent() {
    if (uncertain) throw uncertain;
    assertCaptured();
    ownerCurrent.call(owner);
    assertCaptured();
  }
  function port(source, names, writes = []) {
    const result = {};
    for (const name of names) {
      const method = source[name];
      if (typeof method !== "function") throw new Error(`Factory recovery requires native ${name}`);
      methods.push([source, name, method]);
      result[name] = (...args) => {
        assertCurrent();
        const fail = (error) => {
          if (!writes.includes(name)) throw error;
          uncertain ??= new FactoryRecoveryUncertainError(name, error);
          throw uncertain;
        };
        const finish = (value) => {
          assertCurrent();
          return structuredClone(value);
        };
        try {
          const value = method.apply(source, args);
          if (value && typeof value.then === "function") return value.then(finish).catch(fail);
          return finish(value);
        } catch (error) {
          return fail(error);
        }
      };
    }
    return result;
  }
  const result = { ...captured, authority: { assertCurrent } };
  if (accountRecovery) {
    result.account = QuotaAccountSchema.parse(originalAccount);
    if (
      captured.providerId !== undefined &&
      (typeof captured.providerId !== "string" || !captured.providerId)
    )
      throw new Error("Factory recovery provider identity is invalid");
    result.claims = port(captured.claims, ["current", "reconcile"]);
    if (captured.intake) result.intake = port(captured.intake, ["current", "reconcile"]);
    if (captured.releases) result.releases = port(captured.releases, ["reconcileCustody"]);
    result.store = port(
      captured.store,
      ["recoverAbandonedAccountLock"],
      ["recoverAbandonedAccountLock"],
    );
  } else {
    const records = captured.records ?? captured.claims;
    result.records = port(records, ["current", "reconcile"]);
    result.claims = result.records;
    result.store = port(
      captured.store,
      ["reservationState", "transition", "finalize"],
      ["transition", "finalize"],
    );
    result.readObservation = port(captured, ["readObservation"]).readObservation;
    result.authenticationGeneration = port(captured, [
      "authenticationGeneration",
    ]).authenticationGeneration;
  }
  assertCurrent();
  return result;
}

/** Startup only, under the existing exclusive owner and complete custody scan. */
export async function recoverFactoryAccount(input) {
  return recoverAccount(captureRecovery(input, true));
}
export async function reconcileFactoryAttempt(input) {
  return reconcileAttempt(captureRecovery(input, false));
}
/** Accounting reconciliation never grants admission, releases a claim or resumes a worker. */
export async function reconcileFactoryExecutionOwner(input) {
  return reconcileExecutionOwner(captureRecovery(input, false));
}
