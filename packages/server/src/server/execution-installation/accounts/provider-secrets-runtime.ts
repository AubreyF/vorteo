import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { join } from "node:path";
import type { ProviderSecretsStatus } from "@getpaseo/protocol/provider-secrets";
import type { InstallationConfig } from "../config.js";
import { connectInstallationDaemon, createInstallationRegistrationAdmission } from "../daemon.js";
import type { InstallationSettingsService } from "../settings/service.js";
import { readClaudeSetupFile, writeClaudeSetupFile } from "./claude-setup-file.js";
import {
  ProviderSecretsAuthority,
  ProviderSecretsUnsupportedError,
  type ProviderSecretsPolicy,
} from "./provider-secrets-authority.js";
import {
  ProviderSecretsDeliveryError,
  ProviderSecretsReceiptSchema,
} from "./provider-secrets-delivery.js";
import { PROVIDER_SECRETS_ROUTE } from "./provider-secrets-consumer.js";

const EnvSchema = z.record(z.string(), z.string());

interface DaemonFeatures {
  installationSettingsAuthority?: boolean;
  providerSecretDelivery?: boolean;
}
interface RuntimeOverrides {
  /** Features and provider env of one daemon. Injected by tests. */
  inspect?: (kind: "host" | "container") => Promise<{
    features: DaemonFeatures | undefined;
    providers: Record<string, { env?: unknown } | undefined>;
  }>;
  fetch?: typeof fetch;
  now?: () => Date;
}

const FEATURE_CACHE_MS = 5 * 60_000;

/** Owner-only coordinator service for static provider secrets. Never exposes stored values. */
export function createProviderSecretsRuntime(
  config: InstallationConfig,
  settings: InstallationSettingsService,
  assertRegistrationReadiness?: (target: "host" | "container-daemon") => void,
  overrides: RuntimeOverrides = {},
) {
  const assertReady = createInstallationRegistrationAdmission(config, assertRegistrationReadiness);
  const configuration = structuredClone(config);
  const file = join(config.stateDir, "provider-secrets", "state.json");
  const request = overrides.fetch ?? fetch;
  const inspect =
    overrides.inspect ??
    (async (kind: "host" | "container") => {
      const client = await connectInstallationDaemon(config, kind);
      try {
        const features = client.getLastServerInfoMessage()?.features;
        const providers = (await client.getDaemonConfig()).config.providers;
        return { features, providers };
      } finally {
        await client.close();
      }
    });
  const supported = new Map<string, number>();
  const readiness = (kind: "host" | "container") =>
    assertReady(kind === "host" ? "host" : "container-daemon");
  function environment(serverId: string) {
    const found = config.public.environments.find((item) => item.serverId === serverId);
    if (!found) return undefined;
    return { kind: found.kind, label: found.kind === "host" ? "Host" : "Dev container" };
  }
  function definition(definitionId: string) {
    const snapshot = settings.snapshot();
    if (snapshot.conflicts || !snapshot.settings) throw new ProviderSecretsDeliveryError();
    const selected = snapshot.settings.providerDefinitions?.find(
      (item) => item.id === definitionId,
    );
    return { snapshot, selected };
  }
  function policy(definitionId: string): ProviderSecretsPolicy {
    const { snapshot, selected } = definition(definitionId);
    if (!selected) return { revision: Math.max(1, snapshot.revision), removed: true, targets: [] };
    const removed = selected.removed === true;
    return {
      revision: Math.max(1, snapshot.revision),
      removed,
      targets: Object.entries(selected.bindings)
        .filter(([serverId]) => environment(serverId) !== undefined)
        .map(([serverId, providerId]) => ({
          serverId,
          providerId,
          excluded:
            removed ||
            selected.policy.enabled === false ||
            Boolean(
              snapshot.settings?.resourceExclusions[serverId]?.providerIds?.includes(selected.id),
            ),
        })),
    };
  }
  const authority = new ProviderSecretsAuthority({
    installationId: config.public.installationId,
    read: () => readClaudeSetupFile(file) ?? [],
    persist: (state) => writeClaudeSetupFile(file, state),
    definitions: () => {
      const snapshot = settings.snapshot();
      if (snapshot.conflicts) return [];
      return (snapshot.settings?.providerDefinitions ?? [])
        .filter((item) => !item.removed && Object.keys(item.bindings).length > 0)
        .map((item) => item.id);
    },
    policy,
    environment,
    readEnvironment: async (serverId) => {
      const target = environment(serverId);
      if (!target) throw new ProviderSecretsDeliveryError();
      readiness(target.kind);
      const { providers } = await inspect(target.kind);
      return Object.fromEntries(
        Object.entries(providers).map(([id, provider]) => {
          const env = EnvSchema.safeParse(provider?.env ?? {});
          return [id, env.success ? env.data : undefined];
        }),
      );
    },
    deliver: async (delivery) => {
      const target = environment(delivery.serverId);
      if (!target) throw new ProviderSecretsDeliveryError();
      // Withdrawal remains available while ordinary Dev work is fenced.
      if (Object.keys(delivery.values).length > 0) readiness(target.kind);
      if (!isDeepStrictEqual(config, configuration)) throw new ProviderSecretsDeliveryError();
      const checked = supported.get(target.kind);
      if (checked === undefined || Date.now() - checked > FEATURE_CACHE_MS) {
        const { features } = await inspect(target.kind);
        if (
          features?.installationSettingsAuthority !== true ||
          features.providerSecretDelivery !== true
        )
          throw new ProviderSecretsUnsupportedError();
        supported.set(target.kind, Date.now());
      }
      const daemon = target.kind === "host" ? config.host : config.container;
      // Explicit loopback endpoints are validated by installation config, never supplied by clients.
      const response = await request(`http://${daemon.endpoint}${PROVIDER_SECRETS_ROUTE}`, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
        headers: {
          Authorization: `Bearer ${daemon.password}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(delivery),
      });
      if (response.status === 404) {
        supported.delete(target.kind);
        throw new ProviderSecretsUnsupportedError();
      }
      if (!response.ok) throw new ProviderSecretsDeliveryError();
      return ProviderSecretsReceiptSchema.parse(await response.json());
    },
    now: overrides.now ?? (() => new Date()),
  });
  function existing(definitionId: string) {
    const { selected } = definition(definitionId);
    if (!selected) throw new ProviderSecretsDefinitionMissing();
    return selected;
  }
  /** Codex refresh grants stay per environment until access-only projection is proven safe. */
  function withAccountSignIn(status: ProviderSecretsStatus): ProviderSecretsStatus {
    const { selected } = definition(status.definitionId);
    const codexAccount =
      selected?.providerType === "codex" &&
      (selected.accountSetup?.provider === "codex" ||
        Object.values(selected.bindings).some((id) => id.startsWith("codex-account-")));
    if (!selected || !codexAccount || selected.removed) return status;
    const policyTargets = policy(status.definitionId).targets;
    return {
      ...status,
      accountSignIn: {
        provider: "codex",
        synchronized: false,
        environments: policyTargets
          .filter((target) => !target.excluded)
          .map((target) => {
            const { kind, label } = environment(target.serverId)!;
            return { serverId: target.serverId, kind, label };
          }),
      },
    };
  }
  const kick = () => {
    void authority.reconcile().catch(() => {});
  };
  return {
    read: (definitionId?: string) => {
      if (definitionId === undefined) return authority.statuses().map(withAccountSignIn);
      existing(definitionId);
      return [withAccountSignIn(authority.status(definitionId))];
    },
    set: async (definitionId: string, name: string, value: string) => {
      if (existing(definitionId).removed) throw new ProviderSecretsDeliveryError();
      await authority.set(definitionId, name, value);
      kick();
      return [withAccountSignIn(authority.status(definitionId))];
    },
    clear: async (definitionId: string, name: string) => {
      existing(definitionId);
      await authority.clear(definitionId, name);
      kick();
      return [withAccountSignIn(authority.status(definitionId))];
    },
    reconcile: () => authority.reconcile(),
  };
}
export type ProviderSecretsRuntime = ReturnType<typeof createProviderSecretsRuntime>;

export class ProviderSecretsDefinitionMissing extends Error {
  constructor() {
    super("The shared provider does not exist");
  }
}
