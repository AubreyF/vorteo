import type { InstallationProvider } from "@getpaseo/protocol/installation-provider";
import { projectInstallationProviders } from "./providers.js";
import type { InstallationSkill } from "@getpaseo/protocol/skill-library";
import { isDeepStrictEqual } from "node:util";
import type { PluginListItem } from "@getpaseo/protocol/messages";
import type { InstallationPlugin } from "@getpaseo/protocol/plugin-installation";
import {
  MutableDaemonConfigSchema,
  type MutableDaemonConfigPatch,
  type AgentSkillSelection,
  type AgentSkillOperation,
  type AgentSkillsSaveResult,
} from "@getpaseo/protocol/messages";
import type { InstallationSettingsSnapshot } from "@getpaseo/protocol/installation-settings";
import type { SettingsBackup, SettingsEnvironment, SettingsJournal } from "./service.js";

export class SettingsEnvironmentFake implements SettingsEnvironment {
  installationInstructions = "";
  offline = false;
  rejectPatch = false;
  loseReply = false;
  ignorePatch = false;
  patches: MutableDaemonConfigPatch[] = [];
  skillOps: AgentSkillOperation[] = [];
  skillConfirmations: Array<readonly string[]> = [];
  config = MutableDaemonConfigSchema.parse({ mcp: { injectIntoAgents: false } });

  constructor(readonly serverId: string) {}

  async read() {
    if (this.offline) throw new Error("private diagnostic that must not appear in snapshots");
    return structuredClone(this.config);
  }

  accountCreations: string[] = [];
  loseAccountReply = false;
  async prepareProviderAccounts(definitions: readonly InstallationProvider[]) {
    if (this.offline) throw new Error("environment offline");
    for (const definition of definitions) {
      const id = definition.bindings[this.serverId];
      if (!id || !definition.accountSetup || this.config.providers[id]) continue;
      this.accountCreations.push(id);
      this.config.providers[id] = {
        extends: definition.accountSetup.provider,
        ...definition.policy,
        env: { LOCAL_ACCOUNT_HOME: `/private/${this.serverId}/${id}` },
      };
      if (this.loseAccountReply) throw new Error("account response lost after persistence");
    }
  }

  skillCatalog: InstallationSkill[] = [];
  async readSkillCatalog() {
    if (this.offline) throw new Error("environment offline");
    return structuredClone(this.skillCatalog);
  }
  async skillCatalogSettled(definitions: readonly InstallationSkill[]) {
    const current = await this.readSkillCatalog();
    return definitions.every((definition) =>
      current.some((skill) => isDeepStrictEqual(skill, definition)),
    );
  }
  async projectSkillCatalog(definitions: readonly InstallationSkill[]) {
    if (this.offline || this.rejectPatch) throw new Error("skill projection failed");
    if (this.ignorePatch) return;
    for (const definition of definitions) {
      this.skillCatalog = this.skillCatalog.filter(
        (skill) => skill.identity !== definition.identity,
      );
      this.skillCatalog.push(structuredClone(definition));
    }
  }
  plugins: PluginListItem[] = [];
  async readPlugins() {
    if (this.offline) throw new Error("environment offline");
    return structuredClone(this.plugins);
  }
  async projectPlugins(definitions: readonly InstallationPlugin[], excludedIds: readonly string[]) {
    if (this.offline || this.rejectPatch) throw new Error("plugin projection failed");
    if (this.ignorePatch) return;
    const previous = this.plugins;
    this.plugins = definitions
      .filter((definition) => !excludedIds.includes(definition.id))
      .map((definition) => ({
        id: definition.id,
        providers: previous.find((item) => item.id === definition.id)?.providers,
        path:
          previous.find((item) => item.id === definition.id)?.path ?? `/plugins/${definition.id}`,
        enabled: definition.enabled,
        status: definition.enabled ? "running" : "disabled",
        installation: {
          identity:
            definition.source.kind === "directory"
              ? { kind: "directory", path: `/private/${definition.id}` }
              : definition.source.identity,
        },
        resolvedSource: definition.source.kind === "directory" ? undefined : definition.source,
      }));
    for (const item of previous)
      if (!this.plugins.some((entry) => entry.id === item.id))
        this.plugins.push({ ...item, enabled: false, status: "disabled" });
  }

  async previewSkills(selection: AgentSkillSelection): Promise<AgentSkillsSaveResult> {
    if (this.offline) throw new Error("environment offline");
    const removals = this.skillOps.filter((op) => op.kind === "delete").map((op) => op.name);
    return {
      state: "drift",
      ops: structuredClone(this.skillOps),
      available: ["alpha", "beta"],
      installed: [],
      selection,
      confirmationRequired: removals.length ? { removals } : null,
    };
  }

  async patch(patch: MutableDaemonConfigPatch, confirmedSkillRemovals: readonly string[] = []) {
    if (this.rejectPatch) throw new Error("private patch diagnostic");
    this.patches.push(structuredClone(patch));
    if (!this.ignorePatch) {
      if (patch.skills?.selection) {
        const plan = await this.previewSkills(patch.skills.selection);
        if (
          plan.confirmationRequired?.removals.some((name) => !confirmedSkillRemovals.includes(name))
        )
          throw new Error("Removal approval missing");
        this.skillConfirmations.push([...confirmedSkillRemovals]);
        this.skillOps = [];
      }
      this.config = MutableDaemonConfigSchema.parse({
        ...this.config,
        ...patch,
        ...(patch.installationProviderPolicy
          ? {
              providers: projectInstallationProviders(
                patch.installationProviderPolicy.definitions,
                this.serverId,
                this.config.providers,
                patch.installationProviderPolicy.excludedIds,
              ),
            }
          : {}),
        mcp: { ...this.config.mcp, ...patch.mcp },
        browserTools: { ...this.config.browserTools, ...patch.browserTools },
      });
    }
    if (this.loseReply) {
      this.loseReply = false;
      throw new Error("lost reply");
    }
    return structuredClone(this.config);
  }
}

export class SettingsJournalFake implements SettingsJournal {
  validateSkillCatalog(_definitions: readonly InstallationSkill[]): void {}
  state: InstallationSettingsSnapshot | null = null;
  backups: SettingsBackup[] = [];
  failWrite = false;
  failBackup = false;

  read() {
    return structuredClone(this.state);
  }

  write(snapshot: InstallationSettingsSnapshot) {
    if (this.failWrite) throw new Error("journal unavailable");
    this.state = structuredClone(snapshot);
  }

  backup(backup: SettingsBackup) {
    if (this.failBackup) throw new Error("backup unavailable");
    this.backups.push(structuredClone(backup));
  }
}
