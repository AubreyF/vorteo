import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { InstallationSettingsSnapshot } from "@getpaseo/protocol/installation-settings";
import {
  InstructionRequestDecisionSchema,
  InstructionRequestInputSchema,
  InstructionRequestSchema,
  type InstructionRequest,
  type InstructionRequestEnvironment,
} from "@getpaseo/protocol/instruction-requests";
import { ensurePrivateDirectory, writePrivateFileAtomicSync } from "../../private-files.js";

/**
 * Agents propose shared agent instructions; only the owner applies them. A request stores the
 * full proposed text and the settings revision it was written against. Approval applies that
 * exact text through the owner settings update, which refuses a stale revision, so an approval
 * can never overwrite instructions the owner has not seen.
 */

// Per environment, so untrusted Dev agents cannot crowd out Host requests.
const MAX_PENDING = 16;
const MAX_RETAINED = 64;

const StoreSchema = z.strictObject({
  version: z.literal(1),
  requests: z.array(z.unknown()),
});

// Stored records are read tolerantly so a newer or damaged store never stops the coordinator:
// unknown fields are dropped and unrecognized records or statuses are kept out of the pending set.
const StoredRequestSchema = InstructionRequestSchema.extend({
  status: z.string(),
}).strip();

function readStoredRequest(value: unknown): InstructionRequest | null {
  const parsed = StoredRequestSchema.safeParse(value);
  if (!parsed.success) return null;
  const known = InstructionRequestSchema.shape.status.safeParse(parsed.data.status);
  return {
    ...parsed.data,
    status: known.success ? known.data : "stale",
    detail: known.success ? parsed.data.detail : "Recorded by a newer coordinator",
  };
}

export class InstructionRequestError extends Error {
  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message);
  }
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

interface SettingsAuthority {
  snapshot(): InstallationSettingsSnapshot;
  update(input: {
    expectedRevision: number;
    settings: { appendSystemPrompt: string };
  }): Promise<InstallationSettingsSnapshot>;
  acceptsAppendSystemPrompt?(text: string): boolean;
}

export class InstructionRequests {
  private readonly file: string;
  private requests: InstructionRequest[];

  constructor(
    directory: string,
    private readonly settings: SettingsAuthority,
    private readonly now: () => Date = () => new Date(),
    private readonly warn: (message: string) => void = () => {},
  ) {
    ensurePrivateDirectory(directory);
    this.file = path.join(directory, "instruction-requests.json");
    this.requests = this.load();
  }

  private load(): InstructionRequest[] {
    if (!existsSync(this.file)) return [];
    try {
      const store = StoreSchema.parse(JSON.parse(readFileSync(this.file, "utf8")));
      return store.requests
        .map(readStoredRequest)
        .filter((item): item is InstructionRequest => item !== null);
    } catch {
      // A damaged store must not keep the coordinator down. Keep it for inspection.
      const kept = `${this.file}.unreadable-${this.now().getTime()}`;
      renameSync(this.file, kept);
      this.warn(`Instruction request store was unreadable; moved to ${kept}`);
      return [];
    }
  }

  list(): InstructionRequest[] {
    return structuredClone(this.requests);
  }

  get(id: string, environment: InstructionRequestEnvironment): InstructionRequest | null {
    const request = this.requests.find(
      (item) => item.id === id && item.environment === environment,
    );
    return request ? structuredClone(request) : null;
  }

  submit(input: unknown, environment: InstructionRequestEnvironment): InstructionRequest {
    const request = InstructionRequestInputSchema.parse(input);
    const snapshot = this.settings.snapshot();
    if (!snapshot.settings) throw new InstructionRequestError("Shared settings are not ready", 503);
    if (request.baseRevision !== snapshot.revision)
      throw new InstructionRequestError(
        `Settings changed (revision ${snapshot.revision}); read them again and resubmit`,
      );
    const current = snapshot.settings.appendSystemPrompt;
    if (current === request.appendSystemPrompt)
      throw new InstructionRequestError("Proposed instructions match the current instructions");
    if (this.settings.acceptsAppendSystemPrompt?.(request.appendSystemPrompt) === false)
      throw new InstructionRequestError(
        "Proposed instructions must not include installation-owned instructions",
        400,
      );
    if (
      this.requests.filter((item) => item.status === "pending" && item.environment === environment)
        .length >= MAX_PENDING
    )
      throw new InstructionRequestError("Too many pending instruction requests", 429);
    const created: InstructionRequest = {
      id: randomUUID(),
      status: "pending",
      environment,
      requester: request.requester,
      reason: request.reason,
      baseRevision: request.baseRevision,
      baseSha256: sha256(current),
      appendSystemPrompt: request.appendSystemPrompt,
      proposedSha256: sha256(request.appendSystemPrompt),
      createdAt: this.now().toISOString(),
      decidedAt: null,
      appliedRevision: null,
      detail: null,
    };
    this.requests.push(created);
    this.save();
    return structuredClone(created);
  }

  async decide(input: unknown): Promise<InstructionRequest> {
    const decision = InstructionRequestDecisionSchema.parse(input);
    const request = this.requests.find((item) => item.id === decision.id);
    if (!request) throw new InstructionRequestError("Unknown instruction request", 404);
    if (request.status !== "pending")
      throw new InstructionRequestError(`Instruction request is already ${request.status}`);
    if (request.proposedSha256 !== decision.proposedSha256)
      throw new InstructionRequestError("Reviewed text differs from the request");
    const decidedAt = this.now().toISOString();
    if (decision.decision === "reject") {
      Object.assign(request, { status: "rejected", decidedAt });
      this.save();
      return structuredClone(request);
    }
    const snapshot = this.settings.snapshot();
    const current = snapshot.settings?.appendSystemPrompt;
    if (
      snapshot.revision !== request.baseRevision ||
      current === undefined ||
      sha256(current) !== request.baseSha256
    ) {
      Object.assign(request, {
        status: "stale",
        decidedAt,
        detail: "Instructions changed after this request; the agent must resubmit",
      });
      this.save();
      return structuredClone(request);
    }
    // The settings service rejects a concurrent change through expectedRevision. An agent cancel
    // that lands while this update is in flight loses: the approved text is applied.
    const applied = await this.settings.update({
      expectedRevision: request.baseRevision,
      settings: { appendSystemPrompt: request.appendSystemPrompt },
    });
    Object.assign(request, { status: "applied", decidedAt, appliedRevision: applied.revision });
    // Newer revisions make every other pending request stale.
    for (const other of this.requests)
      if (other.status === "pending")
        Object.assign(other, {
          status: "stale",
          decidedAt,
          detail: "Another instruction change was applied first; the agent must resubmit",
        });
    this.save();
    return structuredClone(request);
  }

  cancel(id: string, environment: InstructionRequestEnvironment): InstructionRequest {
    const request = this.requests.find(
      (item) => item.id === id && item.environment === environment,
    );
    if (!request) throw new InstructionRequestError("Unknown instruction request", 404);
    if (request.status !== "pending")
      throw new InstructionRequestError(`Instruction request is already ${request.status}`);
    Object.assign(request, { status: "cancelled", decidedAt: this.now().toISOString() });
    this.save();
    return structuredClone(request);
  }

  private save(): void {
    const pending = this.requests.filter((item) => item.status === "pending");
    const settled = this.requests.filter((item) => item.status !== "pending").slice(-MAX_RETAINED);
    this.requests = [...settled, ...pending].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    writePrivateFileAtomicSync(
      this.file,
      JSON.stringify(StoreSchema.parse({ version: 1, requests: this.requests }), null, 2),
    );
  }
}
