import { accessProjectionDigest, ClaudeOAuthDeliveryError } from "./claude-oauth-delivery.js";
import type { ClaudeAccessProjection } from "./claude-oauth-delivery.js";
import {
  CLAUDE_REFRESH_LEAD_MS,
  claudeAccessProjection,
  needsHostRefresh,
  type ClaudeOAuthGrant,
} from "./claude-oauth-host.js";
import {
  HostOwnedRefresher,
  HostRefreshStateSchema,
  type HostGrantAdapter,
  type HostRefresherPorts,
  type HostRefreshPolicy,
  type HostRefreshState,
} from "./host-owned-refresher.js";

export const ClaudeOAuthStateSchema = HostRefreshStateSchema;
export type ClaudeOAuthState = HostRefreshState;
export type ClaudeOAuthPolicy = HostRefreshPolicy;
export type ClaudeOAuthRefresherPorts = HostRefresherPorts<
  ClaudeOAuthGrant,
  ClaudeAccessProjection
>;

const CLAUDE_GRANTS: HostGrantAdapter<ClaudeOAuthGrant, ClaudeAccessProjection> = {
  project: claudeAccessProjection,
  digest: accessProjectionDigest,
  needsRefresh: needsHostRefresh,
  leadMs: CLAUDE_REFRESH_LEAD_MS,
  error: () => new ClaudeOAuthDeliveryError(),
};

/** Host-owned refresh for full sign-in Claude accounts. See HostOwnedRefresher. */
export class ClaudeOAuthRefresher extends HostOwnedRefresher<
  ClaudeOAuthGrant,
  ClaudeAccessProjection
> {
  constructor(ports: ClaudeOAuthRefresherPorts) {
    super(ports, CLAUDE_GRANTS);
  }
}
