import pino from "pino";
import { requireEnvironmentDaemon } from "../config.js";
import { isDeepStrictEqual } from "node:util";
import { join } from "node:path";
import {
  CODEX_START_FAILURE,
  ProviderLoginService,
} from "../../../services/provider-login/service.js";
import type { InstallationConfig } from "../config.js";
import { connectInstallationDaemon, createInstallationRegistrationAdmission } from "../daemon.js";
import type { InstallationSettingsService } from "../settings/service.js";
import { readClaudeSetupFile, writeClaudeSetupFile } from "./claude-setup-file.js";
import {
  CODEX_SIGNIN_BINDING_ROUTE,
  CODEX_SIGNIN_PROJECTION_ROUTE,
  CodexSignInBindingResponseSchema,
  CodexSignInDeliveryError,
  CodexSignInProjectionReceiptSchema,
  type CodexSignInProjectionDelivery,
} from "./codex-signin-delivery.js";
import { createCodexHostCli, readCodexHostGrant, type CodexHostCli } from "./codex-signin-host.js";
import { CodexSignInRefresher } from "./codex-signin-refresher.js";
import type { HostRefreshPolicy } from "./host-owned-refresher.js";

// Sign-in start failures surface a short message in the interface; the cause goes to the log.
const logger = pino({ name: "vorteo-installation" });

interface DaemonFeatures {
  installationSettingsAuthority?: boolean;
  codexInstallationSignIn?: boolean;
}

interface RuntimeOverrides {
  /** Features each daemon advertises. Injected by tests. */
  daemonFeatures?: (kind: "host" | "container") => Promise<DaemonFeatures | undefined>;
  cli?: CodexHostCli;
  readGrant?: typeof readCodexHostGrant;
  fetch?: typeof fetch;
  now?: () => number;
}

/**
 * Owner-only coordinator service that connects a shared Codex account once for the whole
 * installation. Created only when the installation config sets `codexHostRefresh: true`. It
 * stores no token: the Host account's own CODEX_HOME holds the grant, the official Host Codex is
 * its only refresh writer, and every Dev binding receives access-only projections.
 */
export function createCodexSignInRuntime(
  config: InstallationConfig,
  settings: InstallationSettingsService,
  assertRegistrationReadiness?: (target: "host" | "container-daemon") => void,
  overrides: RuntimeOverrides = {},
) {
  const assertReady = createInstallationRegistrationAdmission(config, assertRegistrationReadiness);
  const configuration = structuredClone(config);
  const file = join(config.stateDir, "codex-signin", "state.json");
  const cli = overrides.cli ?? createCodexHostCli();
  const readGrant = overrides.readGrant ?? readCodexHostGrant;
  const request = overrides.fetch ?? fetch;
  const host = config.public.environments.find((environment) => environment.kind === "host");
  if (!host) throw new CodexSignInDeliveryError();
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

  /** Every daemon must know the binding and projection routes before the Host signs in. */
  async function assertSupported() {
    for (const environment of config.public.environments) {
      assertReady(environment.kind === "host" ? "host" : "container-daemon");
      const features = await daemonFeatures(environment.kind);
      if (
        features?.installationSettingsAuthority !== true ||
        features.codexInstallationSignIn !== true
      )
        throw new CodexSignInDeliveryError();
    }
  }

  /** Only accounts created for the installation qualify; unlinked accounts need verification. */
  function definition(definitionId: string) {
    const snapshot = settings.snapshot();
    const selected = snapshot.settings?.providerDefinitions?.find(
      (item) => item.id === definitionId,
    );
    if (
      !selected ||
      selected.providerType !== "codex" ||
      selected.accountSetup?.provider !== "codex" ||
      snapshot.conflicts
    )
      throw new CodexSignInDeliveryError();
    return {
      snapshot,
      selected,
      providerId: `codex-account-${selected.accountSetup.creationId}`,
    };
  }
  function policy(definitionId: string): HostRefreshPolicy {
    const { snapshot, selected } = definition(definitionId);
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
    if (!isDeepStrictEqual(config, configuration)) throw new CodexSignInDeliveryError();
    // Host-only installations have no Dev; requireEnvironmentDaemon refuses that target plainly.
    const daemon = requireEnvironmentDaemon(config, target);
    // Explicit loopback endpoints are validated by installation config, never supplied by clients.
    const response = await request(`http://${daemon.endpoint}${route}`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
      headers: { Authorization: `Bearer ${daemon.password}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new CodexSignInDeliveryError();
    return response.json();
  }

  /** The Host binding's exact CODEX_HOME, cached per policy revision. */
  const homes = new Map<string, { revision: number; codexHome: string }>();
  async function hostCodexHome(definitionId: string): Promise<string> {
    const { snapshot, selected, providerId } = definition(definitionId);
    const cached = homes.get(definitionId);
    if (cached?.revision === snapshot.revision) return cached.codexHome;
    if (selected.bindings[host!.serverId] !== providerId) throw new CodexSignInDeliveryError();
    assertReady("host");
    const binding = CodexSignInBindingResponseSchema.parse(
      await post("host", CODEX_SIGNIN_BINDING_ROUTE, {
        installationId: config.public.installationId,
        serverId: host!.serverId,
        definitionId,
        providerId,
        policyRevision: snapshot.revision,
      }),
    );
    if (binding.providerId !== providerId) throw new CodexSignInDeliveryError();
    homes.set(definitionId, { revision: snapshot.revision, codexHome: binding.codexHome });
    return binding.codexHome;
  }

  const refresher = new CodexSignInRefresher({
    installationId: config.public.installationId,
    read: () => readClaudeSetupFile(file) ?? [],
    persist: (state) => writeClaudeSetupFile(file, state),
    policy,
    grant: async (definitionId) => readGrant(await hostCodexHome(definitionId)),
    refresh: async (definitionId) => cli.refresh(await hostCodexHome(definitionId)),
    deliver: async (delivery: CodexSignInProjectionDelivery) => {
      const environment = config.public.environments.find(
        (item) => item.serverId === delivery.serverId,
      );
      if (environment?.kind !== "container") throw new CodexSignInDeliveryError();
      // Withdrawal remains available while ordinary Dev work is fenced.
      if (delivery.access !== null) assertReady("container-daemon");
      return CodexSignInProjectionReceiptSchema.parse(
        await post("container", CODEX_SIGNIN_PROJECTION_ROUTE, delivery),
      );
    },
    now: overrides.now ?? Date.now,
  });

  const login = new ProviderLoginService({
    startFailureMessage: () => CODEX_START_FAILURE,
    logger,
    getClient: (definitionId) => ({
      openAccountLoginSession: async () => {
        if (definition(definitionId).selected.removed) throw new CodexSignInDeliveryError();
        return cli.loginSession(await hostCodexHome(definitionId));
      },
    }),
    onConnected: (definitionId) => {
      void (async () => {
        const identity = await cli.identity(await hostCodexHome(definitionId));
        await refresher.connected(definitionId, identity);
        await refresher.reconcile();
      })().catch(() => {});
    },
  });

  /** Bind the shared account on every environment before the Host reports its home. */
  async function prepare(definitionId: string) {
    const { snapshot, selected, providerId } = definition(definitionId);
    if (selected.removed) throw new CodexSignInDeliveryError();
    // A binding to any other provider ID is an unlinked account that needs verification first.
    if (Object.values(selected.bindings).some((bound) => bound !== providerId))
      throw new CodexSignInDeliveryError();
    await assertSupported();
    const complete = config.public.environments.every(
      (environment) => selected.bindings[environment.serverId] === providerId,
    );
    if (!complete) {
      const definitions = structuredClone(snapshot.settings!.providerDefinitions!);
      definitions.find((item) => item.id === definitionId)!.bindings = Object.fromEntries(
        config.public.environments.map((environment) => [environment.serverId, providerId]),
      );
      await settings.update({
        expectedRevision: snapshot.revision,
        settings: { providerDefinitions: definitions },
      });
    }
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
    cancel: (definitionId: string, attemptId: string) => login.cancel(definitionId, attemptId),
    /** Signs the Host account out with its own Codex, then withdraws Dev. Returns a warning. */
    signOut: async (definitionId: string): Promise<string | null> => {
      definition(definitionId);
      const current = login.read(definitionId);
      if (current.status !== "idle") await login.cancel(definitionId, current.attemptId);
      let warning: string | null = null;
      try {
        await cli.logout(await hostCodexHome(definitionId));
      } catch {
        warning =
          "Codex sign-out did not finish on the Host. Its saved sign-in may remain in this account's CODEX_HOME.";
      }
      await refresher.signedOut(definitionId);
      await refresher.reconcile();
      return warning;
    },
    reconcile: () => refresher.reconcile(),
    dispose: () => login.dispose(),
  };
}
export type CodexSignInRuntime = ReturnType<typeof createCodexSignInRuntime>;
