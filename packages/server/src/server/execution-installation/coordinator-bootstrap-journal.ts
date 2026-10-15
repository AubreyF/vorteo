import {
  inspectLifecycleActivationChild,
  type LifecycleActivationChild,
} from "./coordinator-bootstrap-maintenance-child.js";
import {
  assertStandingBootstrapAuthority,
  assertStandingBootstrapTransition,
} from "./coordinator-bootstrap-maintenance-standing.js";
import {
  assertMaintenanceEnrollmentClaim,
  readMaintenanceEnrollmentForClaim,
  unresolvedMaintenanceActivations,
} from "./coordinator-bootstrap-maintenance-enrollment.js";
import {
  closeSync,
  constants,
  fsyncSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  linkSync,
  readSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  CoordinatorBootstrapRequestSchema,
  type CoordinatorBootstrapRequest,
} from "@getpaseo/protocol/coordinator-bootstrap";
import { writePrivateFileAtomicSync } from "../private-files.js";
import { parseLifecycleJournal, type LifecycleJob } from "./lifecycle-journal.js";
import {
  BootstrapRequestConflict,
  assertRecoveredBootstrapBase,
  assertCoordinatorLifecycleIdle,
  coordinatorLifecycleWork,
  openBootstrapRequests,
  coordinatorPlanDigest,
  type BootstrapRequestJournal,
} from "./coordinator-bootstrap.js";

const RecordsSchema = z.strictObject({
  version: z.literal(1),
  requests: z.array(CoordinatorBootstrapRequestSchema),
});

const PendingSchema = z.strictObject({
  version: z.literal(1),
  requests: z.array(CoordinatorBootstrapRequestSchema),
  // Retain the entire pre-promotion claim. This survives either side of the
  // main-file rename and authenticates stale sidecar copies after later progress.
  promotions: z.array(CoordinatorBootstrapRequestSchema),
});

const ClaimFenceRecoverySchema = z.strictObject({
  id: z.string().uuid(),
  revision: z.string().uuid(),
  generation: z.string().uuid(),
  planSha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export const ClaimFenceSchema = z.strictObject({
  version: z.literal(1),
  recovery: ClaimFenceRecoverySchema,
  original: CoordinatorBootstrapRequestSchema,
  fenced: CoordinatorBootstrapRequestSchema,
});

/** Retained evidence is useful only if it preserves the complete original
 * approval and generation. Parsing the shape alone cannot establish a fence. */
export function validateClaimFence(value: unknown): z.infer<typeof ClaimFenceSchema> {
  const record = ClaimFenceSchema.parse(value);
  const { original, fenced, recovery } = record;
  if (
    original.status !== "approved" ||
    !original.decisionAt ||
    original.execution?.stage !== "claimed" ||
    original.execution.rollbackAttemptedAt !== undefined ||
    original.plan.automaticRecovery !== "restore-compatible" ||
    !original.plan.compatibleRecovery ||
    original.planSha256 !== coordinatorPlanDigest(original.plan) ||
    original.id === recovery.id ||
    fenced.revision === original.revision ||
    fenced.execution?.stage !== "recovery_required" ||
    !isDeepStrictEqual(
      {
        ...fenced.execution,
        stage: original.execution?.stage,
        updatedAt: original.execution?.updatedAt,
      },
      original.execution,
    ) ||
    !isDeepStrictEqual(
      { ...fenced, revision: original.revision, execution: original.execution },
      original,
    )
  )
    throw new BootstrapRequestConflict("Retained claim fence changed");
  return record;
}

/** Synchronous policy check inside the shared lifecycle lock. Throw to reject.
 * Read enrollment with readUnderLifecycleLock; never acquire another lock or
 * perform asynchronous/native work here. Snapshots cannot alter the write. */
export type LifecycleWriteAdmission = (
  previous: readonly LifecycleJob[],
  next: readonly LifecycleJob[],
) => undefined;

/** Serializes bootstrap claims and lifecycle admission through one protected lock. */
export class FileBootstrapRequestJournal implements BootstrapRequestJournal {
  private readonly file: string;
  private readonly lock: string;
  private readonly pendingFile: string;

  constructor(private readonly directory: string) {
    this.checkDirectory();
    this.file = path.join(directory, "coordinator-bootstrap.json");
    this.lock = path.join(directory, "coordinator-bootstrap.lock");
    this.pendingFile = path.join(directory, "coordinator-bootstrap-pending.json");
  }

  private checkDirectory(): void {
    const stat = lstatSync(this.directory);
    if (
      !process.getuid ||
      realpathSync(this.directory) !== this.directory ||
      !stat.isDirectory() ||
      stat.uid !== process.getuid() ||
      (stat.mode & 0o077) !== 0
    )
      throw new BootstrapRequestConflict(
        "Bootstrap storage must be a private owned canonical directory",
      );
  }

  private readFile(file: string): unknown {
    this.checkDirectory();
    let fd: number;
    try {
      fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    try {
      const stat = fstatSync(fd);
      if (
        !stat.isFile() ||
        stat.uid !== process.getuid!() ||
        (stat.mode & 0o077) !== 0 ||
        stat.nlink !== 1
      )
        throw new BootstrapRequestConflict("Bootstrap journal is not a private owned file");
      return JSON.parse(readFileSync(fd, "utf8"));
    } finally {
      closeSync(fd);
    }
  }

  private snapshots() {
    const main = RecordsSchema.parse(this.readFile(this.file) ?? { version: 1, requests: [] });
    const pending = PendingSchema.parse(
      this.readFile(this.pendingFile) ?? {
        version: 1,
        requests: [],
        promotions: [],
      },
    );
    for (const records of [main.requests, pending.requests, pending.promotions]) {
      if (new Set(records.map((record) => record.id)).size !== records.length)
        throw new BootstrapRequestConflict("Duplicate bootstrap storage identity");
    }
    for (const intent of pending.promotions) {
      const source = pending.requests.find((record) => record.id === intent.id);
      const promoted = main.requests.find((record) => record.id === intent.id);
      if (!intent.execution || intent.execution.stage !== "claimed" || intent.status !== "approved")
        throw new BootstrapRequestConflict("Invalid bootstrap promotion intent");
      if (source && !isDeepStrictEqual(source, intent))
        throw new BootstrapRequestConflict("Bootstrap promotion source changed");
      if (!source && !promoted)
        throw new BootstrapRequestConflict("Bootstrap promotion evidence is missing");
      if (promoted) this.verifyPromotion(intent, promoted);
    }
    for (const source of pending.requests) {
      if (
        main.requests.some((record) => record.id === source.id) &&
        !pending.promotions.some((record) => record.id === source.id)
      )
        throw new BootstrapRequestConflict("Unverified duplicate bootstrap promotion");
    }
    return { main, pending };
  }

  private verifyPromotion(
    source: CoordinatorBootstrapRequest,
    current: CoordinatorBootstrapRequest,
  ) {
    if (!current.execution || current.execution.generation !== source.execution?.generation)
      throw new BootstrapRequestConflict("Bootstrap promotion generation changed");
    // Only execution progress and its revision may differ. In particular, this
    // preserves decisionAt, reason, plan digest, recovered ancestry and every plan field.
    const normalized = {
      ...current,
      revision: source.revision,
      execution: source.execution,
    };
    if (
      !isDeepStrictEqual(normalized, source) ||
      (current.execution.stage === "claimed" && !isDeepStrictEqual(current, source))
    )
      throw new BootstrapRequestConflict("Bootstrap promotion record changed");
  }

  read(): CoordinatorBootstrapRequest[] {
    const { main, pending } = this.snapshots();
    const mainIds = new Set(main.requests.map((record) => record.id));
    return [...main.requests, ...pending.requests.filter((record) => !mainIds.has(record.id))];
  }

  /** Startup authority comes only from the promoted main journal. */
  readPromoted(): CoordinatorBootstrapRequest[] {
    return this.snapshots().main.requests;
  }

  /** Promoted requests alone confer startup authority. An exact recovered
   * predecessor may remain in the pending sidecar after its claim was fenced.
   * Include only that bound history, without promoting it or admitting unrelated
   * pending work. The startup verifier still validates every digest and chain. */
  readStartupHistory(): CoordinatorBootstrapRequest[] {
    const { main, pending } = this.snapshots();
    const history = [...main.requests];
    const included = new Set(history.map((record) => record.id));
    const combined = [
      ...main.requests,
      ...pending.requests.filter((record) => !included.has(record.id)),
    ];
    for (const request of main.requests) {
      if (!request.execution) continue;
      const seen = new Set([request.id]);
      let current = request;
      for (;;) {
        const previous = assertRecoveredBootstrapBase(current.plan, combined);
        if (!previous) break;
        if (seen.has(previous.id))
          throw new BootstrapRequestConflict("Cyclic bootstrap startup history");
        seen.add(previous.id);
        if (!included.has(previous.id)) {
          history.push(previous);
          included.add(previous.id);
        }
        current = previous;
      }
    }
    return history;
  }

  private write(file: string, value: unknown): void {
    writePrivateFileAtomicSync(file, JSON.stringify(value));
    for (const target of [file, this.directory]) {
      const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
  }

  readLifecycle(): LifecycleJob[] {
    return parseLifecycleJournal(
      this.readFile(path.join(this.directory, "restart-jobs.json")) ?? [],
    );
  }

  private hasCoordinatorExecution(): boolean {
    return openBootstrapRequests(this.read()).some((request) => request.execution !== undefined);
  }

  private unresolvedActivation() {
    return unresolvedMaintenanceActivations(readMaintenanceEnrollmentForClaim(this.directory));
  }

  lifecycleAdmissionAvailable(): boolean {
    return this.withLock(
      () => !this.hasCoordinatorExecution() && this.unresolvedActivation().length === 0,
    );
  }

  writeLifecycle(
    value: LifecycleJob[],
    admission?: LifecycleWriteAdmission,
    activationChild?: LifecycleActivationChild,
  ): void {
    this.withLock(() => {
      const next = parseLifecycleJournal(value);
      const priorJobs = this.readLifecycle();
      if (admission && admission(structuredClone(priorJobs), structuredClone(next)) !== undefined)
        throw new BootstrapRequestConflict("Lifecycle admission must complete synchronously");
      const retained = coordinatorLifecycleWork(priorJobs);
      // Terminal bookkeeping may remove obligations even when enrollment is unreadable.
      const added = coordinatorLifecycleWork(next).filter(
        (job) =>
          !retained.some((previous) => {
            if (isDeepStrictEqual(previous, job)) return true;
            if (!["rejected", "failed", "succeeded"].includes(job.status)) return false;
            return previous.id === job.id && previous.target === job.target;
          }),
      );
      if (added.length && this.hasCoordinatorExecution())
        throw new BootstrapRequestConflict(
          "Coordinator recovery must finish before installation work",
        );
      if (activationChild) {
        if (!admission)
          throw new BootstrapRequestConflict("Activation child requires locked evidence admission");
        const child = inspectLifecycleActivationChild(
          activationChild,
          readMaintenanceEnrollmentForClaim(this.directory),
          next,
        );
        if (added.some((job) => job.id !== child.proof.requestId))
          throw new BootstrapRequestConflict(
            "Activation exception cannot admit unrelated lifecycle work",
          );
        this.retainActivationChild(child);
      } else if (added.length && this.unresolvedActivation().length) {
        throw new BootstrapRequestConflict(
          "Installation activation must be reconciled before new lifecycle work",
        );
      }
      this.write(path.join(this.directory, "restart-jobs.json"), next);
    });
  }

  private retainActivationChild(child: ReturnType<typeof inspectLifecycleActivationChild>): void {
    const file = path.join(
      this.directory,
      `maintenance-child-${child.proof.stepId}-${child.proof.generation}.json`,
    );
    const current = this.readFile(file);
    if (current !== null && current !== undefined) {
      const record = z
        .strictObject({ binding: z.unknown(), initialRevision: z.uuid() })
        .parse(current);
      if (!isDeepStrictEqual(record.binding, child.binding))
        throw new BootstrapRequestConflict(
          "Activation step is already bound to another child or source",
        );
      return;
    }
    // Persist binding before queue selection. A lost queue write can only be
    // reconciled with this same child; it cannot free the step for a new request.
    this.write(file, { binding: child.binding, initialRevision: child.initialRevision });
  }

  promote(request: CoordinatorBootstrapRequest): void {
    this.withLock(() => {
      assertCoordinatorLifecycleIdle(
        this.readFile(path.join(this.directory, "restart-jobs.json")) ?? [],
      );
      const { main, pending } = this.snapshots();
      const retained = main.requests.find((record) => record.id === request.id);
      const intent = pending.promotions.find((record) => record.id === request.id);
      if (retained) {
        if (!intent) throw new BootstrapRequestConflict("Bootstrap promotion intent is missing");
        this.verifyPromotion(intent, retained);
        if (!isDeepStrictEqual(retained, request))
          throw new BootstrapRequestConflict("Bootstrap promotion ownership changed");
        // Reconcile an uncertain previous fsync before allowing lifecycle effects.
        this.write(this.file, main);
        return;
      }
      const source = pending.requests.find((record) => record.id === request.id);
      if (
        !source ||
        !isDeepStrictEqual(source, request) ||
        source.status !== "approved" ||
        source.execution?.stage !== "claimed" ||
        source.plan.automaticRecovery !== "restore-compatible" ||
        !source.plan.compatibleRecovery
      )
        throw new BootstrapRequestConflict("Exact protected bootstrap claim required");
      if (!intent)
        this.write(this.pendingFile, {
          ...pending,
          promotions: [...pending.promotions, source],
        });
      // No lifecycle effect is permitted until this replacement and directory fsync return.
      this.write(this.file, { ...main, requests: [...main.requests, source] });
    });
  }

  /** Read-only admission. This cannot reserve dispatch; the eventual fence must
   * repeat the comparison under the same lock immediately before its write. */
  verifyUnpromotedClaim(expected: CoordinatorBootstrapRequest): void {
    const original = CoordinatorBootstrapRequestSchema.parse(expected);
    this.withLock(() => {
      const { main, pending } = this.snapshots();
      if (
        original.status !== "approved" ||
        original.execution?.stage !== "claimed" ||
        main.requests.some((record) => record.id === original.id) ||
        pending.promotions.some((record) => record.id === original.id) ||
        !isDeepStrictEqual(
          pending.requests.find((record) => record.id === original.id),
          original,
        )
      )
        throw new BootstrapRequestConflict("Exact unpromoted bootstrap claim required");
    });
  }

  /** A failed pre-promotion claim cannot acquire startup or lifecycle authority.
   * Observe all three durable locations under the promoter's own journal lock. */
  verifyUnpromotedFailure(expected: CoordinatorBootstrapRequest): void {
    const original = CoordinatorBootstrapRequestSchema.parse(expected);
    this.withLock(() => {
      const { main, pending } = this.snapshots();
      if (
        original.status !== "approved" ||
        !original.decisionAt ||
        original.execution?.stage !== "recovery_required" ||
        original.execution.rollbackAttemptedAt !== undefined ||
        original.plan.automaticRecovery !== "restore-compatible" ||
        !original.plan.compatibleRecovery ||
        original.planSha256 !== coordinatorPlanDigest(original.plan) ||
        main.requests.some((record) => record.id === original.id) ||
        pending.promotions.some((record) => record.id === original.id) ||
        !isDeepStrictEqual(
          pending.requests.find((record) => record.id === original.id),
          original,
        )
      )
        throw new BootstrapRequestConflict("Exact unpromoted bootstrap failure required");
    });
  }

  /** Only a separately authenticated recovery executor may call this boundary.
   * It invalidates an unpromoted claim under the same lock as promotion, retaining
   * the full approval and claim first. It grants no process or service authority. */
  fenceUnpromotedClaim(
    expected: CoordinatorBootstrapRequest,
    recovery: z.infer<typeof ClaimFenceRecoverySchema>,
    verifyRecovery?: () => void,
  ): CoordinatorBootstrapRequest {
    const original = CoordinatorBootstrapRequestSchema.parse(expected);
    const binding = ClaimFenceRecoverySchema.parse(recovery);
    if (
      original.status !== "approved" ||
      original.execution?.stage !== "claimed" ||
      original.plan.automaticRecovery !== "restore-compatible" ||
      !original.plan.compatibleRecovery ||
      original.planSha256 !== coordinatorPlanDigest(original.plan) ||
      original.id === binding.id
    )
      throw new BootstrapRequestConflict("Exact compatible claim required for recovery fencing");
    return this.withLock(() => {
      // The managed recovery journal checks its exact durable claim while this
      // same lock excludes cancellation, recovery progress and old promotion.
      const verification: unknown = verifyRecovery?.();
      if (verification instanceof Promise)
        throw new BootstrapRequestConflict("Recovery claim verification must be synchronous");
      const { main, pending } = this.snapshots();
      if (
        main.requests.some((record) => record.id === original.id) ||
        pending.promotions.some((record) => record.id === original.id)
      )
        throw new BootstrapRequestConflict(
          "Bootstrap promotion already started; recovery must reconcile it",
        );
      const file = path.join(this.directory, `coordinator-claim-fence-${binding.generation}.json`);
      const value = this.readFile(file);
      const retained = value === undefined ? undefined : validateClaimFence(value);
      if (
        retained &&
        (!isDeepStrictEqual(retained.original, original) ||
          !isDeepStrictEqual(retained.recovery, binding))
      )
        throw new BootstrapRequestConflict("Claim fence recovery binding changed");
      const fenced: CoordinatorBootstrapRequest = retained?.fenced ?? {
        ...original,
        revision: randomUUID(),
        execution: {
          ...original.execution!,
          stage: "recovery_required",
          updatedAt: new Date().toISOString(),
        },
      };
      validateClaimFence({ version: 1, recovery: binding, original, fenced });
      const current = pending.requests.find((record) => record.id === original.id);
      const alreadyFenced = retained !== undefined && isDeepStrictEqual(current, fenced);
      if (!alreadyFenced && !isDeepStrictEqual(current, original))
        throw new BootstrapRequestConflict("Bootstrap claim changed before recovery fencing");
      // Rewriting identical evidence reconciles an earlier uncertain fsync. A
      // caller must still prove process exit and selection before native effects.
      this.write(file, { version: 1, recovery: binding, original, fenced });
      this.write(this.pendingFile, {
        ...pending,
        requests: pending.requests.map((record) => (record.id === original.id ? fenced : record)),
      });
      return structuredClone(fenced);
    });
  }

  replace(expected: CoordinatorBootstrapRequest[], next: CoordinatorBootstrapRequest[]): void {
    this.withLock(() => this.replaceLocked(expected, next));
  }

  /** Recovery must cancel a legacy claim under the same exclusion. The callback
   * is synchronous: persist its intent before replace, and never perform native effects here. */
  withRecoveryTransaction<T>(
    operation: (
      records: CoordinatorBootstrapRequest[],
      replace: (next: CoordinatorBootstrapRequest[]) => void,
    ) => T,
  ): T {
    return this.withLock(() => {
      const expected = this.read();
      let active = true;
      try {
        const result = operation(structuredClone(expected), (next) => {
          if (!active) throw new BootstrapRequestConflict("Recovery journal transaction ended");
          this.replaceLocked(expected, next);
        });
        if (result instanceof Promise)
          throw new BootstrapRequestConflict("Recovery journal transaction must be synchronous");
        return result;
      } finally {
        active = false;
      }
    });
  }

  private verifyRetainedEnrollment(
    previous: CoordinatorBootstrapRequest | undefined,
    record: CoordinatorBootstrapRequest,
  ): void {
    const reservesLaunch = record.enrollmentDispatch && !previous?.enrollmentDispatch;
    if (previous?.enrollment && !isDeepStrictEqual(previous.enrollment, record.enrollment))
      throw new BootstrapRequestConflict("Retained enrollment provenance cannot change");
    if (
      previous?.enrollmentDispatch &&
      !isDeepStrictEqual(previous.enrollmentDispatch, record.enrollmentDispatch)
    )
      throw new BootstrapRequestConflict("Retained enrollment dispatch cannot change");
    if (
      reservesLaunch &&
      (!previous?.enrollment ||
        record.enrollmentDispatch!.approvedRevision !== previous.revision ||
        previous.execution)
    )
      throw new BootstrapRequestConflict("Enrollment dispatch must reserve its exact approval");
  }

  private verifyEnrollmentTransitions(
    expected: CoordinatorBootstrapRequest[],
    next: CoordinatorBootstrapRequest[],
  ): void {
    for (const record of next) {
      const previous = expected.find((item) => item.id === record.id);
      if (assertStandingBootstrapTransition(previous, record))
        assertStandingBootstrapAuthority(
          record,
          readMaintenanceEnrollmentForClaim(this.directory),
          Date.now(),
        );
      const addsAuthority = record.enrollment && !previous?.enrollment;
      const startsEnrollmentClaim = record.enrollment && record.execution && !previous?.execution;
      const reservesLaunch = record.enrollmentDispatch && !previous?.enrollmentDispatch;
      this.verifyRetainedEnrollment(previous, record);
      if (startsEnrollmentClaim && !previous?.enrollmentDispatch)
        throw new BootstrapRequestConflict("Enrollment claim requires its reserved native launch");
      if (addsAuthority || startsEnrollmentClaim || reservesLaunch) {
        if (addsAuthority && (!previous || previous.status !== "pending" || previous.execution))
          throw new BootstrapRequestConflict("Enrollment must bind an exact pending review");
        const { execution: _execution, ...unclaimed } = record;
        assertMaintenanceEnrollmentClaim(
          unclaimed,
          readMaintenanceEnrollmentForClaim(this.directory),
        );
      }
    }
  }

  private replaceLocked(
    expected: CoordinatorBootstrapRequest[],
    next: CoordinatorBootstrapRequest[],
  ): void {
    if (!isDeepStrictEqual(this.read(), expected))
      throw new BootstrapRequestConflict("Bootstrap request changed. Refresh its review.");
    const { main, pending } = this.snapshots();
    const parsed = RecordsSchema.parse({ version: 1, requests: next });
    this.verifyEnrollmentTransitions(expected, parsed.requests);
    const startsClaim = parsed.requests.some(
      (record) =>
        record.execution?.stage === "claimed" &&
        !expected.find((previous) => previous.id === record.id)?.execution,
    );
    if (startsClaim) {
      assertCoordinatorLifecycleIdle(this.readLifecycle());
      const active = this.unresolvedActivation();
      for (const record of parsed.requests) {
        if (
          record.execution?.stage !== "claimed" ||
          expected.find((previous) => previous.id === record.id)?.execution
        )
          continue;
        if (
          active.some(
            (step) =>
              step.status === "pending" ||
              step.id !== record.enrollment?.stepId ||
              step.generation !== record.enrollment?.generation,
          )
        )
          throw new BootstrapRequestConflict(
            "Installation activation must be reconciled before another coordinator claim",
          );
      }
    }
    const mainIds = new Set(main.requests.map((record) => record.id));
    for (const intent of pending.promotions) {
      if (!mainIds.has(intent.id))
        throw new BootstrapRequestConflict("Bootstrap promotion requires reconciliation");
    }
    const nextMain = parsed.requests.filter(
      (record) => mainIds.has(record.id) || record.plan.automaticRecovery !== "restore-compatible",
    );
    const nextPending = parsed.requests.filter(
      (record) => !mainIds.has(record.id) && record.plan.automaticRecovery === "restore-compatible",
    );
    for (const intent of pending.promotions) {
      const retained = nextMain.find((record) => record.id === intent.id);
      if (!retained)
        throw new BootstrapRequestConflict("Promoted bootstrap history cannot be removed");
      this.verifyPromotion(intent, retained);
    }
    const mainChanged = !isDeepStrictEqual(main.requests, nextMain);
    const pendingChanged = !isDeepStrictEqual(pending.requests, nextPending);
    // One request mutation has one authority file. Stale duplicate cleanup is
    // unnecessary; retained promotion evidence makes main authoritative forever.
    if (mainChanged) {
      const retainedPending = pending.requests.filter((record) => !mainIds.has(record.id));
      if (!isDeepStrictEqual(retainedPending, nextPending))
        throw new BootstrapRequestConflict("Bootstrap mutation crosses journal authority");
      this.write(this.file, { version: 1, requests: nextMain });
    } else if (pendingChanged) {
      this.write(this.pendingFile, { ...pending, requests: nextPending });
    }
  }

  private withLock<T>(operation: () => T): T {
    this.checkDirectory();
    const lock = this.openLock();
    try {
      this.acquireLock(lock);
      const owned = fstatSync(lock);
      const current = lstatSync(this.lock);
      if (
        !owned.isFile() ||
        owned.uid !== process.getuid!() ||
        (owned.mode & 0o077) !== 0 ||
        owned.dev !== current.dev ||
        owned.ino !== current.ino ||
        owned.size > 512
      )
        throw new BootstrapRequestConflict("Bootstrap journal lock identity changed");
      const bytes = Buffer.alloc(owned.size);
      readSync(lock, bytes, 0, bytes.length, 0);
      let marker: { version: 1; temporary: string };
      try {
        marker = z
          .strictObject({
            version: z.literal(1),
            temporary: z.string().regex(/^\.coordinator-bootstrap-lock-[a-f0-9-]{36}$/),
          })
          .parse(JSON.parse(bytes.toString("utf8")));
      } catch {
        // Legacy O_EXCL writers use the same path. Never remove their lock or
        // assume they participate in flock. They refuse this permanent inode.
        throw new BootstrapRequestConflict(
          "Bootstrap storage is busy: legacy journal lock requires owner reconciliation",
        );
      }
      const temporary = path.join(this.directory, marker.temporary);
      try {
        const retained = lstatSync(temporary);
        if (retained.dev !== owned.dev || retained.ino !== owned.ino)
          throw new BootstrapRequestConflict("Bootstrap lock publication identity changed");
        unlinkSync(temporary);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
      if (fstatSync(lock).nlink !== 1)
        throw new BootstrapRequestConflict("Bootstrap lock has unexpected links");
      const directory = openSync(this.directory, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
      return operation();
    } finally {
      // flock belongs to this inherited open file description. Closing the
      // parent's descriptor, including process death, releases it automatically.
      closeSync(lock);
    }
  }

  private acquireLock(descriptor: number): void {
    try {
      // Python is already a native bootstrap dependency. Passing descriptor 3
      // shares its open file description, so the parent retains flock after the
      // helper exits. No service operation or credential enters this helper.
      execFileSync(
        "/usr/bin/python3",
        ["-I", "-B", "-c", "import fcntl; fcntl.flock(3, fcntl.LOCK_EX | fcntl.LOCK_NB)"],
        { stdio: ["ignore", "ignore", "pipe", descriptor], timeout: 5000 },
      );
    } catch {
      throw new BootstrapRequestConflict(
        "Bootstrap storage is busy. Refresh after its writer settles.",
      );
    }
  }

  private openLock(): number {
    try {
      return openSync(this.lock, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    // Publish a fully initialized, already locked inode without replacing any
    // legacy lock. If killed between link and unlink, the next owner removes
    // only the exact extra link named in the protected marker.
    const basename = `.coordinator-bootstrap-lock-${randomUUID()}`;
    const temporary = path.join(this.directory, basename);
    const descriptor = openSync(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
      0o600,
    );
    let published = false;
    try {
      writeFileSync(descriptor, JSON.stringify({ version: 1, temporary: basename }));
      fsyncSync(descriptor);
      this.acquireLock(descriptor);
      try {
        linkSync(temporary, this.lock);
        published = true;
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      }
      if (published) return descriptor;
    } finally {
      if (!published) {
        closeSync(descriptor);
        unlinkSync(temporary);
      }
    }
    return openSync(this.lock, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  }
}
