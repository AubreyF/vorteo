import { z } from "zod";
import { join } from "node:path";
import { ProviderLoginService } from "../../../services/provider-login/service.js";
import { ClaudeSetupTokenLoginSession } from "../../agent/providers/claude/setup-token-login.js";
import {
  checkProviderLaunchAvailable,
  resolveProviderLaunch,
} from "../../agent/provider-launch-config.js";
import type { InstallationConfig } from "../config.js";
import type { InstallationSettingsService } from "../settings/service.js";
import { ClaudeSetupAuthority } from "./claude-setup-authority.js";
import {
  ClaudeSetupDeliveryError,
  ClaudeSetupDeliveryReceiptSchema,
} from "./claude-setup-delivery.js";
import { readClaudeSetupFile, writeClaudeSetupFile } from "./claude-setup-file.js";

/** Owner-only coordinator service. It never exposes the canonical credential through an API. */
export function createClaudeSetupRuntime(
  config: InstallationConfig,
  settings: InstallationSettingsService,
) {
  const file = join(config.stateDir, "claude-setup", "authority.json");
  function definition(definitionId: string) {
    const snapshot = settings.snapshot();
    const selected = snapshot.settings?.providerDefinitions?.find(
      (item) => item.id === definitionId,
    );
    if (!selected || selected.providerType !== "claude" || snapshot.conflicts)
      throw new ClaudeSetupDeliveryError();
    return { snapshot, selected };
  }
  async function prepare(definitionId: string) {
    const { snapshot, selected } = definition(definitionId);
    if (selected.removed || selected.accountId) throw new ClaudeSetupDeliveryError();
    const bindings = [...new Set(Object.values(selected.bindings))];
    if (bindings.length !== 1) throw new ClaudeSetupDeliveryError();
    const providerId = bindings[0]!;
    const creationId = providerId.startsWith("claude-account-")
      ? providerId.slice("claude-account-".length)
      : "";
    if (
      !z.string().uuid().safeParse(creationId).success ||
      (selected.accountSetup &&
        (selected.accountSetup.provider !== "claude" ||
          selected.accountSetup.creationId !== creationId))
    )
      throw new ClaudeSetupDeliveryError();
    const complete = config.public.environments.every(
      (environment) => selected.bindings[environment.serverId] === providerId,
    );
    if (!selected.accountSetup || !complete) {
      const definitions = structuredClone(snapshot.settings!.providerDefinitions!);
      const promoted = definitions.find((item) => item.id === definitionId)!;
      promoted.accountSetup = { provider: "claude", creationId };
      promoted.bindings = Object.fromEntries(
        config.public.environments.map((environment) => [environment.serverId, providerId]),
      );
      await settings.update({
        expectedRevision: snapshot.revision,
        settings: { providerDefinitions: definitions },
      });
    }
    // Account preparation and policy delivery must precede credential delivery.
    await settings.reconcile();
  }
  const authority = new ClaudeSetupAuthority({
    installationId: config.public.installationId,
    read: () => readClaudeSetupFile(file) ?? [],
    persist: (value) => writeClaudeSetupFile(file, value),
    policy: (definitionId) => {
      const { snapshot, selected } = definition(definitionId);
      return {
        revision: snapshot.revision,
        removed: selected.removed === true,
        targets: Object.entries(selected.bindings).map(([serverId, providerId]) => ({
          serverId,
          providerId,
          excluded:
            selected.removed === true ||
            selected.policy.enabled === false ||
            Boolean(
              snapshot.settings?.resourceExclusions[serverId]?.providerIds?.includes(selected.id),
            ),
        })),
      };
    },
    deliver: async (delivery) => {
      const environment = config.public.environments.find(
        (item) => item.serverId === delivery.serverId,
      );
      if (!environment) throw new ClaudeSetupDeliveryError();
      const target = environment.kind === "host" ? config.host : config.container;
      // Explicit loopback endpoints are validated by installation config, never supplied by clients.
      const response = await fetch(
        `http://${target.endpoint}/api/installation/claude/setup-token`,
        {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(10_000),
          headers: {
            Authorization: `Bearer ${target.password}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(delivery),
        },
      );
      if (!response.ok) throw new ClaudeSetupDeliveryError();
      return ClaudeSetupDeliveryReceiptSchema.parse(await response.json());
    },
  });
  const login = new ProviderLoginService({
    getClient: (definitionId) => ({
      openAccountLoginSession: async () => {
        const { selected } = definition(definitionId);
        if (selected.removed || selected.accountSetup?.provider !== "claude")
          throw new ClaudeSetupDeliveryError();
        const launch = await resolveProviderLaunch({ defaultBinary: "claude" });
        const available = await checkProviderLaunchAvailable(launch);
        if (!available.resolvedPath) throw new ClaudeSetupDeliveryError();
        return new ClaudeSetupTokenLoginSession({
          executable: available.resolvedPath,
          args: launch.args,
          scope: `installation/${config.public.installationId}/${definitionId}`,
          saveToken: (token, signal) => authority.save(definitionId, token, signal),
        });
      },
    }),
    onConnected: () => {
      void authority.reconcile().catch(() => {});
    },
  });
  return {
    read: (id: string) => {
      definition(id);
      const connection = authority.status(id);
      const state = login.read(id);
      return {
        login:
          !connection.connected && state.status === "succeeded"
            ? { status: "idle" as const }
            : state,
        connection,
      };
    },
    start: async (id: string) => {
      await prepare(id);
      return login.start(id);
    },
    submit: (id: string, attemptId: string, code: string) => login.submitCode(id, attemptId, code),
    cancel: (id: string, attemptId: string) => login.cancel(id, attemptId),
    signOut: async (id: string) => {
      definition(id);
      const current = login.read(id);
      if (current.status !== "idle") await login.cancel(id, current.attemptId);
      await authority.signOut(id);
      await authority.reconcile();
    },
    reconcile: () => authority.reconcile(),
    dispose: () => login.dispose(),
  };
}
export type ClaudeSetupRuntime = ReturnType<typeof createClaudeSetupRuntime>;
