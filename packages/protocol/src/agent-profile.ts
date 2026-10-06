import { SkillPolicySchema } from "./skill-library.js";
import { z } from "zod";
import { QuotaReservePolicySchema } from "./quota-reserve.js";

/**
 * A named launch bundle: a provider plus the agent-config values a client would
 * otherwise set one control at a time. Field names mirror `AgentSessionConfig`
 * so applying a profile is a copy rather than a translation table.
 *
 * Instructions and worker selection are launch-only. Existing sessions retain
 * their launch snapshot rather than resolving a mutable profile on resume.
 */
export const AgentProfileSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    excludedEnvironments: z.array(z.enum(["host", "container"])).optional(),
    nickname: z.string().optional(),
    quotaReservePolicy: QuotaReservePolicySchema.optional(),
    /** A key into the client's icon registry, not a glyph. Unknown keys draw the default. */
    icon: z.string().optional(),
    /** An identity colour name shared with host badges. Unknown values draw unthemed. */
    color: z.string().optional(),
    provider: z.string(),
    model: z.string().optional(),
    modeId: z.string().optional(),
    thinkingOptionId: z.string().optional(),
    featureValues: z.record(z.string(), z.unknown()).optional(),
    /** Free text, surfaced to orchestrating agents by the `list_profiles` MCP tool. */
    notes: z.string().optional(),
    instructions: z.string().optional(),
    skillPolicy: SkillPolicySchema.optional(),
    /** Selected automatically for new Vorton drafts on this host. */
    isDefault: z.boolean().optional(),
    workerProfileId: z.string().optional(),
    maxWorkers: z.number().int().min(1).max(8).optional(),
  })
  .passthrough();

export type AgentProfile = z.infer<typeof AgentProfileSchema>;

export const AgentSkillSelectionSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("all") }).strict(),
  z.object({ mode: z.literal("custom"), skills: z.array(z.string()) }).strict(),
]);
export type AgentSkillSelection = z.infer<typeof AgentSkillSelectionSchema>;
