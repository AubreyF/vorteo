import { z } from "zod";

/** Stable setup does not contain its own artifact or manifest digest. Those
 * pins live in the reviewed plan, avoiding a self-referential digest cycle. */
export const MaintenanceLauncherSetupSchema = z.strictObject({
  version: z.literal(1),
  installationRoot: z.string().startsWith("/"),
  enrollmentStateDirectory: z.string().startsWith("/"),
  identitySha256: z.string().regex(/^[a-f0-9]{64}$/),
  target: z.enum(["maintenance-controller", "recovery-launcher"]),
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
  control: z
    .strictObject({
      admissionSha256: z.string().regex(/^[a-f0-9]{64}$/),
      recoveryAccess: z
        .strictObject({
          installationId: z.string().uuid(),
          origin: z.url().refine((value) => {
            const url = new URL(value);
            return url.protocol === "https:" && url.origin === value;
          }),
          listenPort: z.number().int().min(1024).max(65535),
          ownerConfigurationFile: z.string().startsWith("/"),
        })
        .optional(),
    })
    .optional(),
  nativeAdmission: z.strictObject({
    path: z.string().startsWith("/"),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
});

export const MaintenanceOwnerConfigurationSchema = z.object({
  public: z.object({ origin: z.url(), installationId: z.string().uuid() }),
  stateDir: z.string().startsWith("/"),
  ownerPasswordHash: z.string().startsWith("$2"),
});
