import { createHash } from "node:crypto";
import { join } from "node:path";
import type { ErrorRequestHandler, Express } from "express";
import { z } from "zod";
import type { DaemonConfigStore } from "../../daemon-config-store.js";
import { readClaudeSetupFile, writeClaudeSetupFile } from "./claude-setup-file.js";
import {
  ProviderSecretsDeliveryError,
  ProviderSecretsDeliverySchema,
  ProviderSecretsDeliveryService,
  ProviderSecretsJournalSchema,
  type ProviderSecretsDelivery,
} from "./provider-secrets-delivery.js";

const EnvSchema = z.record(z.string(), z.string());

interface ConsumerOptions {
  paseoHome: string;
  store: DaemonConfigStore;
  onApplied?(providerId: string): void;
}

export const PROVIDER_SECRETS_ROUTE = "/api/installation/provider-secrets";

/**
 * Receives coordinator-held provider API keys and tokens into the local provider `env`.
 * Mounted behind daemon bearer authentication. Returns metadata only, never values.
 */
export function mountProviderSecretsConsumer(app: Express, options: ConsumerOptions): void {
  const parseFailure: ErrorRequestHandler = (_error, _req, res, _next) => {
    res.sendStatus(400);
  };
  app.use(PROVIDER_SECRETS_ROUTE, parseFailure);
  const consumers = new Map<string, ProviderSecretsDeliveryService>();
  async function authorize(delivery: ProviderSecretsDelivery) {
    const authority = await options.store.readInstallationSettingsAuthority();
    if (
      !authority ||
      authority.installationId !== delivery.installationId ||
      authority.serverId !== delivery.serverId ||
      authority.revision !== delivery.policyRevision
    )
      throw new ProviderSecretsDeliveryError();
    // Withdrawal stays available after a binding, definition or environment is removed.
    if (Object.keys(delivery.values).length === 0) return;
    const definition = authority.settings.providerDefinitions?.find(
      (item) => item.id === delivery.definitionId,
    );
    if (
      !definition ||
      definition.bindings[delivery.serverId] !== delivery.providerId ||
      definition.removed ||
      definition.policy.enabled === false ||
      authority.settings.resourceExclusions[delivery.serverId]?.providerIds?.includes(definition.id)
    )
      throw new ProviderSecretsDeliveryError();
  }
  app.post(PROVIDER_SECRETS_ROUTE, (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    void (async () => {
      try {
        const parsed = ProviderSecretsDeliverySchema.safeParse(req.body);
        if (!parsed.success) {
          res.sendStatus(400);
          return;
        }
        const { providerId } = parsed.data;
        let consumer = consumers.get(providerId);
        if (!consumer) {
          const name = createHash("sha256").update(providerId).digest("hex");
          const journal = join(options.paseoHome, "provider-secrets", `${name}.json`);
          consumer = new ProviderSecretsDeliveryService({
            authorize,
            read: () => {
              const value = readClaudeSetupFile(journal);
              return value === null ? null : ProviderSecretsJournalSchema.parse(value);
            },
            persist: (value) => writeClaudeSetupFile(journal, value),
            readEnv: () => {
              const provider = options.store.get().providers[providerId];
              if (!provider || provider.removed) return null;
              const env = EnvSchema.safeParse(provider.env ?? {});
              if (!env.success) throw new ProviderSecretsDeliveryError();
              return { ...env.data };
            },
            writeEnv: (env) => {
              options.store.replaceProviderEnv(providerId, env);
            },
          });
          consumers.set(providerId, consumer);
        }
        const receipt = await consumer.apply(parsed.data);
        options.onApplied?.(providerId);
        res.json(receipt);
      } catch {
        // Never pass secret-bearing validation or I/O errors to the generic logger.
        res.status(409).json({ error: "Provider key synchronization is pending." });
      }
    })();
  });
}
