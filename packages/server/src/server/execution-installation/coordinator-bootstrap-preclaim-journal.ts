import {
  BootstrapPreclaimRecoveryRequestSchema,
  type BootstrapPreclaimRecoveryRequest,
} from "@getpaseo/protocol/coordinator-bootstrap";
import { constants, closeSync, fsyncSync, fstatSync, openSync, readFileSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { writePrivateFileAtomicSync } from "../private-files.js";
import { FileBootstrapRequestJournal } from "./coordinator-bootstrap-journal.js";
import { BootstrapRequestConflict } from "./coordinator-bootstrap.js";
import {
  PreclaimRecoveryRecordSchema,
  validatePreclaimCancellation,
  type PreclaimCancellation,
  type PreclaimRecoveryRecord,
} from "./coordinator-bootstrap-preclaim-recovery.js";

/** Uses the legacy journal's exclusion and cancellation format. The old runner
 * need not understand this sidecar: its existing claim CAS loses to cancellation.
 * No method here authorizes or sends a signal, or proves process exit. */
export class FileBootstrapPreclaimJournal {
  private readonly requests: FileBootstrapRequestJournal;

  constructor(private readonly directory: string) {
    this.requests = new FileBootstrapRequestJournal(directory);
  }

  private file(id: string): string {
    return path.join(
      this.directory,
      `coordinator-preclaim-recovery-${z.string().uuid().parse(id)}.json`,
    );
  }

  private readValue(file: string): unknown {
    let descriptor: number;
    try {
      descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
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
        throw new BootstrapRequestConflict("Preclaim recovery journal is not private");
      return JSON.parse(readFileSync(descriptor, "utf8"));
    } finally {
      closeSync(descriptor);
    }
  }

  private read(id: string): PreclaimRecoveryRecord | null {
    const value = this.readValue(this.file(id));
    if (value === undefined) return null;
    const record = PreclaimRecoveryRecordSchema.parse(value);
    validatePreclaimCancellation(record.cancellation);
    if (
      record.cancellation.recoveryId !== id ||
      (!record.fenced && (record.terminateIntentAt !== null || record.killIntentAt !== null)) ||
      (record.killIntentAt !== null && record.terminateIntentAt === null)
    )
      throw new BootstrapRequestConflict("Preclaim recovery history is inconsistent");
    return record;
  }

  private loadReviews(): BootstrapPreclaimRecoveryRequest[] {
    const value = this.readValue(path.join(this.directory, "coordinator-preclaim-reviews.json"));
    if (value === undefined) return [];
    const parsed = z
      .strictObject({
        version: z.literal(1),
        requests: z.array(BootstrapPreclaimRecoveryRequestSchema),
      })
      .parse(value);
    if (new Set(parsed.requests.map((record) => record.id)).size !== parsed.requests.length)
      throw new BootstrapRequestConflict("Duplicate preclaim recovery identity");
    return parsed.requests;
  }

  readReviews(): BootstrapPreclaimRecoveryRequest[] {
    return this.requests.withRecoveryTransaction(() => this.loadReviews());
  }

  replaceReviews(
    expected: BootstrapPreclaimRecoveryRequest[],
    next: BootstrapPreclaimRecoveryRequest[],
  ): void {
    this.requests.withRecoveryTransaction(() => {
      if (!isDeepStrictEqual(this.loadReviews(), expected))
        throw new BootstrapRequestConflict("Preclaim recovery review changed");
      const requests = z.array(BootstrapPreclaimRecoveryRequestSchema).parse(next);
      if (new Set(requests.map((record) => record.id)).size !== requests.length)
        throw new BootstrapRequestConflict("Duplicate preclaim recovery identity");
      this.writeValue(path.join(this.directory, "coordinator-preclaim-reviews.json"), {
        version: 1,
        requests,
      });
    });
  }

  private write(record: PreclaimRecoveryRecord): void {
    const file = this.file(record.cancellation.recoveryId);
    this.writeValue(file, record);
  }

  private writeValue(file: string, value: unknown): void {
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

  inspect(id: string): PreclaimRecoveryRecord | null {
    return this.requests.withRecoveryTransaction(() => this.read(id));
  }

  /** The caller holds recovery executor exclusion. Absence of an intent is
   * meaningful only under that exclusion and the original journal lock. */
  abortBeforeEffects(
    expected: BootstrapPreclaimRecoveryRequest,
  ): BootstrapPreclaimRecoveryRequest | null {
    return this.requests.withRecoveryTransaction((originals) => {
      const reviews = this.loadReviews();
      const current = reviews.find((record) => record.id === expected.id);
      if (!isDeepStrictEqual(current, expected))
        throw new BootstrapRequestConflict("Preclaim recovery execution ownership changed");
      if (
        expected.status !== "approved" ||
        !expected.execution ||
        !["claimed", "recovery_required"].includes(expected.execution.stage) ||
        this.read(expected.id) !== null ||
        !isDeepStrictEqual(
          originals.find((record) => record.id === expected.plan.original.id),
          expected.plan.ownerCancellation ?? expected.plan.original,
        )
      )
        return null;
      const aborted: BootstrapPreclaimRecoveryRequest = {
        ...expected,
        revision: randomUUID(),
        execution: {
          ...expected.execution,
          stage: "aborted_before_effects",
          updatedAt: new Date().toISOString(),
        },
      };
      this.writeValue(path.join(this.directory, "coordinator-preclaim-reviews.json"), {
        version: 1,
        requests: reviews.map((record) => (record.id === aborted.id ? aborted : record)),
      });
      return structuredClone(aborted);
    });
  }

  /** Called only for an authenticated, dispatched recovery review. Retains the
   * complete old approval before changing it. An uncertain write never grants effects. */
  fence(value: unknown): PreclaimRecoveryRecord {
    const cancellation = validatePreclaimCancellation(value);
    if (cancellation.original.plan.state.directory !== this.directory)
      throw new BootstrapRequestConflict("Preclaim recovery state directory changed");
    return this.requests.withRecoveryTransaction((requests, replace) => {
      const retained = this.read(cancellation.recoveryId);
      if (retained && !isDeepStrictEqual(retained.cancellation, cancellation))
        throw new BootstrapRequestConflict("Preclaim recovery review changed");
      const current = requests.find((item) => item.id === cancellation.original.id);
      const original = isDeepStrictEqual(current, cancellation.original);
      const canceled = isDeepStrictEqual(current, cancellation.canceled);
      if (
        (cancellation.ownerCancellation && !canceled) ||
        (!original && !((retained || cancellation.ownerCancellation) && canceled))
      )
        throw new BootstrapRequestConflict("Preclaim executor may already have claimed dispatch");
      if (retained?.fenced && original)
        throw new BootstrapRequestConflict("Preclaim cancellation was reverted");
      const record: PreclaimRecoveryRecord = retained ?? {
        cancellation,
        fenced: false,
        terminateIntentAt: null,
        killIntentAt: null,
      };
      this.write(record);
      if (original)
        replace(
          requests.map((item) =>
            item.id === cancellation.original.id ? cancellation.canceled : item,
          ),
        );
      // Even after a previous uncertain fsync, do not return a fence receipt
      // until the authoritative cancellation file and directory are durable.
      const promoted = this.requests
        .readPromoted()
        .some((item) => item.id === cancellation.original.id);
      const authority = promoted
        ? "coordinator-bootstrap.json"
        : "coordinator-bootstrap-pending.json";
      for (const target of [path.join(this.directory, authority), this.directory]) {
        const descriptor = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          fsyncSync(descriptor);
        } finally {
          closeSync(descriptor);
        }
      }
      const fenced = { ...record, fenced: true };
      this.write(fenced);
      return fenced;
    });
  }

  assertFenced(cancellation: PreclaimCancellation): void {
    validatePreclaimCancellation(cancellation);
    this.requests.withRecoveryTransaction((requests) => {
      const record = this.read(cancellation.recoveryId);
      const current = requests.find((item) => item.id === cancellation.original.id);
      if (
        !record?.fenced ||
        !isDeepStrictEqual(record.cancellation, cancellation) ||
        !isDeepStrictEqual(current, cancellation.canceled)
      )
        throw new BootstrapRequestConflict("Preclaim recovery cancellation fence changed");
    });
  }

  /** Reserve once after independent native verification. The caller must not
   * execute on throw, even when inspecting afterward shows the intent persisted. */
  reserveEffect(input: {
    cancellation: PreclaimCancellation;
    effect: "terminate" | "kill";
    at: string;
  }): void {
    const cancellation = validatePreclaimCancellation(input.cancellation);
    if (cancellation.original.plan.state.directory !== this.directory)
      throw new BootstrapRequestConflict("Preclaim recovery state directory changed");
    z.string().datetime().parse(input.at);
    this.requests.withRecoveryTransaction((requests) => {
      const record = this.read(cancellation.recoveryId);
      const current = requests.find((item) => item.id === cancellation.original.id);
      if (
        !record?.fenced ||
        !isDeepStrictEqual(record.cancellation, cancellation) ||
        !isDeepStrictEqual(current, cancellation.canceled)
      )
        throw new BootstrapRequestConflict("Preclaim recovery has no durable cancellation fence");
      if (input.effect === "terminate") {
        if (record.terminateIntentAt !== null)
          throw new BootstrapRequestConflict("Preclaim termination cannot be replayed");
        this.write({ ...record, terminateIntentAt: input.at });
      } else {
        if (record.terminateIntentAt === null || record.killIntentAt !== null)
          throw new BootstrapRequestConflict(
            "Preclaim escalation cannot be replayed or precede termination",
          );
        this.write({ ...record, killIntentAt: input.at });
      }
    });
  }
}
