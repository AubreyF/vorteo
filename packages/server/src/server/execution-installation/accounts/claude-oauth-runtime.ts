import { isDeepStrictEqual } from "node:util";
import { join } from "node:path";
import { z } from "zod";
import { ProviderLoginService } from "../../../services/provider-login/service.js";
import type { InstallationConfig } from "../config.js";
import { connectInstallationDaemon, createInstallationRegistrationAdmission } from "../daemon.js";
import type { InstallationSettingsService } from "../settings/service.js";
import { readClaudeSetupFile, writeClaudeSetupFile } from "./claude-setup-file.js";
import {
  ClaudeOAuthBindingResponseSchema,
  ClaudeOAuthDeliveryError,
  ClaudeOAuthProjectionReceiptSchema,
  type ClaudeOAuthProjectionDelivery,
} from "./claude-oauth-delivery.js";
import {
  createClaudeHostCli,
  readClaudeOAuthGrant,
  type ClaudeHostCli,
} from "./claude-oauth-host.js";
import { ClaudeOAuthRefresher, type ClaudeOAuthPolicy } from "./claude-oauth-refresher.js";

interface DaemonFeatures {
  installationSettingsAuthority?: boolean;
  claudeFullSignIn?: boolean;
}

interface RuntimeOverrides {
  /** Features each daemon advertises. Injected by tests. */
  daemonFeatures?: (kind: "host" | "container") => Promise<DaemonFeatures | undefined>;
  cli?: ClaudeHostCli;
  readGrant?: typeof readClaudeOAuthGrant;
  fetch?: typeof fetch;
  now?: () => number;
}

/**
 * Owner-only coordinator service for full sign-in Claude accounts with Host-owned refresh.
 * Created unless the installation config sets `claudeHostRefresh: false`. It stores no token:
 * the Host account's own CLI storage holds the grant, and Dev receives access-only projections.
 */
export function createClaudeOAuthRuntime(
  config: InstallationConfig,
  settings: InstallationSettingsService,
  assertRegistrationReadiness?: (target: "host" | "container-daemon") => void,
  overrides: RuntimeOverrides = {},
) {
  const assertReady = createInstallationRegistrationAdmission(config, assertRegistrationReadiness);
  const configuration = structuredClone(config);
  const file = join(config.stateDir, "claude-oauth", "state.json");
  const cli = overrides.cli ?? createClaudeHostCli();
  const readGrant = overrides.readGrant ?? readClaudeOAuthGrant;
  const request = overrides.fetch ?? fetch;
  const host = config.public.environments.find((environment) => environment.kind === "host");
  if (!host) throw new ClaudeOAuthDeliveryError();
  const daemonFeatures =
    overrides.daemonFeatures ??
    (async (kind: "host" | "container") => {
      const client = await connectInstallationDaemon(config, kind);
      try {
        return client.getLastServerInfoMessage()?.features;
      } finally {
        await client.close();
      }
    });

  /**
   * Older daemons parse definitions with a strict schema and would reject the whole settings
   * authority, not just this account, if it carried `signIn`. Check every daemon first.
   */
  async function assertFullSignInSupported() {
    for (const environment of config.public.environments) {
      assertReady(environment.kind === "host" ? "host" : "container-daemon");
      const features = await daemonFeatures(environment.kind);
      if (features?.installationSettingsAuthority !== true || features.claudeFullSignIn !== true)
        throw new ClaudeOAuthDeliveryError();
    }
  }

  function definition(definitionId: string) {
    const snapshot = settings.snapshot();
    const selected = snapshot.settings?.providerDefinitions?.find(
      (item) => item.id === definitionId,
    );
    if (!selected || selected.providerType !== "claude" || snapshot.conflicts)
      throw new ClaudeOAuthDeliveryError();
    return { snapshot, selected };
  }
  function fullDefinition(definitionId: string) {
    const found = definition(definitionId);
    if (found.selected.accountSetup?.signIn !== "full") throw new ClaudeOAuthDeliveryError();
    return found;
  }
  function policy(definitionId: string): ClaudeOAuthPolicy {
    const { snapshot, selected } = fullDefinition(definitionId);
    const removed = selected.removed === true;
    return {
      revision: snapshot.revision,
      removed,
      targets: config.public.environments
        .filter((environment) => environment.kind === "container")
        .filter((environment) => Object.hasOwn(selected.bindings, environment.serverId))
        .map((environment) => ({
          serverId: environment.serverId,
          providerId: selected.bindings[environment.serverId]!,
          excluded:
            removed ||
            selected.policy.enabled === false ||
            Boolean(
              snapshot.settings?.resourceExclusions[environment.serverId]?.providerIds?.includes(
                selected.id,
              ),
            ),
        })),
    };
  }

  async function post(target: "host" | "container", route: string, body: unknown) {
    if (!isDeepStrictEqual(config, configuration)) throw new ClaudeOAuthDeliveryError();
    const daemon = target === "host" ? config.host : config.container;
    // Explicit loopback endpoints are validated by installation config, never supplied by clients.
    const response = await request(`http://${daemon.endpoint}${route}`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
      headers: { Authorization: `Bearer ${daemon.password}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new ClaudeOAuthDeliveryError();
    return response.json();
  }

  /** The Host binding's exact CLAUDE_CONFIG_DIR, cached per policy revision. */
  const directories = new Map<string, { revision: number; configDir: string }>();
  async function hostConfigDir(definitionId: string): Promise<string> {
    const { snapshot, selected } = fullDefinition(definitionId);
    const cached = directories.get(definitionId);
    if (cached?.revision === snapshot.revision) return cached.configDir;
    const providerId = selected.bindings[host!.serverId];
    if (!providerId) throw new ClaudeOAuthDeliveryError();
    assertReady("host");
    const binding = ClaudeOAuthBindingResponseSchema.parse(
      await post("host", "/api/installation/claude/oauth/binding", {
        installationId: config.public.installationId,
        serverId: host!.serverId,
        definitionId,
        providerId,
        policyRevision: snapshot.revision,
      }),
    );
    if (binding.providerId !== providerId) throw new ClaudeOAuthDeliveryError();
    directories.set(definitionId, { revision: snapshot.revision, configDir: binding.configDir });
    return binding.configDir;
  }

  const refresher = new ClaudeOAuthRefresher({
    installationId: config.public.installationId,
    read: () => readClaudeSetupFile(file) ?? [],
    persist: (state) => writeClaudeSetupFile(file, state),
    policy,
    grant: async (definitionId) => readGrant(await hostConfigDir(definitionId)),
    refresh: async (definitionId) => cli.refresh(await hostConfigDir(definitionId)),
    deliver: async (delivery: ClaudeOAuthProjectionDelivery) => {
      const environment = config.public.environments.find(
        (item) => item.serverId === delivery.serverId,
      );
      if (environment?.kind !== "container") throw new ClaudeOAuthDeliveryError();
      // Withdrawal remains available while ordinary Dev work is fenced.
      if (delivery.access !== null) assertReady("container-daemon");
      return ClaudeOAuthProjectionReceiptSchema.parse(
        await post("container", "/api/installation/claude/oauth/projection", delivery),
      );
    },
    now: overrides.now ?? Date.now,
  });

  const login = new ProviderLoginService({
    getClient: (definitionId) => ({
      openAccountLoginSession: async () => {
        const { selected } = fullDefinition(definitionId);
        if (selected.removed) throw new ClaudeOAuthDeliveryError();
        return cli.loginSession(await hostConfigDir(definitionId));
      },
    }),
    onConnected: (definitionId) => {
      void (async () => {
        const identity = await cli.identity(await hostConfigDir(definitionId));
        await refresher.connected(definitionId, identity);
        await refresher.reconcile();
      })().catch(() => {});
    },
  });

  /** Mark the definition full sign-in and bind it on every environment, as setup-token does. */
  async function prepare(definitionId: string) {
    const { snapshot, selected } = definition(definitionId);
    if (selected.removed || selected.accountId) throw new ClaudeOAuthDeliveryError();
    // An existing setup-token account keeps its type; a new definition is needed instead.
    if (selected.accountSetup && selected.accountSetup.signIn !== "full")
      throw new ClaudeOAuthDeliveryError();
    const bindings = [...new Set(Object.values(selected.bindings))];
    if (bindings.length !== 1) throw new ClaudeOAuthDeliveryError();
    const providerId = bindings[0]!;
    const creationId = providerId.startsWith("claude-account-")
      ? providerId.slice("claude-account-".length)
      : "";
    if (
      !z.string().uuid().safeParse(creationId).success ||
      (selected.accountSetup && selected.accountSetup.creationId !== creationId)
    )
      throw new ClaudeOAuthDeliveryError();
    const complete = config.public.environments.every(
      (environment) => selected.bindings[environment.serverId] === providerId,
    );
    await assertFullSignInSupported();
    if (!selected.accountSetup || !complete) {
      const definitions = structuredClone(snapshot.settings!.providerDefinitions!);
      const promoted = definitions.find((item) => item.id === definitionId)!;
      promoted.accountSetup = { provider: "claude", creationId, signIn: "full" };
      promoted.bindings = Object.fromEntries(
        config.public.environments.map((environment) => [environment.serverId, providerId]),
      );
      await settings.update({
        expectedRevision: snapshot.revision,
        settings: { providerDefinitions: definitions },
      });
    }
    // Bindings must exist on every daemon before the Host can report its account path.
    await settings.reconcile();
  }

  return {
    read: (definitionId: string) => {
      definition(definitionId);
      return { login: login.read(definitionId), connection: refresher.status(definitionId) };
    },
    start: async (definitionId: string) => {
      await prepare(definitionId);
      return login.start(definitionId);
    },
    submit: (definitionId: string, attemptId: string, code: string) =>
      login.submitCode(definitionId, attemptId, code),
    cancel: (definitionId: string, attemptId: string) => login.cancel(definitionId, attemptId),
    /** Signs the Host account out with its own CLI, then withdraws Dev. Returns a warning. */
    signOut: async (definitionId: string): Promise<string | null> => {
      fullDefinition(definitionId);
      const current = login.read(definitionId);
      if (current.status !== "idle") await login.cancel(definitionId, current.attemptId);
      let warning: string | null = null;
      try {
        await cli.logout(await hostConfigDir(definitionId));
      } catch {
        warning =
          "Claude sign-out did not finish on the Host. Its saved sign-in may remain in this account's CLI storage.";
      }
      await refresher.signedOut(definitionId);
      await refresher.reconcile();
      return warning;
    },
    reconcile: () => refresher.reconcile(),
    dispose: () => login.dispose(),
  };
}
export type ClaudeOAuthRuntime = ReturnType<typeof createClaudeOAuthRuntime>;
