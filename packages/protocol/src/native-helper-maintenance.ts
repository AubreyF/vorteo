import { z } from "zod";

export const NativeHelperConfigurationSchema = z.strictObject({
  home: z.string().startsWith("/"),
  docker: z.string().startsWith("/"),
  socket: z.string().startsWith("/"),
  containerId: z.string().regex(/^[a-f0-9]{64}$/),
});

const HelperOperationSchema = z.enum(["native-helper-install", "native-helper-rollback"]);
const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const FileSchema = z.strictObject({
  path: z.string().startsWith("/").min(2).max(4096),
  sha256: DigestSchema,
});
const ReleaseSchema = z.strictObject({
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
  directory: z.string().startsWith("/").min(2).max(4096),
  artifactSha256: DigestSchema,
  signingMode: z.enum(["developer-id", "local"]),
  helperRequirement: z.string().min(1).max(4096),
  clientRequirement: z.string().min(1).max(4096),
});

// Prepared metadata is inert. Filesystem and signature checks belong to admission.
export const NativeHelperPlanSchema = z.strictObject({
  version: z.literal(1),
  operation: HelperOperationSchema,
  installationId: z.string().uuid(),
  recoveryOf: z
    .strictObject({ id: z.string().uuid(), revision: z.string().uuid(), planSha256: DigestSchema })
    .optional(),
  candidate: ReleaseSchema,
  previous: ReleaseSchema.nullable(),
  retainedRollback: z
    .strictObject({
      directory: z.string().startsWith("/").min(2).max(4096),
      artifactSha256: DigestSchema,
    })
    .nullable(),
  tooling: z.strictObject({
    sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
    directory: z.string().startsWith("/").min(2).max(4096),
    artifactSha256: DigestSchema,
    node: FileSchema,
    installer: FileSchema,
    dispatcher: FileSchema,
    invocationClient: FileSchema,
  }),
  destination: z.strictObject({
    application: z.string().startsWith("/").min(2).max(4096),
    runtime: z.string().startsWith("/").min(2).max(4096),
  }),
  expectedState: z.strictObject({
    configurationSha256: DigestSchema.nullable(),
    policySha256: DigestSchema.nullable(),
    installationReceiptSha256: DigestSchema.nullable(),
  }),
});
export type NativeHelperPlan = z.infer<typeof NativeHelperPlanSchema>;

export const NativeHelperPreparationSchema = z.strictObject({
  id: z.string().uuid(),
  reason: z.string().trim().min(1).max(2000),
  plan: NativeHelperPlanSchema,
});
export type NativeHelperPreparation = z.infer<typeof NativeHelperPreparationSchema>;

// A daemon restart decision cannot authorize helper installation.
export const NativeHelperDecisionSchema = z.strictObject({
  operation: HelperOperationSchema,
  id: z.string().uuid(),
  revision: z.string().uuid(),
  planSha256: DigestSchema,
  decision: z.enum(["approve", "cancel"]),
});
export type NativeHelperDecision = z.infer<typeof NativeHelperDecisionSchema>;

export const NativeHelperRecoveryDecisionSchema = z.strictObject({
  operation: z.literal("native-helper-verify-installed"),
  id: z.string().uuid(),
  revision: z.string().uuid(),
  planSha256: DigestSchema,
});

export const NativeHelperProcessIdentitySchema = z.strictObject({
  pid: z.number().int().positive().max(2147483647),
  executable: z.string().startsWith("/"),
  instanceId: z.string().uuid(),
});
export type NativeHelperProcessIdentity = z.infer<typeof NativeHelperProcessIdentitySchema>;

export const NativeHelperInstallerExitSchema = z.strictObject({
  code: z.number().int().min(0).max(255).nullable(),
  signal: z
    .string()
    .regex(/^SIG[A-Z0-9]+$/)
    .nullable(),
});
export type NativeHelperInstallerExit = z.infer<typeof NativeHelperInstallerExitSchema>;

export const NativeHelperJobSchema = z.strictObject({
  target: z.literal("native-helper"),
  operation: HelperOperationSchema,
  id: z.string().uuid(),
  revision: z.string().uuid(),
  requestedBy: z.literal("host-agent"),
  reason: z.string().min(1).max(2000),
  createdAt: z.string().datetime(),
  plan: NativeHelperPlanSchema,
  planSha256: DigestSchema,
  status: z.enum(["pending", "approved", "running", "succeeded", "failed", "rejected"]),
  detail: z.string(),
  recoveredBy: z.string().uuid().optional(),
  recoveryVerifiedAt: z.string().datetime().optional(),
  approvedAt: z.string().datetime().optional(),
  previousProcess: NativeHelperProcessIdentitySchema.nullable().optional(),
  installerExit: NativeHelperInstallerExitSchema.optional(),
  installerPid: z.number().int().positive().max(2147483647).optional(),
  stage: z.enum([
    "preparing",
    "prepared",
    "dispatch_pending",
    "installing",
    "verifying",
    "succeeded",
    "recovery_required",
    "recovered",
  ]),
});
export type NativeHelperJob = z.infer<typeof NativeHelperJobSchema>;
