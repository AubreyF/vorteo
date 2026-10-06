import { z } from "zod";
import { PluginRegistryIdentitySchema } from "./plugin-registry.js";
import { PluginIdSchema } from "./plugin-config.js";

export const PluginSourceIdentitySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("directory"), path: z.string() }),
  z.object({
    kind: z.literal("git"),
    remote: z.string(),
    pluginPath: z.string(),
    registry: PluginRegistryIdentitySchema.optional(),
  }),
  z.object({
    kind: z.literal("npm"),
    packageName: z.string(),
    pluginPath: z.string(),
    registry: PluginRegistryIdentitySchema.optional(),
  }),
]);
export const PluginInstallationSchema = z.object({
  identity: PluginSourceIdentitySchema,
  currentRevision: z.string().optional(),
});
export type PluginInstallation = z.infer<typeof PluginInstallationSchema>;
export const PluginUpdateTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("git"), commit: z.string().regex(/^[0-9a-f]{40,64}$/) }),
  z.object({
    kind: z.literal("npm"),
    version: z.string().min(1),
    resolved: z.string().url(),
    integrity: z.string().min(1),
  }),
]);
export type PluginUpdateTarget = z.infer<typeof PluginUpdateTargetSchema>;

export const ResolvedPluginSourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("git"),
    id: PluginIdSchema,
    identity: PluginSourceIdentitySchema.options[1],
    target: PluginUpdateTargetSchema.options[0],
  }),
  z.strictObject({
    kind: z.literal("npm"),
    id: PluginIdSchema,
    identity: PluginSourceIdentitySchema.options[2],
    target: PluginUpdateTargetSchema.options[1],
  }),
]);
export type ResolvedPluginSource = z.infer<typeof ResolvedPluginSourceSchema>;

export const InstallationPluginSchema = z.strictObject({
  id: PluginIdSchema,
  enabled: z.boolean(),
  source: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("directory") }),
    ...ResolvedPluginSourceSchema.options,
  ]),
});
export type InstallationPlugin = z.infer<typeof InstallationPluginSchema>;

export const PluginSourceResolutionInputSchema = z.strictObject({
  source: z.string().min(1),
  ref: z.string().min(1).optional(),
});
export type PluginSourceResolutionInput = z.infer<typeof PluginSourceResolutionInputSchema>;

export const PluginDirectoryBindingSchema = z.strictObject({
  expectedPath: z.string().min(1).nullable(),
  enabled: z.boolean(),
});
export type PluginDirectoryBinding = z.infer<typeof PluginDirectoryBindingSchema>;
