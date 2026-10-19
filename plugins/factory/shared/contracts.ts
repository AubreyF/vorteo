import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const identity = z.string().min(1).max(200);
const text = z.string().max(2000);
const timestamp = z.iso.datetime();
const link = z.url({ protocol: /^https?$/ }).max(2000);
const points = z.number().finite().nonnegative();

export const FactoryStatusSchema = z.enum([
  "scheduled",
  "executing",
  "awaiting_ci",
  "failed",
  "quota_held",
  "disconnected",
  "recovery",
  "idle",
  "completed",
  "paused",
  "unknown",
]);

const coverage = z.object({
  complete: z.boolean(),
  gaps: z.array(text).max(20),
});

export const FactorySnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    serverId: identity,
    revision: identity.nullable(),
    installationId: identity.nullable(),
    projectId: identity,
    observedAt: timestamp.nullable(),
    freshness: z.object({
      state: z.enum(["current", "stale", "disconnected", "unknown"]),
      reason: text.nullable(),
    }),
    admission: z.object({
      state: z.enum(["open", "paused", "held", "unavailable"]),
      reason: text.nullable(),
    }),
    account: z.object({
      usagePoints: points.nullable(),
      limitPoints: points.nullable(),
      observedAt: timestamp.nullable(),
      unit: z.literal("allowance-points"),
    }),
    coordinators: z
      .array(
        z.object({
          role: z.enum(["factory", "builds"]),
          workspaceId: identity.nullable(),
          agentId: identity.nullable(),
          status: FactoryStatusSchema,
        }),
      )
      .max(2),
    work: z
      .array(
        z.object({
          id: identity,
          title: text,
          phase: FactoryStatusSchema,
          issueUrl: link.nullable(),
          workspaceId: identity.nullable(),
          agentId: identity.nullable(),
          prUrl: link.nullable(),
          ciUrl: link.nullable(),
          blocker: text.nullable(),
        }),
      )
      .max(100),
    issues: z
      .array(
        z.object({
          id: identity,
          number: z.number().int().positive(),
          title: text,
          url: link,
          qualification: z.enum(["pending", "ready", "held", "rejected", "unknown"]),
          reason: text.nullable(),
        }),
      )
      .max(100),
    builds: z.object({
      active: z
        .object({
          id: identity,
          status: FactoryStatusSchema,
          sourceRef: identity,
          detailsUrl: link.nullable(),
        })
        .nullable(),
      pending: z
        .array(
          z.object({
            id: identity,
            sourceRef: identity,
            status: FactoryStatusSchema,
          }),
        )
        .max(100),
      latestRelease: z
        .object({ version: identity, url: link, publishedAt: timestamp, verifiedAt: timestamp })
        .nullable(),
    }),
    exceptions: z.array(z.object({ id: identity, title: text, detail: text })).max(20),
    coverage: z.object({ work: coverage, issues: coverage, builds: coverage }),
    capabilities: z.object({
      install: z.boolean(),
      pause: z.boolean(),
      resume: z.boolean(),
      stop: z.boolean(),
      takeover: z.boolean(),
      disable: z.boolean(),
      cleanup: z.boolean(),
    }),
  })
  .superRefine((value, ctx) => {
    const roles = value.coordinators.map((coordinator) => coordinator.role);
    if (new Set(roles).size !== roles.length)
      ctx.addIssue({
        code: "custom",
        path: ["coordinators"],
        message: "Coordinator roles must be unique",
      });
  });

export type FactorySnapshot = z.infer<typeof FactorySnapshotSchema>;

export const factorySnapshot = defineRpc({
  name: "factory.snapshot",
  input: z.object({ projectId: identity }),
  output: FactorySnapshotSchema,
});

export const ActivityReceiptSchema = z
  .object({
    id: identity,
    projectId: identity,
    workspaceId: identity.nullable(),
    agentId: identity.nullable(),
    installationId: identity.nullable(),
    kind: z.enum(["thread_status", "merge", "publication"]),
    status: FactoryStatusSchema,
    occurredAt: timestamp,
    observedAt: timestamp,
    verifiedAt: timestamp.nullable(),
    provenance: z.object({
      source: z.enum(["native_agent", "factory_controller", "external"]),
      sourceId: identity,
      sourceRevision: identity.nullable(),
    }),
    delivery: z
      .object({
        repository: identity,
        sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
        deliveryId: identity,
        url: link,
      })
      .nullable(),
    verification: z.object({
      state: z.enum(["observed", "verified"]),
      reason: text.nullable(),
    }),
    summary: text,
    url: link.nullable(),
  })
  .superRefine((value, ctx) => {
    const deliveryKind = value.kind === "merge" || value.kind === "publication";
    if (deliveryKind && value.delivery === null)
      ctx.addIssue({
        code: "custom",
        path: ["delivery"],
        message: "Delivery identity is required",
      });
    if (value.verification.state === "verified") {
      if (
        value.verifiedAt === null ||
        value.delivery === null ||
        !deliveryKind ||
        value.provenance.source === "native_agent"
      )
        ctx.addIssue({
          code: "custom",
          path: ["verification"],
          message: "Verified shipment requires independent delivery evidence and timestamp",
        });
    }
  });

export const ActivityReceiptsSchema = z
  .object({
    schemaVersion: z.literal(1),
    producer: z.object({ serverId: identity, pluginId: z.literal("factory") }),
    observedAt: timestamp,
    availability: z.enum(["available", "unavailable"]),
    coverage: z.object({
      from: timestamp.nullable(),
      to: timestamp,
      complete: z.boolean(),
      gaps: z.array(text).max(20),
      cursorState: z.enum(["initial", "valid", "expired"]),
    }),
    receipts: z.array(ActivityReceiptSchema).max(100).nullable(),
    nextCursor: z.string().max(2000).nullable(),
  })
  .superRefine((value, ctx) => {
    const unavailable = value.availability === "unavailable";
    if (
      unavailable &&
      (value.receipts !== null || value.nextCursor !== null || value.coverage.complete)
    )
      ctx.addIssue({
        code: "custom",
        message: "Unavailable receipts must be null with incomplete coverage and no cursor",
      });
    if (!unavailable && value.receipts === null)
      ctx.addIssue({
        code: "custom",
        path: ["receipts"],
        message: "Available receipts must be an array",
      });
    if (
      value.coverage.cursorState === "expired" &&
      (value.coverage.complete || value.coverage.gaps.length === 0)
    )
      ctx.addIssue({
        code: "custom",
        path: ["coverage"],
        message: "Expired cursors require explicit incomplete coverage and gaps",
      });
    if (
      value.coverage.from !== null &&
      Date.parse(value.coverage.from) > Date.parse(value.coverage.to)
    )
      ctx.addIssue({
        code: "custom",
        path: ["coverage"],
        message: "Coverage start must precede its end",
      });
  });

export type ActivityReceipt = z.infer<typeof ActivityReceiptSchema>;
export type ActivityReceipts = z.infer<typeof ActivityReceiptsSchema>;

export const activityReceipts = defineRpc({
  name: "activity.receipts",
  input: z.object({
    projectId: identity.nullable(),
    cursor: z.string().max(2000).nullable(),
    limit: z.number().int().min(1).max(100),
  }),
  output: ActivityReceiptsSchema,
});
