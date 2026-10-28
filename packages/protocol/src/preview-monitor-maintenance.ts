import { DelegatedMaintenanceApprovalSchema } from "./maintenance-approval.js";
import { z } from "zod";

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const PreparedFileSchema = z.strictObject({
  path: z.string().startsWith("/"),
  sha256: DigestSchema,
});

export const PreviewMonitorPlanSchema = z.strictObject({
  version: z.literal(1),
  operation: z.literal("preview-monitor-replace"),
  installationId: z.string().uuid(),
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
  containerId: DigestSchema,
  destination: z.string().startsWith("/"),
  candidate: PreparedFileSchema,
  previous: PreparedFileSchema,
  ancestrySha256: DigestSchema,
  expected: z.strictObject({
    sha256: DigestSchema,
    uid: z.literal(0),
    gid: z.literal(0),
    mode: z.literal(0o755),
  }),
});

export type PreviewMonitorPlan = z.infer<typeof PreviewMonitorPlanSchema>;
export const PreviewMonitorConfigurationSchema = z.strictObject({
  docker: z.string().startsWith("/"),
  socket: z.string().startsWith("/"),
  containerId: DigestSchema,
  home: z.literal("/home/paseo"),
  worker: PreparedFileSchema,
  recovery: z.strictObject({
    node: PreparedFileSchema,
    journal: PreparedFileSchema,
    queue: PreparedFileSchema,
  }),
});
export type PreviewMonitorConfiguration = z.infer<typeof PreviewMonitorConfigurationSchema>;
export const PreviewMonitorPreparationSchema = z.strictObject({
  id: z.string().uuid(),
  reason: z.string().trim().min(1).max(2000),
  plan: PreviewMonitorPlanSchema,
});
export const PreviewMonitorDecisionSchema = z.strictObject({
  operation: z.literal("preview-monitor-replace"),
  id: z.string().uuid(),
  revision: z.string().uuid(),
  planSha256: DigestSchema,
  decision: z.enum(["approve", "cancel"]),
});
export const PreviewMonitorJobSchema = z.strictObject({
  target: z.literal("preview-monitor"),
  operation: z.literal("preview-monitor-replace"),
  id: z.string().uuid(),
  revision: z.string().uuid(),
  requestedBy: z.literal("host-agent"),
  reason: z.string().min(1).max(2000),
  createdAt: z.string().datetime(),
  approvedAt: z.string().datetime().optional(),
  delegatedApproval: DelegatedMaintenanceApprovalSchema.optional(),
  plan: PreviewMonitorPlanSchema,
  planSha256: DigestSchema,
  status: z.enum(["pending", "approved", "running", "succeeded", "failed", "rejected"]),
  stage: z.enum(["preparing", "prepared", "dispatch_pending", "succeeded", "recovery_required"]),
  detail: z.string(),
});
export type PreviewMonitorJob = z.infer<typeof PreviewMonitorJobSchema>;

export const PreviewMonitorSelectionSchema = z.strictObject({
  containerId: DigestSchema,
  destination: z.literal("/home/paseo/.local/bin/paseo-preview"),
  canonicalPath: z.literal("/home/paseo/.local/bin/paseo-preview"),
  sha256: DigestSchema,
  uid: z.literal(0),
  gid: z.literal(0),
  mode: z.literal(0o755),
  regularFile: z.literal(true),
  links: z.literal(1),
  ancestrySha256: DigestSchema,
});
export type PreviewMonitorSelection = z.infer<typeof PreviewMonitorSelectionSchema>;
