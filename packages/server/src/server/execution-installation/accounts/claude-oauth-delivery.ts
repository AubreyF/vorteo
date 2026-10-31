import { createHash } from "node:crypto";
import { z } from "zod";
import {
  HostProjectionService,
  ProjectionBindingRequestSchema,
  ProjectionReceiptSchema,
  projectionDeliverySchema,
  type HostProjectionPorts,
  type HostProjectionReceipt,
} from "./host-owned-projection.js";

/**
 * Host-owned Claude refresh: the Host account's own CLI store keeps the only grant and the
 * official Host CLI is the only refresh writer. Dev receives access-only projections, which
 * its CLI re-reads from `.credentials.json` before each request. A projection never carries a
 * refresh token: without one the Dev CLI never refreshes or persists tokens itself.
 *
 * Strict: a `refreshToken` field fails validation and the delivery is refused.
 */
export const ClaudeAccessProjectionSchema = z.strictObject({
  accessToken: z.string().min(1).max(8192),
  expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  scopes: z.array(z.string().min(1).max(256)).max(64),
  subscriptionType: z.string().min(1).max(256).optional(),
  rateLimitTier: z.string().min(1).max(256).optional(),
});
export type ClaudeAccessProjection = z.infer<typeof ClaudeAccessProjectionSchema>;

export const ClaudeOAuthBindingRequestSchema = ProjectionBindingRequestSchema;
export type ClaudeOAuthBindingRequest = z.infer<typeof ClaudeOAuthBindingRequestSchema>;
/** The exact raw CLAUDE_CONFIG_DIR string: the CLI derives its macOS Keychain item from it. */
export const ClaudeOAuthBindingResponseSchema = z.strictObject({
  providerId: z.string().min(1),
  configDir: z.string().startsWith("/"),
});

export const ClaudeOAuthProjectionDeliverySchema = projectionDeliverySchema(
  ClaudeAccessProjectionSchema,
);
export type ClaudeOAuthProjectionDelivery = z.infer<typeof ClaudeOAuthProjectionDeliverySchema>;
export const ClaudeOAuthProjectionReceiptSchema = ProjectionReceiptSchema;
export type ClaudeOAuthProjectionReceipt = HostProjectionReceipt;

export class ClaudeOAuthDeliveryError extends Error {
  constructor() {
    super("Claude sign-in synchronization is pending. Retry after reconnecting the environment.");
  }
}

/** Key order is fixed so the coordinator and Dev compute the same digest. */
export function accessProjectionDigest(access: ClaudeAccessProjection | null): string {
  const canonical = access && {
    accessToken: access.accessToken,
    expiresAt: access.expiresAt,
    scopes: access.scopes,
    subscriptionType: access.subscriptionType ?? null,
    rateLimitTier: access.rateLimitTier ?? null,
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export type ClaudeOAuthProjectionPorts = HostProjectionPorts<ClaudeAccessProjection>;

/** One serialized writer per Dev binding. Its journal holds digests, never tokens. */
export class ClaudeOAuthProjectionService extends HostProjectionService<ClaudeAccessProjection> {
  constructor(ports: ClaudeOAuthProjectionPorts) {
    super(ports, {
      schema: ClaudeOAuthProjectionDeliverySchema,
      digest: accessProjectionDigest,
      error: () => new ClaudeOAuthDeliveryError(),
    });
  }
}
