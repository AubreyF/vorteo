import {
  codexProjectionDigest,
  CodexSignInDeliveryError,
  type CodexAccessProjection,
} from "./codex-signin-delivery.js";
import {
  CODEX_REFRESH_LEAD_MS,
  codexAccessProjection,
  needsCodexHostRefresh,
  type CodexHostGrant,
} from "./codex-signin-host.js";
import {
  HostOwnedRefresher,
  type HostGrantAdapter,
  type HostRefresherPorts,
} from "./host-owned-refresher.js";

export type CodexSignInRefresherPorts = HostRefresherPorts<CodexHostGrant, CodexAccessProjection>;

const CODEX_GRANTS: HostGrantAdapter<CodexHostGrant, CodexAccessProjection> = {
  project: codexAccessProjection,
  digest: codexProjectionDigest,
  needsRefresh: needsCodexHostRefresh,
  leadMs: CODEX_REFRESH_LEAD_MS,
  error: () => new CodexSignInDeliveryError(),
};

/** Host-owned refresh for shared Codex accounts. See HostOwnedRefresher. */
export class CodexSignInRefresher extends HostOwnedRefresher<
  CodexHostGrant,
  CodexAccessProjection
> {
  constructor(ports: CodexSignInRefresherPorts) {
    super(ports, CODEX_GRANTS);
  }
}
