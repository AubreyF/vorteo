import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rm, rmdir } from "node:fs/promises";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { observeHourlyEstimate, HourlyEstimateStateSchema } from "./governor-estimate.js";
import { z } from "zod";
import {
  QuotaAccountSchema,
  QuotaGovernorPolicySchema,
  QuotaObservationSchema,
  type QuotaAccount,
  type QuotaGovernorPolicy,
  type QuotaObservation,
} from "@getpaseo/protocol/quota-governor";
import { assertQuotaPolicyAccount, combineQuotaPolicies } from "./governor-policy.js";
import { evaluateQuotaGovernor, type QuotaGovernorDecision } from "./governor-evaluate.js";
import {
  advanceGovernorExecution,
  GovernorExecutionSchema,
  type GovernorExecution,
  type GovernorExecutionEvent,
} from "./governor-lifecycle.js";
import {
  advanceQuotaPacing,
  reserveQuotaPacing,
  settleQuotaPacing,
  PacingStateSchema,
  type PacingAccounting,
  type PacingConfiguration,
  type PacingEnvelope,
  type PacingState,
} from "./governor-pacing.js";

import {
  AccountingContractSchema,
  createAccountingContract,
  legacyAccountingContract,
  satisfiesAccountingContract,
  type AccountingContract,
} from "./governor-accounting-contract.js";

const AccountingContractRequirementSchema = AccountingContractSchema.omit({
  semantics: true,
  envelope: true,
  estimatedWindow: true,
}).strict();

const PacingLedgerSchema = z
  .object({
    version: z.literal(1),
    account: QuotaAccountSchema,
    buckets: z.array(PacingStateSchema).min(1),
  })
  .strict();

interface PacingUpdateInput {
  account: QuotaAccount;
  maxObservationAgeMs: number;
  buckets: Array<{
    configuration: PacingConfiguration;
    accounting: PacingAccounting;
    envelopes: PacingEnvelope[];
    reserveUnits: number;
    /** Supplied only by the trusted accounting boundary after all slice charges appear. */
    settlements?: Array<{ reservationId: string; accountedAt: number }>;
  }>;
  reservationId: string;
}

const ReservationSchema = z
  .object({
    id: z.string().uuid(),
    scheduleId: z.string().min(1),
    occurrenceId: z.string().min(1),
    providerId: z.string().min(1),
    policy: QuotaGovernorPolicySchema,
    createdAt: z.string().datetime(),
  })
  .strict();
const LedgerSchema = z
  .object({
    version: z.literal(1),
    account: QuotaAccountSchema,
    windowContract: z.string(),
    // Absent only in legacy journals; null means explicitly unconfigured.
    accountingContractRevision: z.string().min(1).nullable().optional(),
    observation: QuotaObservationSchema,
    reservation: ReservationSchema,
    execution: GovernorExecutionSchema,
    lastFreezeAt: z.string().datetime().nullable(),
    completedAt: z.string().datetime().nullable(),
    executionBindings: z.array(
      z
        .object({
          executionId: z.string().min(1),
          authenticationGeneration: z.string().min(1),
          startedAt: z.string().datetime(),
          endedAt: z.string().datetime().nullable(),
        })
        .strict(),
    ),
    released: z.boolean(),
    completions: z.array(
      z
        .object({
          scheduleId: z.string().min(1),
          occurrenceId: z.string().min(1),
          reservationId: z.string().uuid(),
          finalizedAt: z.string().datetime(),
        })
        .strict(),
    ),
  })
  .strict();
type Ledger = z.infer<typeof LedgerSchema>;

export interface QuotaLockRecoveryContext {
  account: QuotaAccount;
  ledger: {
    reservationId: string;
    execution: GovernorExecution;
    executionBindings: Ledger["executionBindings"];
    released: boolean;
    providerId: string;
    policy: QuotaGovernorPolicy;
    observation: QuotaObservation;
    scheduleId: string;
    occurrenceId: string;
  } | null;
}

interface ReserveInput {
  policy: QuotaGovernorPolicy;
  observation: QuotaObservation;
  scheduleId: string;
  occurrenceId: string;
  providerId: string;
}
type ReserveResult =
  | { kind: "admitted"; reservation: z.infer<typeof ReservationSchema> }
  | { kind: "completed"; reservationId: string }
  | {
      kind: "deferred";
      reason:
        | "accounting_contract_missing"
        | "accounting_migration_required"
        | "account_busy"
        | "store_busy"
        | "window_contract_changed"
        | "execution_binding_changed"
        | "observation_regressed"
        | "charge_settlement_unavailable";
    }
  | { kind: "deferred"; reason: "quota"; decision: QuotaGovernorDecision };

/** Durable execution reservation, not a task queue or a spending estimate. */
export class QuotaGovernorStore {
  private readonly pending = new Map<string, Promise<unknown>>();
  private readonly directory: string;
  private readonly nowMs: () => number;

  constructor(directory: string, options: { nowMs?: () => number } = {}) {
    this.directory = resolve(directory);
    this.nowMs = options.nowMs ?? Date.now;
  }

  accountPath(account: QuotaAccount): string {
    const key = createHash("sha256")
      .update(JSON.stringify([account.issuer, account.accountId]))
      .digest("hex");
    return resolve(this.directory, `${key}.json`);
  }

  /** Startup only, before any writer is enabled. Every writer must participate
   * in the caller's exclusive lifetime ownership protocol. This removes only a
   * stale directory lock, never execution custody or accounting history.
   */
  async recoverAbandonedAccountLock(input: {
    account: QuotaAccount;
    assertExclusiveWriter(): void;
    reconcileCustody(context: QuotaLockRecoveryContext): Promise<{ reconciled: true }>;
  }): Promise<"absent" | "recovered"> {
    const account = QuotaAccountSchema.parse(input.account);
    const path = this.accountPath(account);
    return this.serializeAccount(path, async () => {
      input.assertExclusiveWriter();
      const directory = await inspectRecoveryDirectory(this.directory);
      const lock = `${path}.lock`;
      const inspectLock = async () => {
        const info = await lstat(lock);
        if (
          !info.isDirectory() ||
          info.uid !== process.getuid?.() ||
          (info.mode & 0o777) !== 0o700 ||
          (await readdir(lock)).length !== 0
        )
          throw new Error("Quota recovery requires a protected empty lock directory.");
        return info;
      };
      let original;
      try {
        original = await inspectLock();
      } catch (error) {
        if (!hasCode(error, "ENOENT")) throw error;
      }
      const ledger = await readLedger(path);
      if (ledger && !isDeepStrictEqual(ledger.account, account))
        throw new Error("Quota recovery account identity mismatch.");
      await loadAccountingContract(path, account, ledger);
      const estimate = await readProtectedJson(`${path}.estimate`);
      if (
        estimate !== undefined &&
        !isDeepStrictEqual(HourlyEstimateStateSchema.parse(estimate).account, account)
      )
        throw new Error("Quota estimate account mismatch.");
      const pacing = await readProtectedJson(`${path}.pacing`);
      if (
        pacing !== undefined &&
        !isDeepStrictEqual(PacingLedgerSchema.parse(pacing).account, account)
      )
        throw new Error("Quota pacing account mismatch.");
      const result = await input.reconcileCustody(
        structuredClone({
          account,
          ledger: ledger
            ? {
                reservationId: ledger.reservation.id,
                execution: ledger.execution,
                executionBindings: ledger.executionBindings,
                released: ledger.released,
                providerId: ledger.reservation.providerId,
                policy: ledger.reservation.policy,
                observation: ledger.observation,
                scheduleId: ledger.reservation.scheduleId,
                occurrenceId: ledger.reservation.occurrenceId,
              }
            : null,
        }),
      );
      if (result?.reconciled !== true)
        throw new Error("Quota custody reconciliation is unconfirmed.");
      input.assertExclusiveWriter();
      const currentDirectory = await inspectRecoveryDirectory(this.directory);
      if (currentDirectory.dev !== directory.dev || currentDirectory.ino !== directory.ino)
        throw new Error("Quota recovery directory changed.");
      if (!original) {
        try {
          await lstat(lock);
        } catch (error) {
          if (hasCode(error, "ENOENT")) return "absent";
          throw error;
        }
        throw new Error("Quota recovery lock appeared during reconciliation.");
      }
      const current = await inspectLock();
      if (current.dev !== original.dev || current.ino !== original.ino)
        throw new Error("Quota recovery lock changed.");
      input.assertExclusiveWriter();
      await rmdir(lock);
      const parent = await open(
        this.directory,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
      return "recovered";
    });
  }

  /** Called by trusted observation/dispatch code, never with a worker-supplied generation. */
  async observeEstimatedUsage(input: {
    observation: QuotaObservation;
    authenticationGeneration: string;
    bucketId: string;
    windowId: string;
    maxObservationAgeSeconds: number;
  }): Promise<QuotaObservation> {
    if (input.observation.status !== "available") return input.observation;
    const path = this.accountPath(input.observation.account);
    const result = await this.withAccountLock(path, async () => {
      const saved = await readProtectedJson(`${path}.estimate`);
      const state = saved === undefined ? null : HourlyEstimateStateSchema.parse(saved);
      const updated = observeHourlyEstimate({ ...input, state, nowMs: this.nowMs() });
      await writeProtectedJson(`${path}.estimate`, updated.state);
      return updated.observation;
    });
    return "kind" in result ? { status: "unavailable", reason: "read_failed" } : result;
  }

  /** Account-wide budget reservation, not an execution permit. Completion never resets it. */
  async updatePacing(
    input: PacingUpdateInput,
  ): Promise<
    | { kind: "reserved" | "held" | "settled"; buckets: PacingState[] }
    | { kind: "deferred"; reason: "store_busy" }
  > {
    const accountPath = this.accountPath(input.account);
    return this.withAccountLock(accountPath, async () => {
      const path = `${accountPath}.pacing`;
      const saved = await readProtectedJson(path);
      const ledger = saved === undefined ? null : PacingLedgerSchema.parse(saved);
      // The account lock and journal read may wait. Never use a timestamp
      // captured by the scheduler before entering this transaction.
      const nowMs = this.nowMs();
      if (ledger && !isDeepStrictEqual(ledger.account, input.account)) {
        throw new Error("Pacing ledger account identity mismatch.");
      }
      if (!input.buckets.length) throw new Error("Pacing requires at least one meter.");
      const identities = input.buckets.map((bucket) => pacingKey(bucket.accounting));
      if (new Set(identities).size !== identities.length)
        throw new Error("Duplicate pacing meter.");
      if (
        ledger &&
        !isDeepStrictEqual(
          ledger.buckets.map((bucket) => pacingKey(bucket.accounting)).sort(),
          [...identities].sort(),
        )
      ) {
        throw new Error("Pacing meter set requires reconciliation.");
      }
      const buckets = input.buckets.map((bucket) => {
        const { identity } = bucket.accounting;
        if (
          identity.issuer !== input.account.issuer ||
          identity.accountId !== input.account.accountId
        ) {
          throw new Error("Pacing accounting account identity mismatch.");
        }
        const previous =
          ledger?.buckets.find(
            (state) => pacingKey(state.accounting) === pacingKey(bucket.accounting),
          ) ?? null;
        let state = advanceQuotaPacing({
          state: previous,
          configuration: bucket.configuration,
          accounting: bucket.accounting,
          nowMs,
          maxObservationAgeMs: input.maxObservationAgeMs,
          envelopes: bucket.envelopes,
        });
        for (const settlement of bucket.settlements ?? []) {
          state = settleQuotaPacing({ state, ...settlement });
        }
        return state;
      });
      const reservations = buckets.map((state, index) =>
        reserveQuotaPacing({
          state,
          reservationId: input.reservationId,
          units: input.buckets[index]!.reserveUnits,
        }),
      );
      const kinds = new Set(reservations.map((result) => result.kind));
      if (kinds.has("settled") && kinds.size !== 1) {
        throw new Error("Pacing slice settlement is inconsistent across meters.");
      }
      let kind: "held" | "settled" | "reserved" = "reserved";
      if (kinds.has("held")) kind = "held";
      else if (kinds.has("settled")) kind = "settled";
      // Commit observations even when held, but reserve the vector atomically.
      const updated = kind === "held" ? buckets : reservations.map((result) => result.state);
      await writeProtectedJson(path, { version: 1, account: input.account, buckets: updated });
      return { kind, buckets: updated };
    });
  }

  async accountingContract(account: QuotaAccount): Promise<AccountingContract | null> {
    const path = this.accountPath(account);
    return loadAccountingContract(path, account, await readLedger(path));
  }

  /** Trusted configuration boundary only. Semantic migration requires explicit continuity proof. */
  async configureAccountingContract(input: {
    policy: QuotaGovernorPolicy;
    expectedRevision: string | null;
  }): Promise<
    | { kind: "configured"; contract: AccountingContract }
    | { kind: "deferred"; reason: "store_busy" | "accounting_migration_required" }
  > {
    const path = this.accountPath(input.policy.account);
    return this.withAccountLock(path, async () => {
      const ledger = await readLedger(path);
      const current = await loadAccountingContract(path, input.policy.account, ledger);
      if ((current?.revision ?? null) !== input.expectedRevision)
        throw new Error("Accounting contract changed. Reload it before saving.");
      // Existing unconfigured execution history needs an explicit migration,
      // including settlement reconciliation, before adding account semantics.
      if (!current && ledger)
        return { kind: "deferred", reason: "accounting_migration_required" } as const;
      const candidate = createAccountingContract(input.policy);
      if (
        current &&
        (!isDeepStrictEqual(current.semantics, candidate.semantics) ||
          !isDeepStrictEqual(current.estimatedWindow, candidate.estimatedWindow))
      )
        return { kind: "deferred", reason: "accounting_migration_required" } as const;
      const contract = current ?? candidate;
      // Persist intent first. A crash before the contract lands holds for
      // reconciliation instead of allowing another initial configuration.
      await persistAccountingContract(path, contract);
      if (ledger)
        await writeLedger(path, { ...ledger, accountingContractRevision: contract.revision });
      return { kind: "configured", contract } as const;
    });
  }

  /** Trusted management only; the observer is daemon-owned. No schedule can call this boundary. */
  async configureAccountPolicy(input: {
    policy: QuotaGovernorPolicy;
    expectedRevision: string | null;
    readObservation: () => Promise<QuotaObservation>;
  }): Promise<
    | { kind: "configured"; contract: AccountingContract }
    | { kind: "deferred"; reason: "store_busy" | "account_busy" | "accounting_migration_required" }
  > {
    const policy = structuredClone(input.policy);
    const path = this.accountPath(policy.account);
    return this.withAccountLock(path, async () => {
      const ledger = await readLedger(path);
      const current = await loadAccountingContract(path, policy.account, ledger);
      if ((current?.revision ?? null) !== input.expectedRevision)
        throw new Error("Accounting contract changed. Reload it before saving.");
      if (ledger && !ledger.released) return { kind: "deferred", reason: "account_busy" } as const;
      if (!current && ledger)
        return { kind: "deferred", reason: "accounting_migration_required" } as const;
      const candidate = createAccountingContract(policy);
      if (
        current &&
        (!isDeepStrictEqual(current.semantics, candidate.semantics) ||
          !isDeepStrictEqual(current.estimatedWindow, candidate.estimatedWindow))
      )
        return { kind: "deferred", reason: "accounting_migration_required" } as const;
      const observation = await input.readObservation();
      assertQuotaPolicyAccount(policy, observation, this.nowMs());
      const contract = { ...candidate, envelope: policy };
      await persistAccountingContract(path, contract);
      if (ledger)
        await writeLedger(path, { ...ledger, accountingContractRevision: contract.revision });
      return { kind: "configured", contract } as const;
    });
  }

  async reserve(input: ReserveInput): Promise<ReserveResult> {
    const path = this.accountPath(input.policy.account);
    return this.withAccountLock(path, async () => {
      const accounting = await loadAccountingContract(
        path,
        input.policy.account,
        await readLedger(path),
      );
      if (input.policy.prepaidAuthorization && !accounting?.envelope?.prepaidAuthorization)
        return { kind: "deferred", reason: "accounting_migration_required" } as const;
      const policy = accounting?.envelope
        ? combineQuotaPolicies(accounting.envelope, input.policy)
        : input.policy;
      return this.reserveUnderLock(path, { ...input, policy });
    });
  }

  async execution(account: QuotaAccount, reservationId: string): Promise<GovernorExecution> {
    return (await this.executionContext(account, reservationId)).execution;
  }

  async reservationState(
    account: QuotaAccount,
    reservationId: string,
  ): Promise<
    | { kind: "finalized" }
    | {
        kind: "active";
        execution: GovernorExecution;
        providerId: string;
        policy: QuotaGovernorPolicy;
        observation: QuotaObservation;
        scheduleId: string;
        occurrenceId: string;
      }
  > {
    const ledger = await readLedger(this.accountPath(account));
    if (!ledger || !isDeepStrictEqual(ledger.account, account))
      throw new Error("Quota reservation identity mismatch.");
    if (ledger.completions.some((entry) => entry.reservationId === reservationId))
      return { kind: "finalized" };
    if (ledger.reservation.id !== reservationId)
      throw new Error("Quota reservation identity mismatch.");
    return {
      kind: "active",
      execution: ledger.execution,
      providerId: ledger.reservation.providerId,
      policy: ledger.reservation.policy,
      observation: ledger.observation,
      scheduleId: ledger.reservation.scheduleId,
      occurrenceId: ledger.reservation.occurrenceId,
    };
  }

  async executionContext(
    account: QuotaAccount,
    reservationId: string,
  ): Promise<{
    execution: GovernorExecution;
    policy: QuotaGovernorPolicy;
    providerId: string;
    observation: QuotaObservation;
  }> {
    const ledger = await readLedger(this.accountPath(account));
    if (
      !ledger ||
      ledger.reservation.id !== reservationId ||
      !isDeepStrictEqual(ledger.account, account)
    ) {
      throw new Error("Quota reservation identity mismatch.");
    }
    return {
      execution: ledger.execution,
      policy: ledger.reservation.policy,
      providerId: ledger.reservation.providerId,
      observation: ledger.observation,
    };
  }

  async transition(input: {
    account: QuotaAccount;
    reservationId: string;
    expectedGeneration: number;
    event: GovernorExecutionEvent;
    observation?: QuotaObservation;
  }): Promise<
    | { kind: "transitioned"; execution: GovernorExecution }
    | Extract<ReserveResult, { kind: "deferred" }>
  > {
    const path = this.accountPath(input.account);
    return this.withAccountLock(path, async () => {
      const ledger = await readLedger(path);
      if (
        !ledger ||
        ledger.reservation.id !== input.reservationId ||
        !isDeepStrictEqual(ledger.account, input.account)
      ) {
        throw new Error("Quota reservation identity mismatch.");
      }
      const nowMs = this.nowMs();
      if (input.event.type === "start" || input.event.type === "resume") {
        const observation = input.observation ?? { status: "unavailable", reason: "read_failed" };
        const decision = evaluateQuotaGovernor({
          policy: ledger.reservation.policy,
          observation,
          nowMs,
          phase: "admission",
        });
        if (decision.action !== "admit") return { kind: "deferred", reason: "quota", decision };
        if (observation.status !== "available" || ledger.observation.status !== "available")
          throw new Error("Missing quota observation.");
        if (windowContract(observation, ledger.reservation.policy) !== ledger.windowContract)
          return { kind: "deferred", reason: "window_contract_changed" };
        if (Date.parse(observation.observedAt) < Date.parse(ledger.observation.observedAt))
          return { kind: "deferred", reason: "observation_regressed" };
        if (
          input.event.type === "resume" &&
          (!ledger.lastFreezeAt ||
            Date.parse(observation.observedAt) <= Date.parse(ledger.lastFreezeAt))
        ) {
          return { kind: "deferred", reason: "observation_regressed" };
        }
        ledger.observation = observation;
      }
      if (input.event.type === "freeze") {
        const previous = ledger.lastFreezeAt ? Date.parse(ledger.lastFreezeAt) : -Infinity;
        ledger.lastFreezeAt = new Date(Math.max(previous, nowMs)).toISOString();
      }
      ledger.execution = advanceGovernorExecution(
        ledger.execution,
        input.expectedGeneration,
        input.event,
      );
      recordExecutionAccounting(ledger, input.event, nowMs);
      await writeLedger(path, ledger);
      return { kind: "transitioned", execution: ledger.execution };
    });
  }

  /** Release execution capacity only after post-completion accounting is observed. */
  async finalize(input: {
    account: QuotaAccount;
    reservationId: string;
    observation: QuotaObservation;
  }): Promise<{ kind: "finalized" } | Extract<ReserveResult, { kind: "deferred" }>> {
    const path = this.accountPath(input.account);
    return this.withAccountLock(path, async () => {
      const ledger = await readLedger(path);
      if (!ledger || !isDeepStrictEqual(ledger.account, input.account))
        throw new Error("Quota ledger account identity mismatch.");
      if (ledger.completions.some((item) => item.reservationId === input.reservationId))
        return { kind: "finalized" };
      if (
        ledger.reservation.id !== input.reservationId ||
        ledger.execution.state !== "completed" ||
        !ledger.execution.settlementId ||
        !ledger.completedAt
      )
        throw new Error("Execution completion is unconfirmed.");
      const observation = QuotaObservationSchema.parse(input.observation);
      const nowMs = this.nowMs();
      const decision = evaluateQuotaGovernor({
        policy: ledger.reservation.policy,
        observation,
        nowMs,
        phase: "admission",
      });
      // Being out of allowance must not prevent cleanup. Missing or invalid
      // accounting must: it cannot release capacity as if outstanding usage were zero.
      const expenditureReasons = new Set([
        "launch_floor",
        "freeze_floor",
        "consumption_throttle",
        "consumption_hold",
        "consumption_freeze",
        "estimated_hourly_limit",
        // Expiry revokes new inference, not settlement of an already stopped execution.
        "prepaid_authorization_inactive",
      ]);
      if (ledger.reservation.policy.estimatedHourly) expenditureReasons.add("estimate_unavailable");
      if (decision.reasons.some((reason) => !expenditureReasons.has(reason.code)))
        return { kind: "deferred", reason: "quota", decision };
      if (observation.status !== "available" || ledger.observation.status !== "available")
        throw new Error("Missing completion accounting.");
      if (windowContract(observation, ledger.reservation.policy) !== ledger.windowContract)
        return { kind: "deferred", reason: "window_contract_changed" };
      if (
        Date.parse(observation.observedAt) <= Date.parse(ledger.completedAt) ||
        Date.parse(observation.observedAt) < Date.parse(ledger.observation.observedAt)
      )
        return { kind: "deferred", reason: "observation_regressed" };
      // Estimated policies release only after confirmed execution custody and
      // fresh post-completion telemetry. The separate estimate journal survives.
      // Strict policies retain provider charge-settlement requirements.
      if (
        (!ledger.reservation.policy.estimatedHourly ||
          ledger.reservation.policy.consumptionLimits.length > 0) &&
        !chargesAccountedFor(ledger, observation)
      )
        return { kind: "deferred", reason: "charge_settlement_unavailable" };
      ledger.observation = observation;
      ledger.released = true;
      ledger.completions.push({
        scheduleId: ledger.reservation.scheduleId,
        occurrenceId: ledger.reservation.occurrenceId,
        reservationId: ledger.reservation.id,
        finalizedAt: new Date(nowMs).toISOString(),
      });
      await writeLedger(path, ledger);
      return { kind: "finalized" };
    });
  }

  private async withAccountLock<T>(
    path: string,
    operation: () => Promise<T>,
  ): Promise<T | { kind: "deferred"; reason: "store_busy" }> {
    return this.serializeAccount(path, () => this.lockedOperation(path, operation));
  }

  private async serializeAccount<T>(path: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.pending.get(path) ?? Promise.resolve();
    const work = previous.catch(() => undefined).then(operation);
    this.pending.set(path, work);
    try {
      return await work;
    } finally {
      if (this.pending.get(path) === work) this.pending.delete(path);
    }
  }

  private async lockedOperation<T>(
    path: string,
    operation: () => Promise<T>,
  ): Promise<T | { kind: "deferred"; reason: "store_busy" }> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const lock = `${path}.lock`;
    try {
      await mkdir(lock, { mode: 0o700 });
    } catch (error) {
      if (hasCode(error, "EEXIST")) return { kind: "deferred", reason: "store_busy" };
      throw error;
    }
    // A crash leaves this lock in place. Never infer that an old timestamp means
    // an owner stopped; recovery must prove custody before removing it.
    try {
      return await operation();
    } finally {
      await rm(lock, { recursive: true });
    }
  }

  private async reserveUnderLock(path: string, input: ReserveInput): Promise<ReserveResult> {
    const ledger = await readLedger(path);
    if (ledger && !isDeepStrictEqual(ledger.account, input.policy.account))
      throw new Error("Quota ledger account identity mismatch.");
    const completed = ledger?.completions.find(
      (item) => item.scheduleId === input.scheduleId && item.occurrenceId === input.occurrenceId,
    );
    if (completed) return { kind: "completed", reservationId: completed.reservationId };
    if (ledger && input.observation.status === "available") {
      const conflict = reconcile(ledger, input, windowContract(input.observation, input.policy));
      if (conflict) return conflict;
    }
    let nowMs = this.nowMs();
    let decision = evaluateQuotaGovernor({ ...input, nowMs, phase: "admission" });
    if (decision.action !== "admit") return { kind: "deferred", reason: "quota", decision };
    const observation = QuotaObservationSchema.parse(input.observation);
    if (observation.status !== "available")
      throw new Error("Admission requires available telemetry.");
    const accounting = await loadAccountingContract(path, input.policy.account, ledger);
    const accountingDeferral = accountingAdmissionDeferral(accounting, input.policy);
    if (accountingDeferral) return accountingDeferral;
    const accountingRevision = await recordAdmissionAccounting(path, accounting, ledger);
    // Accounting reads and writes may wait. Recheck before recording admission;
    // the native dispatch boundary must check again after persistence completes.
    nowMs = this.nowMs();
    decision = evaluateQuotaGovernor({ ...input, nowMs, phase: "admission" });
    if (decision.action !== "admit") return { kind: "deferred", reason: "quota", decision };
    const contract = windowContract(observation, input.policy);
    if (ledger && !ledger.released) {
      if (ledger.execution.state === "completed")
        return { kind: "completed", reservationId: ledger.reservation.id };
      await writeLedger(path, { ...ledger, observation });
      return { kind: "admitted", reservation: ledger.reservation };
    }
    const reservation = ReservationSchema.parse({
      id: randomUUID(),
      scheduleId: input.scheduleId,
      occurrenceId: input.occurrenceId,
      providerId: input.providerId,
      policy: input.policy,
      createdAt: new Date(nowMs).toISOString(),
    });
    await writeLedger(path, {
      version: 1,
      account: input.policy.account,
      windowContract: contract,
      accountingContractRevision: accountingRevision,
      observation,
      reservation,
      lastFreezeAt: null,
      completedAt: null,
      executionBindings: [],
      released: false,
      completions: ledger?.completions ?? [],
      execution: {
        generation: 0,
        state: "reserved",
        executionId: null,
        authenticationGeneration: null,
        pauseReason: null,
        settlementId: null,
      },
    });
    return { kind: "admitted", reservation };
  }
}

function reconcile(ledger: Ledger, input: ReserveInput, contract: string): ReserveResult | null {
  if (!isDeepStrictEqual(ledger.account, input.policy.account)) {
    throw new Error("Quota ledger account identity mismatch.");
  }
  if (ledger.windowContract !== contract)
    return { kind: "deferred", reason: "window_contract_changed" };
  if (ledger.observation.status !== "available" || input.observation.status !== "available") {
    throw new Error("Quota ledger has no attributable observation.");
  }
  if (Date.parse(input.observation.observedAt) < Date.parse(ledger.observation.observedAt)) {
    return { kind: "deferred", reason: "observation_regressed" };
  }
  if (ledger.released) return null;
  const reservation = ledger.reservation;
  if (
    reservation.scheduleId !== input.scheduleId ||
    reservation.occurrenceId !== input.occurrenceId
  ) {
    return { kind: "deferred", reason: "account_busy" };
  }
  if (
    reservation.providerId !== input.providerId ||
    !isDeepStrictEqual(reservation.policy, input.policy)
  ) {
    return { kind: "deferred", reason: "execution_binding_changed" };
  }
  return null;
}

function windowContract(
  observation: Extract<QuotaObservation, { status: "available" }>,
  policy: QuotaGovernorPolicy,
): string {
  return JSON.stringify(
    observation.windows
      .filter((window) =>
        policy.requiredWindows.some((required) => required.bucketId === window.bucketId),
      )
      .map((window) =>
        JSON.stringify([
          window.bucketId,
          window.windowId,
          window.durationMinutes,
          window.semantics,
        ]),
      )
      .sort(),
  );
}

function accountingAdmissionDeferral(
  contract: AccountingContract | null,
  policy: QuotaGovernorPolicy,
): Extract<ReserveResult, { kind: "deferred" }> | null {
  if (!contract && (policy.consumptionLimits.length > 0 || policy.estimatedHourly))
    return { kind: "deferred", reason: "accounting_contract_missing" };
  if (contract && !satisfiesAccountingContract(contract, policy))
    return { kind: "deferred", reason: "accounting_migration_required" };
  return null;
}

function legacyContractFromLedger(ledger: Ledger): AccountingContract | null {
  // Historical floor-only execution never established gross accounting semantics.
  return ledger.reservation.policy.consumptionLimits.length > 0 ||
    ledger.reservation.policy.estimatedHourly
    ? legacyAccountingContract(ledger.reservation.policy)
    : null;
}

async function recordAdmissionAccounting(
  path: string,
  contract: AccountingContract | null,
  ledger: Ledger | null,
): Promise<string | null> {
  if (contract) await persistAccountingContract(path, contract);
  const revision = contract?.revision ?? null;
  if (ledger) ledger.accountingContractRevision = revision;
  return revision;
}

async function persistAccountingContract(
  path: string,
  contract: AccountingContract,
): Promise<void> {
  await writeProtectedJson(`${path}.contract-required`, {
    version: 1,
    account: contract.account,
    revision: contract.revision,
  });
  await writeProtectedJson(`${path}.contract`, contract);
}

async function loadAccountingContract(
  path: string,
  account: QuotaAccount,
  ledger: Ledger | null,
): Promise<AccountingContract | null> {
  const requiredValue = await readProtectedJson(`${path}.contract-required`);
  const required =
    requiredValue === undefined ? null : AccountingContractRequirementSchema.parse(requiredValue);
  if (required && !isDeepStrictEqual(required.account, account))
    throw new Error("Accounting contract requirement account mismatch.");
  const saved = await readProtectedJson(`${path}.contract`);
  if (required && saved === undefined)
    throw new Error("Recorded accounting contract is missing; reconciliation required.");
  let contract: AccountingContract | null;
  if (saved !== undefined) {
    contract = AccountingContractSchema.parse(saved);
    if (required && required.revision !== contract.revision)
      throw new Error("Accounting contract requirement revision mismatch.");
    if (
      ledger?.accountingContractRevision !== undefined &&
      ledger.accountingContractRevision !== contract.revision
    )
      throw new Error("Accounting contract provenance requires reconciliation.");
  } else if (ledger?.accountingContractRevision) {
    throw new Error("Recorded accounting contract is missing; reconciliation required.");
  } else if (ledger && ledger.accountingContractRevision === undefined) {
    contract = legacyContractFromLedger(ledger);
  } else contract = null;
  if (contract && !isDeepStrictEqual(contract.account, account))
    throw new Error("Accounting contract account identity mismatch.");
  return contract;
}

async function readLedger(path: string): Promise<Ledger | null> {
  const contents = await readProtectedJson(path);
  return contents === undefined ? null : LedgerSchema.parse(contents);
}

async function inspectRecoveryDirectory(path: string) {
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o777) !== 0o700 ||
    (await realpath(path)) !== path
  )
    throw new Error("Unsafe quota recovery directory.");
  return info;
}

async function readProtectedJson(path: string, replacements = 0): Promise<unknown> {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (hasCode(error, "ENOENT") && replacements === 0) return undefined;
    throw error;
  }
  try {
    const stat = await file.stat();
    if (stat.nlink === 0 && replacements < 2) {
      // Atomic publication may unlink the opened inode before fstat. Reopen
      // the current path rather than accepting detached or missing evidence.
      await file.close();
      file = undefined;
      return readProtectedJson(path, replacements + 1);
    }
    if (
      !stat.isFile() ||
      stat.size > 16 * 1024 * 1024 ||
      (process.getuid !== undefined &&
        (stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600)) ||
      stat.nlink !== 1
    )
      throw new Error("Invalid quota ledger file.");
    return JSON.parse(await file.readFile("utf8"));
  } finally {
    await file?.close();
  }
}

async function writeLedger(path: string, ledger: Ledger): Promise<void> {
  await writeProtectedJson(path, ledger);
}

async function writeProtectedJson(path: string, value: unknown): Promise<void> {
  const contents = JSON.stringify(value);
  if (Buffer.byteLength(contents) > 16 * 1024 * 1024)
    throw new Error("Quota accounting journal capacity exceeded.");
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(contents);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
    // Node cannot fsync directory handles on Windows. The journal file is
    // flushed before the atomic rename on every platform; retain the directory
    // durability barrier wherever the OS supports it. Never swallow file errors.
    if (process.platform !== "win32") {
      const directory = await open(resolve(path, ".."), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

function pacingKey(accounting: PacingAccounting): string {
  const { issuer, accountId, bucketId, meterId, revision, unit } = accounting.identity;
  return JSON.stringify([issuer, accountId, bucketId, meterId, revision, unit]);
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function chargesAccountedFor(
  ledger: Ledger,
  observation: Extract<QuotaObservation, { status: "available" }>,
): boolean {
  if (ledger.executionBindings.length === 0) return false;
  return ledger.executionBindings.every((binding) => {
    const receipts =
      observation.settledExecutions?.filter(
        (receipt) =>
          receipt.executionId === binding.executionId &&
          receipt.authenticationGeneration === binding.authenticationGeneration,
      ) ?? [];
    const receipt = receipts[0];
    if (receipts.length !== 1 || !receipt) return false;
    const accountedAt = Date.parse(receipt.accountedAt);
    const boundary = binding.endedAt;
    return (
      boundary !== null &&
      accountedAt >= Date.parse(boundary) &&
      accountedAt <= Date.parse(observation.observedAt)
    );
  });
}

function recordExecutionAccounting(
  ledger: Ledger,
  event: GovernorExecutionEvent,
  nowMs: number,
): void {
  if (event.type === "start" || event.type === "resume") {
    ledger.executionBindings.push({
      executionId: event.executionId,
      authenticationGeneration: event.authenticationGeneration,
      startedAt: new Date(nowMs).toISOString(),
      endedAt: null,
    });
  }
  if (event.type === "settled" || event.type === "complete") {
    const executionId = event.executionId;
    const binding = ledger.executionBindings.find((item) => item.executionId === executionId);
    if (!binding) throw new Error("Captured execution binding is missing.");
    binding.endedAt = new Date(nowMs).toISOString();
  }
  if (event.type === "complete") ledger.completedAt = new Date(nowMs).toISOString();
}
