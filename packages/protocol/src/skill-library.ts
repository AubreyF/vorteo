import { z } from "zod";

export const SkillPolicySchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("inherit"),
    include: z.array(z.string()),
    exclude: z.array(z.string()),
  }),
  z.object({ mode: z.literal("selected"), skills: z.array(z.string()) }),
  z.object({ mode: z.literal("none") }),
]);
export type SkillPolicy = z.infer<typeof SkillPolicySchema>;
export const SkillSnapshotSchema = z.object({
  capturedAt: z.string(),
  provider: z.string(),
  skills: z.array(
    z.object({ identity: z.string(), name: z.string(), path: z.string(), sha256: z.string() }),
  ),
});
export type SkillSnapshot = z.infer<typeof SkillSnapshotSchema>;

export const SkillFileSchema = z.object({
  path: z.string(),
  sha256: z.string(),
  bytes: z.number(),
});
export const SkillSourceSchema = z.object({
  repository: z.string(),
  revision: z.string().regex(/^[a-f0-9]{40}$/),
  directory: z.string(),
});
export type SkillSource = z.infer<typeof SkillSourceSchema>;
export const SkillPackageSchema = z.strictObject({
  name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  source: SkillSourceSchema.nullable(),
  files: z
    .array(
      z.strictObject({
        path: z.string().min(1),
        content: z.string().max(5592408),
        executable: z.boolean(),
      }),
    )
    .min(1)
    .max(256),
});
export type SkillPackage = z.infer<typeof SkillPackageSchema>;
export const InstallationSkillSchema = SkillPackageSchema.omit({ files: true }).extend({
  identity: z.string().min(1),
});
export type InstallationSkill = z.infer<typeof InstallationSkillSchema>;
export const SkillInstallationSchema = z.object({
  id: z.string(),
  identity: z.string(),
  name: z.string(),
  description: z.string(),
  path: z.string(),
  resolvedPath: z.string().nullable(),
  owner: z.enum(["personal", "project", "provider", "plugin", "vorteo"]),
  providers: z.array(z.string()),
  sha256: z.string().nullable(),
  files: z.array(SkillFileSchema),
  issues: z.array(z.string()),
  source: SkillSourceSchema.nullable(),
  managed: z.boolean(),
  discovery: z.literal("filesystem"),
});
export type SkillInstallation = z.infer<typeof SkillInstallationSchema>;
export const SkillInventorySchema = z.object({
  observedAt: z.string(),
  skills: z.array(SkillInstallationSchema),
  roots: z.array(
    z.object({
      path: z.string(),
      status: z.enum(["scanned", "missing", "error"]),
      error: z.string().nullable(),
    }),
  ),
  limitations: z.array(z.string()),
});
export type SkillInventory = z.infer<typeof SkillInventorySchema>;
export const SkillChangeSchema = z.object({
  path: z.string(),
  before: z.string().nullable(),
  after: z.string().nullable(),
});
export const SkillPreviewSchema = z.object({
  id: z.string(),
  name: z.string(),
  action: z.enum(["install", "remove", "restore", "consolidate", "link"]),
  source: SkillSourceSchema.nullable(),
  target: z.string(),
  beforeHash: z.string().nullable(),
  afterHash: z.string().nullable(),
  changes: z.array(SkillChangeSchema),
  createdAt: z.string(),
});
export type SkillPreview = z.infer<typeof SkillPreviewSchema>;
export const SkillAuditSchema = z.object({
  id: z.string(),
  at: z.string(),
  action: z.string(),
  target: z.string(),
  beforeHash: z.string().nullable(),
  afterHash: z.string().nullable(),
  source: SkillSourceSchema.nullable(),
});
export type SkillAudit = z.infer<typeof SkillAuditSchema>;

export const SkillLibraryReadSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("package"), id: z.string() }),
  z.object({ kind: z.literal("inventory"), cwd: z.string().optional() }),
  z.object({ kind: z.literal("detail"), id: z.string(), cwd: z.string().optional() }),
  z.object({ kind: z.literal("audit") }),
]);
export const SkillLibraryChangeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("preview_import"), package: SkillPackageSchema }),
  z.object({
    kind: z.literal("preview_link"),
    id: z.string(),
    provider: z.enum(["claude", "codex"]),
  }),
  z.object({ kind: z.literal("preview_install"), source: SkillSourceSchema }),
  z.object({ kind: z.literal("preview_remove"), id: z.string() }),
  z.object({ kind: z.literal("preview_restore"), auditId: z.string() }),
  z.object({ kind: z.literal("preview_consolidate"), id: z.string(), canonicalId: z.string() }),
  z.object({ kind: z.literal("apply"), previewId: z.string() }),
]);
export type SkillLibraryRead = z.infer<typeof SkillLibraryReadSchema>;
export type SkillLibraryChange = z.infer<typeof SkillLibraryChangeSchema>;
export const SkillLibraryResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("package"), package: SkillPackageSchema }),
  z.object({ kind: z.literal("inventory"), inventory: SkillInventorySchema }),
  z.object({ kind: z.literal("detail"), skill: SkillInstallationSchema, instructions: z.string() }),
  z.object({ kind: z.literal("audit"), entries: z.array(SkillAuditSchema) }),
  z.object({ kind: z.literal("preview"), preview: SkillPreviewSchema }),
  z.object({ kind: z.literal("applied"), entry: SkillAuditSchema }),
]);
export type SkillLibraryResult = z.infer<typeof SkillLibraryResultSchema>;
