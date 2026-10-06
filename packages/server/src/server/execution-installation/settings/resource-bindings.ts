import { createHash } from "node:crypto";
import type { MutableDaemonConfig } from "@getpaseo/protocol/messages";

export function installationResourceRevision(config: MutableDaemonConfig): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        terminalProfiles: config.terminalProfiles,
        metadataGeneration: config.metadataGeneration,
        installationResourceBindings: config.installationResourceBindings,
        accounts: Object.entries(config.providers).map(([id, provider]) => [
          id,
          provider.installationAccountId,
          provider.removed,
          provider.enabled,
        ]),
      }),
    )
    .digest("hex");
}
