import { z } from "zod";

/**
 * The AgentSession contract carried over the session host protocol. A worker built from a later
 * release may drive a host from an earlier one, so any incompatible change here requires bumping
 * SESSION_HOST_PROTOCOL_VERSION.
 */

const IdSchema = z.string().min(1).max(500);
const JsonSchema = z.json();
const JsonObjectSchema = z.record(z.string(), JsonSchema);
const ProviderSchema = z.string().min(1).max(200);

const PromptBlockSchema = z.looseObject({ type: z.string().min(1).max(100) });
export const HostedPromptSchema = z.union([z.string(), z.array(PromptBlockSchema).max(1_000)]);

export const HostedPersistenceHandleSchema = z
  .object({
    provider: ProviderSchema,
    sessionId: IdSchema,
    nativeHandle: z.string().max(2_000).optional(),
    metadata: JsonObjectSchema.optional(),
  })
  .strict();

const RunOptionsShape = {
  origin: z.literal("agent").optional(),
  queuedMessage: JsonSchema.optional(),
  intent: z.literal("goal").optional(),
  outputSchema: JsonSchema.optional(),
  resumeFrom: HostedPersistenceHandleSchema.optional(),
  maxThinkingTokens: z.number().int().positive().optional(),
  clientMessageId: IdSchema.optional(),
};
export const HostedRunOptionsSchema = z.object(RunOptionsShape).strict();
export const HostedSteerOptionsSchema = z
  .object({
    ...RunOptionsShape,
    expectedTurnId: IdSchema,
    clearPendingPermissions: z.boolean().optional(),
  })
  .strict();

const PermissionResponseSchema = z.discriminatedUnion("behavior", [
  z
    .object({
      behavior: z.literal("allow"),
      selectedActionId: z.string().max(500).optional(),
      updatedInput: JsonObjectSchema.optional(),
      updatedPermissions: z.array(JsonObjectSchema).optional(),
    })
    .strict(),
  z
    .object({
      behavior: z.literal("deny"),
      selectedActionId: z.string().max(500).optional(),
      message: z.string().max(20_000).optional(),
      interrupt: z.boolean().optional(),
    })
    .strict(),
]);

const MessageTargetSchema = { messageId: IdSchema };

/** Every AgentSession operation a worker can ask the host to perform. */
export const SessionCallSchema = z.discriminatedUnion("method", [
  z
    .object({
      method: z.literal("startTurn"),
      prompt: HostedPromptSchema,
      options: HostedRunOptionsSchema.optional(),
    })
    .strict(),
  z
    .object({
      method: z.literal("steerActiveTurn"),
      prompt: HostedPromptSchema,
      options: HostedSteerOptionsSchema,
    })
    .strict(),
  z.object({ method: z.literal("interrupt") }).strict(),
  z
    .object({
      method: z.literal("respondToPermission"),
      requestId: IdSchema,
      response: PermissionResponseSchema,
    })
    .strict(),
  z.object({ method: z.literal("setMode"), modeId: IdSchema }).strict(),
  z.object({ method: z.literal("setModel"), modelId: IdSchema.nullable() }).strict(),
  z
    .object({ method: z.literal("setThinkingOption"), thinkingOptionId: IdSchema.nullable() })
    .strict(),
  z.object({ method: z.literal("setFeature"), featureId: IdSchema, value: JsonSchema }).strict(),
  z.object({ method: z.literal("getRuntimeInfo") }).strict(),
  z.object({ method: z.literal("getAvailableModes") }).strict(),
  z.object({ method: z.literal("getCurrentMode") }).strict(),
  z.object({ method: z.literal("listCommands") }).strict(),
  /** History is paged so a long conversation never exceeds one frame. */
  z
    .object({
      method: z.literal("streamHistory"),
      cursor: z.number().int().nonnegative(),
    })
    .strict(),
  z.object({ method: z.literal("revertConversation"), ...MessageTargetSchema }).strict(),
  z.object({ method: z.literal("revertFiles"), ...MessageTargetSchema }).strict(),
  z.object({ method: z.literal("revertBoth"), ...MessageTargetSchema }).strict(),
  /** Goals (phase 2): the provider's goal state lives with the provider, so reads and writes cross. */
  z.object({ method: z.literal("goalsRead") }).strict(),
  z.object({ method: z.literal("goalsSet"), input: JsonObjectSchema }).strict(),
  z.object({ method: z.literal("goalsClear") }).strict(),
  /**
   * A slash command the provider handles without a model turn, such as Codex's /compact or /goal.
   * The host runs the provider's handler and returns the events it emitted.
   */
  z.object({ method: z.literal("outOfBand"), prompt: z.string().max(100_000) }).strict(),
  z.object({ method: z.literal("close") }).strict(),
]);
export type SessionHostCall = z.infer<typeof SessionCallSchema>;
export type SessionHostMethod = SessionHostCall["method"];

const ProviderNoticeSchema = z.looseObject({ type: z.string().min(1).max(100) });
const ModeSchema = z.looseObject({ id: z.string(), label: z.string() });

export const RuntimeInfoSchema = z.looseObject({
  provider: ProviderSchema,
  sessionId: z.string().nullable(),
  model: z.string().nullable().optional(),
  thinkingOptionId: z.string().nullable().optional(),
  modeId: z.string().nullable().optional(),
  extra: JsonObjectSchema.optional(),
});

export const HistoryPageSchema = z
  .object({
    events: z.array(JsonSchema),
    nextCursor: z.number().int().nonnegative().nullable(),
  })
  .strict();
export type HistoryPage = z.infer<typeof HistoryPageSchema>;

/** The result each method must produce; the host and the worker both check it. */
export const SessionCallResultSchemas = {
  startTurn: z.object({ turnId: IdSchema }).strict(),
  steerActiveTurn: z.object({ status: z.enum(["accepted", "unavailable"]) }).strict(),
  interrupt: z.null(),
  respondToPermission: z
    .object({ followUpPrompt: HostedPromptSchema.optional() })
    .strict()
    .nullable(),
  setMode: ProviderNoticeSchema.nullable(),
  setModel: z.null(),
  setThinkingOption: ProviderNoticeSchema.nullable(),
  setFeature: z.null(),
  getRuntimeInfo: RuntimeInfoSchema,
  getAvailableModes: z.array(ModeSchema),
  getCurrentMode: z.string().nullable(),
  listCommands: z.array(
    z.looseObject({ name: z.string(), description: z.string(), argumentHint: z.string() }),
  ),
  streamHistory: HistoryPageSchema,
  revertConversation: z.null(),
  revertFiles: z.null(),
  revertBoth: z.null(),
  goalsRead: JsonObjectSchema,
  goalsSet: JsonObjectSchema,
  goalsClear: JsonObjectSchema,
  outOfBand: z
    .object({
      /** False when the provider does not treat this prompt as a command; nothing ran. */
      handled: z.boolean(),
      intent: z.literal("goal").optional(),
      /** Stream events the handler emitted, for the worker to dispatch as its own. */
      events: z.array(JsonSchema).max(1_000),
    })
    .strict(),
  close: z.null(),
} satisfies Record<SessionHostMethod, z.ZodType>;

export type SessionCallResult<M extends SessionHostMethod> = z.infer<
  (typeof SessionCallResultSchemas)[M]
>;

/** Checks a call result against its method contract. */
export function parseCallResult<M extends SessionHostMethod>(
  method: M,
  value: unknown,
): { success: true; data: SessionCallResult<M> } | { success: false } {
  const parsed = SessionCallResultSchemas[method].safeParse(value);
  return parsed.success
    ? { success: true, data: parsed.data as SessionCallResult<M> }
    : { success: false };
}

const PermissionRequestSchema = z.looseObject({
  id: IdSchema,
  provider: ProviderSchema,
  name: z.string(),
  kind: z.enum(["tool", "plan", "question", "mode", "other"]),
});

const FeatureSchema = z.looseObject({ id: z.string(), type: z.string() });

/**
 * Provider state the worker reads synchronously. The host returns it with every attach and
 * records a state entry whenever it changes, so the worker's copy follows event order.
 */
export const HostedSessionSnapshotSchema = z
  .object({
    id: z.string().nullable(),
    persistence: HostedPersistenceHandleSchema.nullable(),
    pendingPermissions: z.array(PermissionRequestSchema),
    features: z.array(FeatureSchema),
    /** The foreground or autonomous turn the provider is running, if any. */
    activeTurnId: z.string().nullable(),
    /**
     * Phase 2 additions, optional so a phase 1 host still attaches. Goal state is present only
     * when the provider session supports goals; capabilities are the session's own, which can
     * differ from its client's (Codex reports goal support per session).
     */
    goals: JsonObjectSchema.nullable().optional(),
    capabilities: JsonObjectSchema.optional(),
  })
  .strict();
export type HostedSessionSnapshot = z.infer<typeof HostedSessionSnapshotSchema>;

const TurnIdSchema = z.string().max(500).optional();

/**
 * Structural checks for provider stream events. The original value is forwarded when it passes,
 * so fields this release does not know survive unchanged. An event type this release does not
 * know, as when a worker is rolled back behind its host, is skipped with one lossy notice per
 * attachment instead of failing the session.
 */
export const HostedStreamEventSchema = z.discriminatedUnion("type", [
  z.looseObject({ type: z.literal("goal_changed"), provider: ProviderSchema, state: JsonSchema }),
  z.looseObject({
    type: z.literal("thread_started"),
    sessionId: z.string(),
    provider: ProviderSchema,
  }),
  z.looseObject({
    type: z.literal("turn_started"),
    provider: ProviderSchema,
    turnId: TurnIdSchema,
  }),
  z.looseObject({
    type: z.literal("turn_completed"),
    provider: ProviderSchema,
    usage: JsonObjectSchema.optional(),
    turnId: TurnIdSchema,
  }),
  z.looseObject({
    type: z.literal("usage_updated"),
    provider: ProviderSchema,
    usage: JsonObjectSchema,
    turnId: TurnIdSchema,
  }),
  z.looseObject({
    type: z.literal("mode_changed"),
    provider: ProviderSchema,
    currentModeId: z.string().nullable(),
    availableModes: z.array(ModeSchema),
  }),
  z.looseObject({
    type: z.literal("model_changed"),
    provider: ProviderSchema,
    runtimeInfo: RuntimeInfoSchema,
  }),
  z.looseObject({
    type: z.literal("thinking_option_changed"),
    provider: ProviderSchema,
    thinkingOptionId: z.string().nullable(),
  }),
  z.looseObject({
    type: z.literal("turn_failed"),
    provider: ProviderSchema,
    error: z.string(),
    code: z.string().optional(),
    diagnostic: z.string().optional(),
    turnId: TurnIdSchema,
  }),
  z.looseObject({
    type: z.literal("turn_canceled"),
    provider: ProviderSchema,
    reason: z.string(),
    turnId: TurnIdSchema,
  }),
  z.looseObject({
    type: z.literal("timeline"),
    item: z.looseObject({ type: z.string().min(1) }),
    provider: ProviderSchema,
    turnId: TurnIdSchema,
    timestamp: z.string().optional(),
  }),
  z.looseObject({
    type: z.literal("permission_requested"),
    provider: ProviderSchema,
    request: PermissionRequestSchema,
    turnId: TurnIdSchema,
  }),
  z.looseObject({
    type: z.literal("permission_resolved"),
    provider: ProviderSchema,
    requestId: z.string(),
    resolution: z.looseObject({ behavior: z.enum(["allow", "deny"]) }),
    turnId: TurnIdSchema,
  }),
  z.looseObject({
    type: z.literal("attention_required"),
    provider: ProviderSchema,
    reason: z.enum(["finished", "error", "permission"]),
    timestamp: z.string(),
  }),
  z.looseObject({
    type: z.literal("provider_subagent"),
    provider: ProviderSchema,
    event: JsonObjectSchema,
  }),
]);

/** What a hosted AgentSession port records in the session's event log. */
export const HostedPortEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("stream"), event: JsonSchema }).strict(),
  z.object({ type: z.literal("state"), snapshot: HostedSessionSnapshotSchema }).strict(),
]);
export type HostedPortEvent = z.infer<typeof HostedPortEventSchema>;

/**
 * Everything the host needs to construct a provider session. The environment may carry
 * credentials: it lives only in host memory and is never logged or persisted.
 */
export const HostedOpenRequestSchema = z
  .object({
    kind: z.enum(["create", "resume"]),
    agentId: IdSchema.optional(),
    config: z.looseObject({ provider: ProviderSchema, cwd: z.string().min(1) }),
    launchEnv: z.record(z.string(), z.string()).optional(),
    runtimeSettings: JsonObjectSchema.optional(),
    persistSession: z.boolean().optional(),
    handle: HostedPersistenceHandleSchema.optional(),
    overrides: JsonObjectSchema.optional(),
    /** A derived provider (an account), so the host builds the same client the worker would. */
    customProvider: z
      .object({ id: ProviderSchema, label: z.string().max(200), extends: ProviderSchema })
      .strict()
      .optional(),
  })
  .strict();
export type HostedOpenRequest = z.infer<typeof HostedOpenRequestSchema>;
