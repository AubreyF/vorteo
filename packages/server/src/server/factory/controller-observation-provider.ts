import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  factorySnapshot,
  activityReceipts,
  FactoryStatusSchema,
  FactorySnapshotSchema,
  type FactorySnapshot,
} from "@getpaseo/server/factory-contracts";
import {
  parseQuotaGovernorPolicy,
  QuotaObservationSchema,
  type QuotaGovernorPolicy,
  type QuotaObservation,
} from "@getpaseo/protocol/quota-governor";
import type { ControllerOwnership } from "./ownership.js";
import type {
  FactoryObservationBinding,
  NativeFactoryObservationProvider,
} from "./observation-service.js";

const id = z.string().min(1).max(200);
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const repository = z.string().regex(/^[\w.-]+\/[\w.-]+$/);
const commit = z.string().regex(/^[a-f0-9]{40}$/);
const ClaimsSchema = z.object({
  schemaVersion: z.literal(1),
  installationId: id,
  revision,
  active: z
    .object({
      attemptId: id,
      approval: z.object({ repository, issueNumber: z.number().int().positive() }),
      workflow: z.object({ phase: id }).nullable().optional(),
    })
    .nullable(),
});
const IntakeSchema = z.object({
  version: z.literal(1),
  revision,
  active: z
    .object({
      intakeId: id,
      repository,
      issueNumber: z.number().int().positive(),
      phase: z.enum(["capture", "execution", "publication", "complete"]),
    })
    .nullable(),
});
const BuildsSchema = z.object({
  version: z.literal(1),
  repository,
  revision,
  active: z.object({ id, repository, productCommit: commit }).nullable(),
  requests: z.array(
    z.object({
      request: z.object({ id, repository, commits: z.array(commit).min(1).max(128) }),
      releaseId: id.nullable(),
    }),
  ),
});
const LifecycleSchema = z.object({
  admission: FactorySnapshotSchema.shape.admission,
  coordinators: z.object({ factory: FactoryStatusSchema, builds: FactoryStatusSchema }),
});

/** References captured by the retained startup owner, never supplied through RPC. */
export interface FactoryControllerObservationSource {
  binding: FactoryObservationBinding;
  authority: Pick<ControllerOwnership, "identity" | "assertCurrent">;
  authentication: { authenticationGeneration: string; assertCurrent(): void };
  policy: QuotaGovernorPolicy;
  claims: { current(): unknown };
  intake: { current(): unknown } | null;
  builds: { inspect(): Promise<unknown> };
  /** Must report native lifecycle facts, not infer execution from journal stages. */
  readLifecycle(): unknown;
  /** Native telemetry only. Must not reconcile or write estimated usage. */
  readAccountObservation(): Promise<unknown>;
}

/** Read-only projection over the already-loaded controller's retained objects. */
export class FactoryControllerObservationProvider implements NativeFactoryObservationProvider {
  readonly binding: FactoryObservationBinding;
  private readonly ownerIdentity: ControllerOwnership["identity"];
  private readonly policy: QuotaGovernorPolicy;
  private readonly authenticationGeneration: string;
  private readonly capturedSources: FactoryControllerObservationSource;

  constructor(
    private readonly source: FactoryControllerObservationSource,
    private readonly now: () => number = Date.now,
  ) {
    const binding = structuredClone(source.binding);
    this.binding = Object.freeze({
      ...binding,
      coordinators: Object.freeze({
        factory: Object.freeze(binding.coordinators.factory),
        builds: Object.freeze(binding.coordinators.builds),
      }),
    });
    this.capturedSources = { ...source };
    this.ownerIdentity = structuredClone(source.authority.identity);
    this.policy = parseQuotaGovernorPolicy(structuredClone(source.policy));
    this.authenticationGeneration = source.authentication.authenticationGeneration;
    if (
      !this.authenticationGeneration ||
      this.ownerIdentity.installationId !== this.binding.installationId
    )
      throw new Error("Factory observation lacks matching retained ownership.");
    this.assertCurrent();
  }

  assertCurrent(): void {
    this.source.authority.assertCurrent();
    this.source.authentication.assertCurrent();
    if (
      (Object.keys(this.capturedSources) as Array<keyof FactoryControllerObservationSource>).some(
        (key) => this.source[key] !== this.capturedSources[key],
      ) ||
      !isDeepStrictEqual(this.source.authority.identity, this.ownerIdentity) ||
      !isDeepStrictEqual(this.source.binding, this.binding) ||
      !isDeepStrictEqual(this.source.policy, this.policy) ||
      this.source.authentication.authenticationGeneration !== this.authenticationGeneration
    )
      throw new Error("Factory observation owner, account contract or authentication changed.");
  }

  private async readState() {
    this.assertCurrent();
    const claims = ClaimsSchema.parse(this.source.claims.current());
    const intake =
      this.source.intake === null ? null : IntakeSchema.parse(this.source.intake.current());
    const builds = BuildsSchema.parse(await this.source.builds.inspect());
    const lifecycle = LifecycleSchema.parse(await this.source.readLifecycle());
    this.assertCurrent();
    if (
      claims.installationId !== this.binding.installationId ||
      builds.repository !== this.binding.repository ||
      (claims.active !== null && claims.active.approval.repository !== this.binding.repository) ||
      (intake?.active && intake.active.repository !== this.binding.repository) ||
      (builds.active !== null && builds.active.repository !== this.binding.repository) ||
      builds.requests.some((entry) => entry.request.repository !== this.binding.repository)
    )
      throw new Error("Factory retained state belongs to another installation or repository.");
    return { claims, intake, builds, lifecycle };
  }

  private account(input: unknown, now: number): FactorySnapshot["account"] {
    const parsed = QuotaObservationSchema.safeParse(input);
    const limit = this.policy.estimatedHourly?.maxConsumedPoints ?? null;
    const unavailable = {
      usagePoints: null,
      limitPoints: limit,
      observedAt: null,
      unit: "allowance-points" as const,
    };
    if (!parsed.success || parsed.data.status !== "available") return unavailable;
    const observation = parsed.data;
    if (!isDeepStrictEqual(observation.account, this.policy.account)) return unavailable;
    const measurement = observation.estimatedHourlyUsage;
    const estimate = this.policy.estimatedHourly;
    if (
      !measurement ||
      !estimate ||
      measurement.bucketId !== estimate.bucketId ||
      measurement.windowId !== estimate.windowId ||
      measurement.authenticationGeneration !== this.authenticationGeneration
    )
      return unavailable;
    const measuredAt = Date.parse(measurement.observedAt);
    const age = now - measuredAt;
    const usable =
      age >= 0 &&
      age <= this.policy.maxObservationAgeSeconds * 1000 &&
      measurement.observedAt === observation.observedAt &&
      Date.parse(measurement.coverageStart) <= now - 3_600_000 &&
      this.hasRequiredWindows(observation);
    return {
      ...unavailable,
      usagePoints: usable ? measurement.consumedPoints : null,
      observedAt: measurement.observedAt,
    };
  }

  private hasRequiredWindows(
    observation: Extract<QuotaObservation, { status: "available" }>,
  ): boolean {
    return this.policy.requiredWindows.every((required) => {
      const matches = observation.windows.filter(
        (window) => window.bucketId === required.bucketId && window.windowId === required.windowId,
      );
      return matches.length === 1 && matches[0]!.durationMinutes === required.durationMinutes;
    });
  }

  async snapshot(input: { projectId: string }): Promise<FactorySnapshot> {
    const request = factorySnapshot.input.parse(input);
    if (request.projectId !== this.binding.projectId)
      throw new Error("Factory observation project differs.");
    const before = await this.readState();
    const account = await this.source.readAccountObservation();
    this.assertCurrent();
    if (!isDeepStrictEqual(before, await this.readState()))
      throw new Error(
        "Factory retained observation changed; read again without replaying effects.",
      );
    const observedAt = this.now();
    const work: FactorySnapshot["work"] = [];
    if (before.claims.active) {
      const active = before.claims.active;
      work.push(
        this.recordedWork(
          active.attemptId,
          active.approval.issueNumber,
          active.workflow?.phase ?? "unknown",
        ),
      );
    }
    if (before.intake?.active) {
      const active = before.intake.active;
      work.push(
        this.recordedWork(active.intakeId, active.issueNumber, `qualification ${active.phase}`),
      );
    }
    const pending = before.builds.requests.filter((entry) => entry.releaseId === null);
    const gaps = ["Verified release observation is not connected."];
    if (pending.length > 100)
      gaps.push(`${pending.length - 100} pending build requests omitted by the 100-row bound.`);
    if (pending.some((entry) => entry.request.commits.length > 1))
      gaps.push(
        "Pending sourceRef shows the first requested commit; full commit sets are retained by Builds.",
      );
    const active = before.builds.active;
    return factorySnapshot.output.parse({
      schemaVersion: 1,
      serverId: this.binding.serverId,
      installationId: this.binding.installationId,
      projectId: this.binding.projectId,
      // This fingerprint names the observed combination, not a journal/global order.
      revision: createHash("sha256").update(JSON.stringify(before)).digest("hex"),
      observedAt: new Date(observedAt).toISOString(),
      freshness: {
        state: "current",
        reason:
          "Retained controller state; execution is reported only by the native lifecycle reader.",
      },
      admission: before.lifecycle.admission,
      account: this.account(account, observedAt),
      coordinators: (["factory", "builds"] as const).map((role) => ({
        role,
        workspaceId: this.binding.coordinators[role].workspaceId,
        agentId: this.binding.coordinators[role].agentId,
        status: before.lifecycle.coordinators[role],
      })),
      work,
      issues: [],
      builds: {
        active:
          active === null
            ? null
            : {
                id: active.id,
                status: "recovery",
                sourceRef: active.productCommit,
                detailsUrl: null,
              },
        pending: pending.slice(0, 100).map((entry) => ({
          id: entry.request.id,
          sourceRef: entry.request.commits[0],
          status: "scheduled",
        })),
        latestRelease: null,
      },
      exceptions: [
        {
          id: "delivery-unavailable",
          title: "Verified delivery observation unavailable",
          detail: "No release or shipment is inferred from a retained record's shape.",
        },
      ],
      coverage: {
        work: {
          complete: false,
          gaps: [
            "Only the active claim and qualification intake are projected; other native workers are not inventoried.",
          ],
        },
        issues: {
          complete: false,
          gaps: ["The GitHub qualification queue is not observed by this reader."],
        },
        builds: { complete: false, gaps },
      },
      capabilities: {
        install: false,
        pause: false,
        resume: false,
        stop: false,
        takeover: false,
        disable: false,
        cleanup: false,
      },
    });
  }

  private recordedWork(
    workId: string,
    number: number,
    stage: string,
  ): FactorySnapshot["work"][number] {
    return {
      id: workId,
      title: `Issue #${number}: recorded ${stage}`,
      phase: "recovery",
      issueUrl: `https://github.com/${this.binding.repository}/issues/${number}`,
      workspaceId: null,
      agentId: null,
      prUrl: null,
      ciUrl: null,
      blocker: "Retained stage does not establish native execution or verified worker navigation.",
    };
  }

  async receipts(input: { projectId: string | null; cursor: string | null; limit: number }) {
    const request = activityReceipts.input.parse(input);
    if (request.projectId !== null && request.projectId !== this.binding.projectId)
      throw new Error("Factory receipt project differs.");
    this.assertCurrent();
    const observedAt = new Date(this.now()).toISOString();
    const result = activityReceipts.output.parse({
      schemaVersion: 1,
      producer: { serverId: this.binding.serverId, pluginId: "factory" },
      observedAt,
      availability: "unavailable",
      receipts: null,
      nextCursor: null,
      coverage: {
        from: null,
        to: observedAt,
        complete: false,
        gaps: ["Retained delivery verification and durable cursor storage are not connected."],
        cursorState: request.cursor === null ? "initial" : "expired",
      },
    });
    this.assertCurrent();
    return result;
  }
}
