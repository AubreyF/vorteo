import { validateProviderAccountSetup } from "./providers.js";
import type { InstallationProvider } from "@getpaseo/protocol/installation-provider";
import { InstallationSkillPackages } from "./skill-packages.js";
import {
  collectInstallationSkills,
  installationSkillsSettled,
  projectInstallationSkills,
} from "./skill-catalog.js";
import type { InstallationSkill } from "@getpaseo/protocol/skill-library";
import type {
  PluginSourceResolutionInput,
  ResolvedPluginSource,
} from "@getpaseo/protocol/plugin-installation";
import { projectInstallationPlugins } from "./plugins.js";
import type { InstallationPlugin } from "@getpaseo/protocol/plugin-installation";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setInterval } from "node:timers/promises";
import type { Logger } from "pino";
import type { AgentSkillSelection, MutableDaemonConfigPatch } from "@getpaseo/protocol/messages";
import { InstallationSettingsSnapshotSchema } from "@getpaseo/protocol/installation-settings";
import { ensurePrivateDirectory, writePrivateFileAtomicSync } from "../../private-files.js";
import type { InstallationConfig } from "../config.js";
import { connectInstallationDaemon } from "../daemon.js";
import { nativeHostInstallationInstructions } from "./instructions.js";
import {
  InstallationSettingsService,
  SettingsBackupSchema,
  type SettingsJournal,
} from "./service.js";

function syncFileAndDirectory(file: string): void {
  for (const target of [file, path.dirname(file)]) {
    const descriptor = openSync(target, "r");
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  }
}

/** directory belongs to the protected installation, outside guest writable mounts. */
export function createSettingsJournal(directory: string): SettingsJournal {
  ensurePrivateDirectory(directory);
  syncFileAndDirectory(directory);
  const file = path.join(directory, "state.json");
  const packages = new InstallationSkillPackages(path.join(directory, "skill-packages"));
  return {
    validateSkillCatalog(definitions) {
      for (const definition of definitions) packages.read(definition);
    },
    read() {
      if (!existsSync(file)) return null;
      return InstallationSettingsSnapshotSchema.parse(JSON.parse(readFileSync(file, "utf8")));
    },
    write(snapshot) {
      const validated = InstallationSettingsSnapshotSchema.parse(snapshot);
      writePrivateFileAtomicSync(file, JSON.stringify(validated, null, 2));
      syncFileAndDirectory(file);
    },
    backup(backup) {
      const validated = SettingsBackupSchema.parse(backup);
      const backups = path.join(directory, "backups");
      ensurePrivateDirectory(backups);
      const receipt = path.join(backups, `${randomUUID()}.json`);
      writeFileSync(receipt, JSON.stringify(validated, null, 2), { mode: 0o600, flag: "wx" });
      syncFileAndDirectory(receipt);
    },
  };
}

export function createInstallationSettings(
  config: InstallationConfig,
): InstallationSettingsService {
  const journal = createSettingsJournal(path.join(config.stateDir, "shared-settings"));
  const packages = new InstallationSkillPackages(
    path.join(config.stateDir, "shared-settings/skill-packages"),
  );
  const environments = config.public.environments.map((environment) => ({
    serverId: environment.serverId,
    installationInstructions:
      environment.kind === "host" ? installationHostInstructions(config) : "",
    async read() {
      const client = await connectInstallationDaemon(config, environment.kind);
      try {
        if (
          client.getLastServerInfoMessage()?.features?.installationSettingsAuthority !== true ||
          client.getLastServerInfoMessage()?.features?.skillSelectionPreview !== true ||
          client.getLastServerInfoMessage()?.features?.skillPackageTransfer !== true ||
          client.getLastServerInfoMessage()?.features?.pluginPinnedInstallation !== true
        )
          throw new Error("Update the daemon before sharing installation settings.");
        return (await client.getDaemonConfig()).config;
      } finally {
        await client.close();
      }
    },
    async prepareProviderAccounts(definitions: readonly InstallationProvider[]) {
      const client = await connectInstallationDaemon(config, environment.kind);
      try {
        for (const definition of definitions) {
          validateProviderAccountSetup(definition);
          const setup = definition.accountSetup;
          if (!setup || !Object.hasOwn(definition.bindings, environment.serverId)) continue;
          const features = client.getLastServerInfoMessage()?.features;
          const capability =
            setup.provider === "codex" ? "codexAccountCreation" : "claudeAccountCreation";
          if (features?.installationSettingsAuthority !== true || features[capability] !== true)
            throw new Error("Update the daemon before creating shared account bindings.");
          const name = definition.policy.label ?? setup.provider;
          if (setup.provider === "codex") await client.createCodexAccount(setup.creationId, name);
          else await client.createClaudeAccount(setup.creationId, name);
        }
      } finally {
        await client.close();
      }
    },
    async readSkillCatalog() {
      const client = await connectInstallationDaemon(config, environment.kind);
      try {
        return await collectInstallationSkills(client, packages);
      } finally {
        await client.close();
      }
    },
    async skillCatalogSettled(definitions: readonly InstallationSkill[]) {
      const client = await connectInstallationDaemon(config, environment.kind);
      try {
        return await installationSkillsSettled(client, definitions);
      } finally {
        await client.close();
      }
    },
    async projectSkillCatalog(definitions: readonly InstallationSkill[]) {
      const client = await connectInstallationDaemon(config, environment.kind);
      try {
        await projectInstallationSkills(client, definitions, packages);
      } finally {
        await client.close();
      }
    },
    async readPlugins() {
      const client = await connectInstallationDaemon(config, environment.kind);
      try {
        return await client.listPlugins();
      } finally {
        await client.close();
      }
    },
    async projectPlugins(
      definitions: readonly InstallationPlugin[],
      excludedIds: readonly string[],
    ) {
      const client = await connectInstallationDaemon(config, environment.kind);
      try {
        await projectInstallationPlugins(client, definitions, excludedIds);
      } finally {
        await client.close();
      }
    },
    async previewSkills(selection: AgentSkillSelection) {
      const client = await connectInstallationDaemon(config, environment.kind);
      try {
        return await client.previewAgentSkillsSelection(selection);
      } finally {
        await client.close();
      }
    },
    async patch(patch: MutableDaemonConfigPatch, confirmedSkillRemovals: readonly string[] = []) {
      const client = await connectInstallationDaemon(config, environment.kind);
      try {
        if (patch.skills?.selection) {
          const result = await client.saveAgentSkillsSelection(
            patch.skills.selection,
            confirmedSkillRemovals,
          );
          if (result.confirmationRequired || result.ops.length)
            throw new Error("Skill selection still needs review or reconciliation.");
        }
        return (await client.patchDaemonConfig(patch)).config;
      } finally {
        await client.close();
      }
    },
  }));
  return new InstallationSettingsService(journal, environments);
}

export function installationHostInstructions(
  config: Pick<InstallationConfig, "ownerPasswordFile" | "stateDir">,
): string {
  const root =
    config.ownerPasswordFile === undefined
      ? path.dirname(path.dirname(config.stateDir))
      : path.dirname(config.ownerPasswordFile);
  return nativeHostInstallationInstructions(
    path.join(root, "skills/installation-maintenance/SKILL.md"),
  );
}

export function startSettingsReconciliation(
  settings: InstallationSettingsService,
  logger: Logger,
): () => void {
  const controller = new AbortController();
  let running = false;
  async function reconcile() {
    if (running) return;
    running = true;
    try {
      await settings.reconcile();
    } catch {
      // Port errors are reflected in sources. Journal failures must not leak config values.
      logger.warn("Shared settings reconciliation could not persist installation state");
    } finally {
      running = false;
    }
  }
  async function poll() {
    try {
      for await (const _tick of setInterval(5000, undefined, {
        signal: controller.signal,
        ref: false,
      })) {
        await reconcile();
      }
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    }
  }
  void reconcile();
  void poll();
  return () => controller.abort();
}

export type InstallationPluginSourceResolver = (
  input: PluginSourceResolutionInput,
) => Promise<ResolvedPluginSource>;

/** Resolve owner-selected code on the trusted Host, without building or installing it. */
export async function resolveInstallationPluginSource(
  config: InstallationConfig,
  input: PluginSourceResolutionInput,
): Promise<ResolvedPluginSource> {
  const client = await connectInstallationDaemon(config, "host");
  try {
    return await client.resolvePluginSource(input);
  } finally {
    await client.close();
  }
}
