import { closeSync, constants, fsyncSync, fstatSync, openSync, readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  BootstrapClaimedRecoveryRequestSchema,
  type BootstrapClaimedRecoveryRequest,
} from "@getpaseo/protocol/coordinator-bootstrap";
import { writePrivateFileAtomicSync } from "../private-files.js";
import {
  FileBootstrapRequestJournal,
  validateClaimFence,
} from "./coordinator-bootstrap-journal.js";
import { BootstrapRequestConflict } from "./coordinator-bootstrap.js";
import {
  claimedRecoveryPlanDigest,
  validateClaimedRecoveryPlan,
  type ClaimedRecoveryReviewJournal,
} from "./coordinator-bootstrap-claimed-recovery.js";

const ReviewsSchema = z.strictObject({
  version: z.literal(1),
  requests: z.array(BootstrapClaimedRecoveryRequestSchema),
});

export const ClaimedRecoveryEffectSchema = z.strictObject({
  version: z.literal(1),
  effect: z.enum(["terminate", "kill"]),
  request: BootstrapClaimedRecoveryRequestSchema,
  reservedAt: z.string().datetime(),
});
export type ClaimedRecoveryEffect = z.infer<typeof ClaimedRecoveryEffectSchema>;

/** Separate history keeps legacy readers unchanged. The original journal's
 * kernel lock serializes review CAS with promotion and recovery fencing. */
export class FileClaimedRecoveryReviewJournal implements ClaimedRecoveryReviewJournal {
  private readonly original: FileBootstrapRequestJournal;
  private readonly file: string;
  constructor(private readonly directory: string) {
    this.original = new FileBootstrapRequestJournal(directory);
    this.file = path.join(directory, "coordinator-claimed-reviews.json");
  }

  private readValue(file: string): unknown {
    let descriptor: number;
    try {
      descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    try {
      const stat = fstatSync(descriptor);
      if (
        !stat.isFile() ||
        stat.uid !== process.getuid!() ||
        stat.nlink !== 1 ||
        (stat.mode & 0o077) !== 0
      )
        throw new BootstrapRequestConflict("Claimed recovery storage must be private and owned");
      return JSON.parse(readFileSync(descriptor, "utf8"));
    } finally {
      closeSync(descriptor);
    }
  }

  private load(): BootstrapClaimedRecoveryRequest[] {
    const value = this.readValue(this.file);
    return value === undefined ? [] : this.validate(ReviewsSchema.parse(value).requests);
  }

  private persist(file: string, value: unknown): void {
    writePrivateFileAtomicSync(file, JSON.stringify(value));
    for (const target of [file, this.directory]) {
      const descriptor = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
    }
  }

  private validate(value: unknown): BootstrapClaimedRecoveryRequest[] {
    const records = z.array(BootstrapClaimedRecoveryRequestSchema).parse(value);
    if (new Set(records.map((record) => record.id)).size !== records.length)
      throw new BootstrapRequestConflict("Duplicate claimed recovery identity");
    return records;
  }

  /** Invalidate the old claim only while this exact separately approved recovery
   * still owns its dispatch. This does not reserve or perform a native effect. */
  fenceClaim(value: BootstrapClaimedRecoveryRequest) {
    const request = BootstrapClaimedRecoveryRequestSchema.parse(value);
    validateClaimedRecoveryPlan(request.plan);
    if (
      request.status !== "approved" ||
      !request.decisionAt ||
      request.execution?.stage !== "claimed" ||
      request.planSha256 !== claimedRecoveryPlanDigest(request.plan)
    )
      throw new BootstrapRequestConflict("Exact claimed recovery dispatch required for fencing");
    return this.original.fenceUnpromotedClaim(
      request.plan.original,
      {
        id: request.id,
        revision: request.revision,
        generation: request.execution.generation,
        planSha256: request.planSha256,
      },
      () => {
        if (
          !isDeepStrictEqual(
            this.load().find((record) => record.id === request.id),
            request,
          )
        )
          throw new BootstrapRequestConflict("Claimed recovery execution ownership changed");
      },
    );
  }

  private effectFile(
    request: BootstrapClaimedRecoveryRequest,
    effect: "terminate" | "kill",
  ): string {
    const generation = z.string().uuid().parse(request.execution?.generation);
    return path.join(this.directory, `coordinator-claimed-effect-${generation}-${effect}.json`);
  }

  private requireCurrentFence(request: BootstrapClaimedRecoveryRequest): void {
    if (
      !isDeepStrictEqual(
        this.load().find((record) => record.id === request.id),
        request,
      )
    )
      throw new BootstrapRequestConflict("Claimed recovery execution ownership changed");
    const generation = z.string().uuid().parse(request.execution?.generation);
    const retained = validateClaimFence(
      this.readValue(path.join(this.directory, `coordinator-claim-fence-${generation}.json`)),
    );
    if (
      retained.recovery.id !== request.id ||
      retained.recovery.generation !== generation ||
      retained.recovery.planSha256 !== request.planSha256 ||
      !isDeepStrictEqual(retained.original, request.plan.original) ||
      !isDeepStrictEqual(
        this.original.read().find((record) => record.id === retained.original.id),
        retained.fenced,
      ) ||
      this.original.readPromoted().some((record) => record.id === retained.original.id)
    )
      throw new BootstrapRequestConflict("Claimed recovery fence is not current");
  }

  private readEffect(
    request: BootstrapClaimedRecoveryRequest,
    effect: "terminate" | "kill",
  ): ClaimedRecoveryEffect | null {
    const value = this.readValue(this.effectFile(request, effect));
    if (value === undefined) return null;
    const record = ClaimedRecoveryEffectSchema.parse(value);
    const retained = record.request;
    if (
      record.effect !== effect ||
      retained.status !== "approved" ||
      !retained.decisionAt ||
      retained.execution?.stage !== "effect_pending" ||
      retained.execution.generation !== request.execution?.generation ||
      !isDeepStrictEqual(
        { ...retained, revision: request.revision, execution: request.execution },
        request,
      )
    )
      throw new BootstrapRequestConflict("Claimed recovery effect history changed");
    return record;
  }

  /** Persist one attempt before dispatch. A missing native reply never makes
   * this slot reusable. The native helper must separately consume its send slot
   * and verify process identity, ownership and monotonic escalation timing. */
  reserveEffect(
    value: BootstrapClaimedRecoveryRequest,
    effect: "terminate" | "kill",
  ): ClaimedRecoveryEffect {
    const request = BootstrapClaimedRecoveryRequestSchema.parse(value);
    validateClaimedRecoveryPlan(request.plan);
    if (
      request.status !== "approved" ||
      !request.decisionAt ||
      request.execution?.stage !== "effect_pending" ||
      request.planSha256 !== claimedRecoveryPlanDigest(request.plan) ||
      (effect === "kill" && request.plan.signalPolicy.escalation !== "SIGKILL")
    )
      throw new BootstrapRequestConflict("Exact approved recovery effect required");
    z.enum(["terminate", "kill"]).parse(effect);
    return this.original.withRecoveryTransaction(() => {
      this.requireCurrentFence(request);
      if (this.readEffect(request, effect))
        throw new BootstrapRequestConflict(
          "Recovery effect was already reserved; observe without replay",
        );
      if (effect === "kill" && !this.readEffect(request, "terminate"))
        throw new BootstrapRequestConflict(
          "Recovery escalation requires retained termination history",
        );
      const record: ClaimedRecoveryEffect = {
        version: 1,
        request,
        effect,
        reservedAt: new Date().toISOString(),
      };
      this.persist(this.effectFile(request, effect), record);
      return structuredClone(record);
    });
  }

  /** The protected caller must retain recovery executor ownership. Only an
   * untouched fence/effect namespace can close a failed attempt this way. */
  abortBeforeEffects(
    value: BootstrapClaimedRecoveryRequest,
  ): BootstrapClaimedRecoveryRequest | null {
    const request = BootstrapClaimedRecoveryRequestSchema.parse(value);
    validateClaimedRecoveryPlan(request.plan);
    return this.original.withRecoveryTransaction(() => {
      const records = this.load();
      if (
        !isDeepStrictEqual(
          records.find((record) => record.id === request.id),
          request,
        )
      )
        throw new BootstrapRequestConflict("Claimed recovery execution ownership changed");
      if (
        request.status !== "approved" ||
        !request.decisionAt ||
        !request.execution ||
        !["claimed", "recovery_required"].includes(request.execution.stage) ||
        request.planSha256 !== claimedRecoveryPlanDigest(request.plan)
      )
        return null;
      const generation = request.execution.generation;
      if (
        this.readValue(this.effectFile(request, "terminate")) !== undefined ||
        this.readValue(this.effectFile(request, "kill")) !== undefined
      )
        return null;
      const evidence = this.readValue(
        path.join(this.directory, `coordinator-claim-fence-${generation}.json`),
      );
      if (evidence !== undefined) {
        const fence = validateClaimFence(evidence);
        if (
          fence.recovery.id !== request.id ||
          fence.recovery.generation !== generation ||
          fence.recovery.planSha256 !== request.planSha256 ||
          !isDeepStrictEqual(fence.original, request.plan.original)
        )
          throw new BootstrapRequestConflict("Claimed recovery fence history changed");
        // A crash can retain intent before replacing the original. Under both
        // ownership locks, the unchanged original and absent effect slots prove
        // that this attempt can close without completing the abandoned write.
        if (
          !isDeepStrictEqual(
            this.original.read().find((record) => record.id === fence.original.id),
            fence.original,
          )
        )
          return null;
      }
      const next: BootstrapClaimedRecoveryRequest = {
        ...request,
        revision: randomUUID(),
        execution: {
          ...request.execution,
          stage: "aborted_before_effects",
          updatedAt: new Date().toISOString(),
        },
      };
      this.persist(this.file, {
        version: 1,
        requests: records.map((record) => (record.id === next.id ? next : record)),
      });
      return next;
    });
  }

  /** Observation returns history only. It cannot reserve or dispatch an effect. */
  inspectEffects(value: BootstrapClaimedRecoveryRequest): {
    terminate: ClaimedRecoveryEffect | null;
    kill: ClaimedRecoveryEffect | null;
  } {
    const request = BootstrapClaimedRecoveryRequestSchema.parse(value);
    validateClaimedRecoveryPlan(request.plan);
    if (
      request.status !== "approved" ||
      !request.execution ||
      request.planSha256 !== claimedRecoveryPlanDigest(request.plan)
    )
      throw new BootstrapRequestConflict("Exact claimed recovery observation required");
    return this.original.withRecoveryTransaction(() => {
      this.requireCurrentFence(request);
      const terminate = this.readEffect(request, "terminate");
      const kill = this.readEffect(request, "kill");
      if (kill && (!terminate || request.plan.signalPolicy.escalation !== "SIGKILL"))
        throw new BootstrapRequestConflict("Claimed recovery effect history changed");
      return { terminate, kill };
    });
  }

  readReviews(): BootstrapClaimedRecoveryRequest[] {
    // This is one atomically replaced document. Status readers must not take
    // the executor's mutation lock: polling could otherwise abort a valid
    // recovery. Every mutation still rechecks its full expected value under
    // the shared journal lock before writing or reserving an effect.
    this.original.read(); // Recheck canonical directory and original history without flock.
    return this.load();
  }

  replaceReviews(
    expected: BootstrapClaimedRecoveryRequest[],
    next: BootstrapClaimedRecoveryRequest[],
  ): void {
    this.original.withRecoveryTransaction(() => {
      if (!isDeepStrictEqual(this.load(), expected))
        throw new BootstrapRequestConflict("Claimed recovery review changed");
      const requests = this.validate(next);
      // An uncertain sync is not a failed write. Reconcile the exact retained
      // request instead of submitting another operation.
      this.persist(this.file, { version: 1, requests });
    });
  }
}
