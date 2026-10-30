import { z } from "zod";

// Owner-only installation upgrades and safety snapshots, served under
// /api/installation/owner/. Older coordinators return 404 for these routes.

/**
 * Releases are the tags `scripts/vorteo-release.mjs` creates: `release-<counter>` for stable
 * and `release-<counter>-beta` for beta. See docs/release.md#vorteo-releases.
 */
export const ReleaseTagSchema = z
  .string()
  .regex(/^release-[1-9]\d*(?:-beta)?$/, "Release tags look like release-940 or release-940-beta");
export type ReleaseTag = z.infer<typeof ReleaseTagSchema>;

const CommitSchema = z.string().regex(/^[a-f0-9]{40}$/);

/** What a snapshot captured. Each part is restored as a whole. */
export const SnapshotPartKindSchema = z.enum([
  "coordinator-state",
  "host-home",
  "dev-home",
  "deployment",
]);
export type SnapshotPartKind = z.infer<typeof SnapshotPartKindSchema>;

export const SNAPSHOT_PART_LABELS: Record<SnapshotPartKind, string> = {
  "coordinator-state": "Installation coordinator state",
  "host-home": "Host daemon home",
  "dev-home": "Dev container home",
  deployment: "Deployment files",
};

export const SnapshotPartSchema = z.object({
  kind: SnapshotPartKindSchema,
  /** Where the part came from: an absolute path, or `docker:<container>:<path>`. */
  source: z.string().min(1),
  files: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
});
export type SnapshotPart = z.infer<typeof SnapshotPartSchema>;

/** The manifest written beside every snapshot as `manifest.json`. */
export const InstallationSnapshotSchema = z.object({
  version: z.literal(1),
  /** Directory name under the snapshot root, derived from the creation time. */
  id: z.string().regex(/^\d{8}T\d{6}(?:\d{3})?Z(?:-\d+)?$/),
  createdAt: z.string().datetime(),
  reason: z.enum(["upgrade", "owner", "restore"]),
  upgradeId: z.string().uuid().optional(),
  release: ReleaseTagSchema.optional(),
  parts: z.array(SnapshotPartSchema),
});
export type InstallationSnapshot = z.infer<typeof InstallationSnapshotSchema>;

export const SnapshotRestoreStatusSchema = z.object({
  id: z.string().uuid(),
  snapshotId: InstallationSnapshotSchema.shape.id,
  status: z.enum(["running", "succeeded", "failed"]),
  /** The step now running, or the last step reached. */
  step: z.string(),
  detail: z.string(),
  startedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type SnapshotRestoreStatus = z.infer<typeof SnapshotRestoreStatusSchema>;

/** Reply to POST /api/installation/owner/snapshots/query. */
export const SnapshotListSchema = z.object({
  available: z.boolean(),
  /** Why snapshots are unavailable, or where they are kept. */
  detail: z.string(),
  retention: z.number().int().positive(),
  snapshots: z.array(InstallationSnapshotSchema),
  restore: SnapshotRestoreStatusSchema.nullable(),
});
export type SnapshotList = z.infer<typeof SnapshotListSchema>;

/**
 * POST /api/installation/owner/snapshots/restore. `parts` must repeat exactly the
 * part kinds the confirmation named, so a changed snapshot cannot be restored blind.
 */
export const SnapshotRestoreRequestSchema = z.strictObject({
  id: InstallationSnapshotSchema.shape.id,
  parts: z.array(SnapshotPartKindSchema).min(1),
});
export type SnapshotRestoreRequest = z.infer<typeof SnapshotRestoreRequestSchema>;

export const UpgradeStepNameSchema = z.enum(["snapshot", "fetch", "host", "coordinator", "dev"]);
export type UpgradeStepName = z.infer<typeof UpgradeStepNameSchema>;

export const UPGRADE_STEP_LABELS: Record<UpgradeStepName, string> = {
  snapshot: "Take a safety snapshot",
  fetch: "Fetch the release",
  host: "Build the release and restart the Host daemon",
  coordinator: "Replace the installation coordinator",
  dev: "Rebuild and recreate the Dev container",
};

export const UpgradeStepSchema = z.object({
  name: UpgradeStepNameSchema,
  status: z.enum(["pending", "running", "succeeded", "failed", "skipped", "rolled-back"]),
  detail: z.string(),
  startedAt: z.string().datetime().optional(),
  finishedAt: z.string().datetime().optional(),
});
export type UpgradeStep = z.infer<typeof UpgradeStepSchema>;

export const InstallationUpgradeSchema = z.object({
  id: z.string().uuid(),
  /** Changes on every transition; decisions must name the revision they reviewed. */
  revision: z.string().uuid(),
  release: ReleaseTagSchema,
  /** The commit the tag named when the owner reviewed it. Fetching must match it. */
  sourceCommit: CommitSchema,
  /** The installed Host source when the upgrade was requested. */
  previousCommit: CommitSchema.nullable(),
  createdAt: z.string().datetime(),
  status: z.enum([
    "pending",
    "approved",
    "running",
    "succeeded",
    "failed",
    "rejected",
    "cancelled",
  ]),
  detail: z.string(),
  approvedAt: z.string().datetime().optional(),
  snapshotId: InstallationSnapshotSchema.shape.id.optional(),
  steps: z.array(UpgradeStepSchema),
});
export type InstallationUpgrade = z.infer<typeof InstallationUpgradeSchema>;

/** Reply to POST /api/installation/owner/upgrades/query. */
export const UpgradeStatusSchema = z.object({
  available: z.boolean(),
  /** Why upgrades are unavailable, or what an upgrade will replace. */
  detail: z.string(),
  repository: z.string(),
  current: z
    .object({
      sourceCommit: CommitSchema,
      release: ReleaseTagSchema.nullable(),
    })
    .nullable(),
  container: z.boolean(),
  upgrades: z.array(InstallationUpgradeSchema),
});
export type UpgradeStatus = z.infer<typeof UpgradeStatusSchema>;

/** POST /api/installation/owner/upgrades creates a pending upgrade for owner review. */
export const UpgradeRequestSchema = z.strictObject({ release: ReleaseTagSchema });
export type UpgradeRequest = z.infer<typeof UpgradeRequestSchema>;

/** POST /api/installation/owner/upgrades/:id/decision. */
export const UpgradeDecisionSchema = z.strictObject({
  revision: z.string().uuid(),
  decision: z.enum(["approve", "reject", "cancel"]),
});
export type UpgradeDecision = z.infer<typeof UpgradeDecisionSchema>;
