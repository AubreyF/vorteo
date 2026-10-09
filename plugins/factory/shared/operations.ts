import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const identity = z
  .string()
  .min(1)
  .max(200)
  .regex(/^\S(?:.*\S)?$/);
const reason = z.string().min(1).max(2000).regex(/\S/);
const timestamp = z.iso.datetime();

export const FactorySetupSchema = z
  .object({
    schemaVersion: z.literal(1),
    serverId: identity,
    projectId: identity,
    installationId: identity.nullable(),
    revision: identity.nullable(),
    observedAt: timestamp.nullable(),
    state: z.enum(["ready", "installed", "held", "unavailable"]),
    reason: reason.nullable(),
    operations: z.object({
      install: z.boolean(),
      pause: z.literal(false),
      resume: z.literal(false),
      stop: z.literal(false),
      disable: z.literal(false),
    }),
  })
  .superRefine((value, ctx) => {
    if (value.operations.install) {
      const canInstall =
        value.state === "ready" &&
        value.installationId === null &&
        value.revision !== null &&
        value.observedAt !== null;
      if (!canInstall)
        ctx.addIssue({
          code: "custom",
          path: ["operations", "install"],
          message: "Installation requires a fresh ready initial setup precondition",
        });
    }
    if (value.state === "installed" && value.installationId === null)
      ctx.addIssue({
        code: "custom",
        path: ["installationId"],
        message: "Installed setup requires an installation identity",
      });
    const needsReason = value.state === "held" || value.state === "unavailable";
    if (needsReason && value.reason === null)
      ctx.addIssue({ code: "custom", path: ["reason"], message: "Setup requires a hold reason" });
  });

export type FactorySetup = z.infer<typeof FactorySetupSchema>;

export const factorySetup = defineRpc({
  name: "factory.setup",
  input: z.strictObject({ projectId: identity }),
  output: FactorySetupSchema,
});

export const FactoryInstallInputSchema = z.strictObject({
  projectId: identity,
  expectedServerId: identity,
  expectedInstallationId: identity.nullable(),
  expectedRevision: identity,
  operationId: identity,
});

const resultIdentity = {
  schemaVersion: z.literal(1),
  serverId: identity,
  projectId: identity,
  operationId: identity,
};

export const FactoryInstallResultSchema = z
  .discriminatedUnion("outcome", [
    z.object({
      ...resultIdentity,
      outcome: z.literal("applied"),
      installationId: identity,
      observedAt: timestamp,
      setup: FactorySetupSchema,
    }),
    z.object({
      ...resultIdentity,
      outcome: z.literal("refused"),
      code: z.enum(["unavailable", "precondition_changed", "identity_mismatch", "held"]),
      reason,
    }),
    z.object({
      ...resultIdentity,
      outcome: z.literal("uncertain"),
      installationId: identity.nullable(),
      reason,
      reconciliationRequired: z.literal(true),
    }),
  ])
  .superRefine((value, ctx) => {
    if (value.outcome !== "applied") return;
    const matches =
      value.setup.serverId === value.serverId &&
      value.setup.projectId === value.projectId &&
      value.setup.installationId === value.installationId &&
      value.setup.state === "installed";
    if (!matches)
      ctx.addIssue({
        code: "custom",
        path: ["setup"],
        message: "Applied setup must identify the same installed host, project and installation",
      });
  });

export type FactoryInstallInput = z.infer<typeof FactoryInstallInputSchema>;
export type FactoryInstallResult = z.infer<typeof FactoryInstallResultSchema>;

// Definition alone does not advertise an installer or register a mutation handler.
export const factoryInstall = defineRpc({
  name: "factory.install",
  input: FactoryInstallInputSchema,
  output: FactoryInstallResultSchema,
});
