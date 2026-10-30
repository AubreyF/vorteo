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
 * Host-owned Codex sign-in: the Host account's own CODEX_HOME keeps the only refresh grant and
 * the official Host Codex is its only refresh writer. Dev receives access-only projections in
 * its account's `auth.json`. Codex reloads that file before it tries a refresh after a rejected
 * request, so a newer projection reaches running Dev agents without a Dev refresh.
 *
 * Strict: a `refreshToken` field fails validation and the delivery is refused.
 */
export const CodexAccessProjectionSchema = z.strictObject({
  accessToken: z.string().min(1).max(65536),
  /** Codex reads the plan and account from this JWT; it is not a refresh credential. */
  idToken: z.string().min(1).max(65536),
  accountId: z.string().min(1).max(256).nullable(),
  /** The access token's own expiry, in milliseconds. */
  expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  /** The Host's `last_refresh`, copied so Dev never believes its copy is newer. */
  lastRefresh: z.string().datetime({ offset: true }).nullable(),
});
export type CodexAccessProjection = z.infer<typeof CodexAccessProjectionSchema>;

/** Daemon routes, behind daemon bearer authentication. */
export const CODEX_SIGNIN_BINDING_ROUTE = "/api/installation/codex/signin/binding";
export const CODEX_SIGNIN_PROJECTION_ROUTE = "/api/installation/codex/signin/projection";

export const CodexSignInBindingRequestSchema = ProjectionBindingRequestSchema;
export type CodexSignInBindingRequest = z.infer<typeof CodexSignInBindingRequestSchema>;
/** The binding's exact CODEX_HOME on the Host. Never a credential. */
export const CodexSignInBindingResponseSchema = z.strictObject({
  providerId: z.string().min(1),
  codexHome: z.string().startsWith("/"),
});

export const CodexSignInProjectionDeliverySchema = projectionDeliverySchema(
  CodexAccessProjectionSchema,
);
export type CodexSignInProjectionDelivery = z.infer<typeof CodexSignInProjectionDeliverySchema>;
export const CodexSignInProjectionReceiptSchema = ProjectionReceiptSchema;
export type CodexSignInProjectionReceipt = HostProjectionReceipt;

export class CodexSignInDeliveryError extends Error {
  constructor() {
    super("Codex sign-in synchronization is pending. Retry after reconnecting the environment.");
  }
}

/** Key order is fixed so the coordinator and Dev compute the same digest. */
export function codexProjectionDigest(access: CodexAccessProjection | null): string {
  const canonical = access && {
    accessToken: access.accessToken,
    idToken: access.idToken,
    accountId: access.accountId,
    expiresAt: access.expiresAt,
    lastRefresh: access.lastRefresh,
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/** One serialized writer per Dev binding. Its journal holds digests, never tokens. */
export class CodexSignInProjectionService extends HostProjectionService<CodexAccessProjection> {
  constructor(ports: HostProjectionPorts<CodexAccessProjection>) {
    super(ports, {
      schema: CodexSignInProjectionDeliverySchema,
      digest: codexProjectionDigest,
      error: () => new CodexSignInDeliveryError(),
    });
  }
}
