import { mkdir } from "node:fs/promises";
import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  lstatSync,
  fchmodSync,
  fsyncSync,
} from "node:fs";
import { join } from "node:path";
import type { ErrorRequestHandler, Express } from "express";
import type { DaemonConfigStore } from "../../daemon-config-store.js";
import { readClaudeSetupFile, writeClaudeSetupFile } from "./claude-setup-file.js";
import { createClaudeAccount } from "../../../services/provider-login/create-account.js";
import { claudeSetupTokenStore } from "../../agent/providers/claude/setup-token-runtime.js";
import {
  ClaudeSetupDeliverySchema,
  ClaudeSetupDeliveryReceiptSchema,
  ClaudeSetupDeliveryService,
  ClaudeSetupDeliveryError,
  type ClaudeSetupDelivery,
} from "./claude-setup-delivery.js";

interface ConsumerOptions {
  paseoHome: string;
  store: DaemonConfigStore;
  onApplied?(providerId: string): void;
}

/** Mounted behind daemon bearer authentication. Returns metadata only, never credentials. */
export function mountClaudeSetupConsumer(app: Express, options: ConsumerOptions): void {
  const parseFailure: ErrorRequestHandler = (_error, _req, res, _next) => {
    res.sendStatus(400);
  };
  app.use("/api/installation/claude/setup-token", parseFailure);
  const consumers = new Map<string, ClaudeSetupDeliveryService>();
  async function authorize(delivery: ClaudeSetupDelivery) {
    const authority = await options.store.readInstallationSettingsAuthority();
    const definition = authority?.settings.providerDefinitions?.find(
      (item) => item.id === delivery.definitionId,
    );
    if (
      !authority ||
      !definition ||
      authority.installationId !== delivery.installationId ||
      authority.serverId !== delivery.serverId ||
      authority.revision !== delivery.policyRevision ||
      definition.providerType !== "claude" ||
      definition.bindings[delivery.serverId] !== delivery.providerId ||
      definition.accountSetup?.provider !== "claude" ||
      delivery.providerId !== `claude-account-${definition.accountSetup.creationId}`
    )
      throw new ClaudeSetupDeliveryError();
    const excluded =
      definition.removed ||
      definition.policy.enabled === false ||
      authority.settings.resourceExclusions[delivery.serverId]?.providerIds?.includes(
        definition.id,
      );
    if (delivery.credential && excluded) throw new ClaudeSetupDeliveryError();
    return definition;
  }
  app.post("/api/installation/claude/setup-token", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    void (async () => {
      try {
        const parsed = ClaudeSetupDeliverySchema.safeParse(req.body);
        if (!parsed.success) {
          res.sendStatus(400);
          return;
        }
        const delivery = parsed.data;
        const definition = await authorize(delivery);
        if (!definition.accountSetup) throw new ClaudeSetupDeliveryError();
        if (delivery.credential)
          await createClaudeAccount({
            paseoHome: options.paseoHome,
            store: options.store,
            creationId: definition.accountSetup.creationId,
            name: definition.policy.label ?? "Claude",
          });
        const home = join(options.paseoHome, "claude-accounts", delivery.providerId);
        await mkdir(home, { recursive: true, mode: 0o700 });
        secureAccountHome(home);
        const directory = join(home, ".vorteo-auth");
        await mkdir(directory, { mode: 0o700 }).catch((error: unknown) => {
          if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
        });
        const tokenStore = claudeSetupTokenStore(home);
        await tokenStore.read(); // Refuse unsafe existing directories before touching the receipt.
        const journal = join(directory, "delivery.json");
        let consumer = consumers.get(delivery.providerId);
        if (!consumer) {
          consumer = new ClaudeSetupDeliveryService({
            authorize: async (value) => {
              await authorize(value);
            },
            read: () => {
              const value = readClaudeSetupFile(journal);
              return value === null ? null : ClaudeSetupDeliveryReceiptSchema.parse(value);
            },
            persist: (receipt) => writeClaudeSetupFile(journal, receipt),
            store: async (credential) => {
              if (credential) await tokenStore.write(credential);
              else await tokenStore.remove();
            },
          });
          consumers.set(delivery.providerId, consumer);
        }
        const receipt = await consumer.apply(delivery);
        options.onApplied?.(delivery.providerId);
        res.json(receipt);
      } catch {
        // Never pass credential-bearing validation or I/O errors to the generic logger.
        res.status(409).json({ error: "Claude subscription synchronization is pending." });
      }
    })();
  });
}

/** Tighten the retained account directory without following links or replacing history. */
function secureAccountHome(home: string): void {
  const named = lstatSync(home);
  if (!named.isDirectory() || (process.getuid && named.uid !== process.getuid()))
    throw new ClaudeSetupDeliveryError();
  if (process.platform === "win32") return;
  const descriptor = openSync(
    home,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const opened = fstatSync(descriptor);
    const current = lstatSync(home);
    if (
      !opened.isDirectory() ||
      opened.uid !== process.getuid!() ||
      (opened.mode & 0o700) !== 0o700 ||
      opened.dev !== named.dev ||
      opened.ino !== named.ino ||
      current.dev !== opened.dev ||
      current.ino !== opened.ino
    )
      throw new ClaudeSetupDeliveryError();
    // Legacy native homes used 0755. Restrict only an owned directory, never its contents.
    if ((opened.mode & 0o777) !== 0o700) {
      fchmodSync(descriptor, 0o700);
      fsyncSync(descriptor);
    }
    const after = lstatSync(home);
    if (
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      (fstatSync(descriptor).mode & 0o777) !== 0o700
    )
      throw new ClaudeSetupDeliveryError();
  } finally {
    closeSync(descriptor);
  }
}
