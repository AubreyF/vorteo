import { mkdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { ErrorRequestHandler, Express } from "express";
import type { InstallationProvider } from "@getpaseo/protocol/installation-provider";
import { ProviderOverrideSchema } from "@getpaseo/protocol/provider-config";
import type { DaemonConfigStore } from "../../daemon-config-store.js";
import { createCodexAccount } from "../../../services/provider-login/create-account.js";
import { readClaudeSetupFile, writeClaudeSetupFile } from "./claude-setup-file.js";
import { secureAccountHome } from "./claude-setup-consumer.js";
import {
  CODEX_SIGNIN_BINDING_ROUTE,
  CODEX_SIGNIN_PROJECTION_ROUTE,
  CodexSignInBindingRequestSchema,
  CodexSignInDeliveryError,
  CodexSignInProjectionDeliverySchema,
  CodexSignInProjectionReceiptSchema,
  CodexSignInProjectionService,
  type CodexSignInBindingRequest,
} from "./codex-signin-delivery.js";
import {
  CODEX_SIGNIN_STATE_DIRECTORY,
  writeCodexAccessProjection,
} from "./codex-signin-auth-file.js";

interface ConsumerOptions {
  paseoHome: string;
  store: DaemonConfigStore;
  onApplied?(providerId: string): void;
}

/**
 * Mounted behind daemon bearer authentication. The binding route returns only the account's
 * CODEX_HOME, never a credential: the coordinator (same user, same Host) signs in and reads the
 * Host grant itself. The projection route writes access-only tokens on Dev.
 */
export function mountCodexSignInConsumer(app: Express, options: ConsumerOptions): void {
  const parseFailure: ErrorRequestHandler = (_error, _req, res, _next) => {
    res.sendStatus(400);
  };
  app.use(CODEX_SIGNIN_BINDING_ROUTE, parseFailure);
  app.use(CODEX_SIGNIN_PROJECTION_ROUTE, parseFailure);
  const consumers = new Map<string, CodexSignInProjectionService>();

  async function authorize(
    request: CodexSignInBindingRequest,
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
      definition.providerType !== "codex" ||
      definition.bindings[request.serverId] !== request.providerId ||
      definition.accountSetup?.provider !== "codex" ||
      request.providerId !== `codex-account-${definition.accountSetup.creationId}`
    )
      throw new CodexSignInDeliveryError();
    const excluded =
      definition.removed === true ||
      definition.policy.enabled === false ||
      authority.settings.resourceExclusions[request.serverId]?.providerIds?.includes(
        definition.id,
      ) === true;
    return { definition, excluded };
  }

  /** The managed home, which must also be the binding's configured CODEX_HOME. */
  function accountHome(providerId: string): string {
    const home = join(options.paseoHome, "codex-accounts", providerId);
    const configured = ProviderOverrideSchema.safeParse(options.store.get().providers[providerId]);
    if (!configured.success || configured.data.env?.CODEX_HOME !== home)
      throw new CodexSignInDeliveryError();
    return home;
  }

  function consumerFor(providerId: string, home: string): CodexSignInProjectionService {
    const existing = consumers.get(providerId);
    if (existing) return existing;
    const journal = join(home, CODEX_SIGNIN_STATE_DIRECTORY, "projection.json");
    const consumer = new CodexSignInProjectionService({
      authorize: async (value) => {
        const current = await authorize(value);
        if (value.access && current.excluded) throw new CodexSignInDeliveryError();
      },
      read: () => {
        const value = readClaudeSetupFile(journal);
        return value === null ? null : CodexSignInProjectionReceiptSchema.parse(value);
      },
      persist: (receipt) => writeClaudeSetupFile(journal, receipt),
      store: async (access) => writeCodexAccessProjection(home, access),
    });
    consumers.set(providerId, consumer);
    return consumer;
  }

  app.post(CODEX_SIGNIN_BINDING_ROUTE, (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    void (async () => {
      try {
        const parsed = CodexSignInBindingRequestSchema.safeParse(req.body);
        if (!parsed.success) {
          res.sendStatus(400);
          return;
        }
        // The Host grant stays the refresh source even when Host use is excluded.
        await authorize(parsed.data);
        const codexHome = accountHome(parsed.data.providerId);
        if (!isAbsolute(codexHome)) throw new CodexSignInDeliveryError();
        res.json({ providerId: parsed.data.providerId, codexHome });
      } catch {
        res.status(409).json({ error: "Codex sign-in synchronization is pending." });
      }
    })();
  });

  app.post(CODEX_SIGNIN_PROJECTION_ROUTE, (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    void (async () => {
      try {
        const parsed = CodexSignInProjectionDeliverySchema.safeParse(req.body);
        if (!parsed.success) {
          res.sendStatus(400);
          return;
        }
        const delivery = parsed.data;
        const { definition, excluded } = await authorize(delivery);
        if (delivery.access && excluded) throw new CodexSignInDeliveryError();
        // Retries reuse the same provider ID and home, including after a lost response.
        if (delivery.access)
          await createCodexAccount({
            paseoHome: options.paseoHome,
            store: options.store,
            creationId: definition.accountSetup!.creationId,
            name: definition.policy.label ?? "Codex",
          });
        const home = join(options.paseoHome, "codex-accounts", delivery.providerId);
        await mkdir(home, { recursive: true, mode: 0o700 });
        secureAccountHome(home);
        if (delivery.access) accountHome(delivery.providerId);
        const receipt = await consumerFor(delivery.providerId, home).apply(delivery);
        options.onApplied?.(delivery.providerId);
        res.json(receipt);
      } catch {
        // Never pass token-bearing validation or I/O errors to the generic logger.
        res.status(409).json({ error: "Codex sign-in synchronization is pending." });
      }
    })();
  });
}
