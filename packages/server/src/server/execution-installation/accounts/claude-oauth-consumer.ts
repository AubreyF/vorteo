import { mkdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { ErrorRequestHandler, Express } from "express";
import type { InstallationProvider } from "@getpaseo/protocol/installation-provider";
import { ProviderOverrideSchema } from "@getpaseo/protocol/provider-config";
import type { DaemonConfigStore } from "../../daemon-config-store.js";
import { createClaudeAccount } from "../../../services/provider-login/create-account.js";
import { claudeSignInMode } from "../../agent/providers/claude/sign-in-mode.js";
import { readClaudeSetupFile, writeClaudeSetupFile } from "./claude-setup-file.js";
import { secureAccountHome } from "./claude-setup-consumer.js";
import {
  ClaudeOAuthBindingRequestSchema,
  ClaudeOAuthDeliveryError,
  ClaudeOAuthProjectionDeliverySchema,
  ClaudeOAuthProjectionReceiptSchema,
  ClaudeOAuthProjectionService,
  type ClaudeOAuthBindingRequest,
} from "./claude-oauth-delivery.js";
import { writeClaudeAccessProjection } from "./claude-oauth-credentials-file.js";

interface ConsumerOptions {
  paseoHome: string;
  store: DaemonConfigStore;
  /** Projections are refused on macOS: the CLI reads its Keychain item before the file. */
  platform?: NodeJS.Platform;
  onApplied?(providerId: string): void;
}

const BINDING_ROUTE = "/api/installation/claude/oauth/binding";
const PROJECTION_ROUTE = "/api/installation/claude/oauth/projection";

/**
 * Mounted behind daemon bearer authentication. The binding route returns only the account's
 * configuration path, never a credential: the coordinator (same user, same Host) signs in and
 * reads the Host grant itself. The projection route writes access-only tokens on Dev.
 */
export function mountClaudeOAuthConsumer(app: Express, options: ConsumerOptions): void {
  const platform = options.platform ?? process.platform;
  const parseFailure: ErrorRequestHandler = (_error, _req, res, _next) => {
    res.sendStatus(400);
  };
  app.use(BINDING_ROUTE, parseFailure);
  app.use(PROJECTION_ROUTE, parseFailure);
  const consumers = new Map<string, ClaudeOAuthProjectionService>();

  async function authorize(
    request: ClaudeOAuthBindingRequest,
  ): Promise<{ definition: InstallationProvider; excluded: boolean }> {
    const authority = await options.store.readInstallationSettingsAuthority();
    const definition = authority?.settings.providerDefinitions?.find(
      (item) => item.id === request.definitionId,
    );
    if (
      !authority ||
      !definition ||
      authority.installationId !== request.installationId ||
      authority.serverId !== request.serverId ||
      authority.revision !== request.policyRevision ||
      definition.providerType !== "claude" ||
      definition.bindings[request.serverId] !== request.providerId ||
      definition.accountSetup?.provider !== "claude" ||
      definition.accountSetup.signIn !== "full" ||
      request.providerId !== `claude-account-${definition.accountSetup.creationId}`
    )
      throw new ClaudeOAuthDeliveryError();
    const excluded =
      definition.removed === true ||
      definition.policy.enabled === false ||
      authority.settings.resourceExclusions[request.serverId]?.providerIds?.includes(
        definition.id,
      ) === true;
    return { definition, excluded };
  }

  /** The managed home, which must also be the binding's own full sign-in configuration. */
  function accountHome(providerId: string): string {
    const home = join(options.paseoHome, "claude-accounts", providerId);
    const configured = ProviderOverrideSchema.safeParse(options.store.get().providers[providerId]);
    const env = configured.success ? configured.data.env : undefined;
    if (claudeSignInMode(env) !== "full" || env?.CLAUDE_CONFIG_DIR !== home)
      throw new ClaudeOAuthDeliveryError();
    return home;
  }

  app.post(BINDING_ROUTE, (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    void (async () => {
      try {
        const parsed = ClaudeOAuthBindingRequestSchema.safeParse(req.body);
        if (!parsed.success) {
          res.sendStatus(400);
          return;
        }
        // The Host grant stays the refresh source even when Host use is excluded.
        await authorize(parsed.data);
        const configDir = accountHome(parsed.data.providerId);
        if (!isAbsolute(configDir)) throw new ClaudeOAuthDeliveryError();
        res.json({ providerId: parsed.data.providerId, configDir });
      } catch {
        res.status(409).json({ error: "Claude sign-in synchronization is pending." });
      }
    })();
  });

  app.post(PROJECTION_ROUTE, (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    void (async () => {
      try {
        if (platform === "darwin") throw new ClaudeOAuthDeliveryError();
        const parsed = ClaudeOAuthProjectionDeliverySchema.safeParse(req.body);
        if (!parsed.success) {
          res.sendStatus(400);
          return;
        }
        const delivery = parsed.data;
        const { definition, excluded } = await authorize(delivery);
        if (delivery.access && excluded) throw new ClaudeOAuthDeliveryError();
        if (delivery.access)
          await createClaudeAccount({
            paseoHome: options.paseoHome,
            store: options.store,
            creationId: definition.accountSetup!.creationId,
            name: definition.policy.label ?? "Claude",
            signIn: "full",
          });
        const home = join(options.paseoHome, "claude-accounts", delivery.providerId);
        await mkdir(home, { recursive: true, mode: 0o700 });
        secureAccountHome(home);
        if (delivery.access) accountHome(delivery.providerId);
        const journal = join(home, ".vorteo-oauth", "projection.json");
        let consumer = consumers.get(delivery.providerId);
        if (!consumer) {
          consumer = new ClaudeOAuthProjectionService({
            authorize: async (value) => {
              const current = await authorize(value);
              if (value.access && current.excluded) throw new ClaudeOAuthDeliveryError();
            },
            read: () => {
              const value = readClaudeSetupFile(journal);
              return value === null ? null : ClaudeOAuthProjectionReceiptSchema.parse(value);
            },
            persist: (receipt) => writeClaudeSetupFile(journal, receipt),
            store: (access) => writeClaudeAccessProjection(home, access),
          });
          consumers.set(delivery.providerId, consumer);
        }
        const receipt = await consumer.apply(delivery);
        options.onApplied?.(delivery.providerId);
        res.json(receipt);
      } catch {
        // Never pass token-bearing validation or I/O errors to the generic logger.
        res.status(409).json({ error: "Claude sign-in synchronization is pending." });
      }
    })();
  });
}
