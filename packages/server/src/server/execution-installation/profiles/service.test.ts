import pino from "pino";
import { setTimeout as delay } from "node:timers/promises";
import { startProfileSynchronization } from "./runtime.js";
import { resolveProfileLaunch } from "../../agent/create-agent/profile.js";
import { sharedWorkflowProfileId } from "@getpaseo/protocol/provider-preferences";
import { materializeSharedProfiles } from "@getpaseo/protocol/provider-preferences";
import { importEnvironmentProfiles, projectEnvironmentProfiles } from "./migration.js";
import { expect, test } from "vitest";
import {
  MutableDaemonConfigSchema,
  type MutableDaemonConfigPatch,
} from "@getpaseo/protocol/messages";
import {
  InstallationProfiles,
  type ProfileEnvironment,
  type ProfileSharingJournal,
  type ProfileSharingState,
} from "./service.js";
import { ProfileSharingConflict, mergeProfileEdits } from "./merge.js";
import { planProviderPreferencesMigration } from "../../agent/provider-preferences/migration.js";
import { validateProviderPreferences } from "../../agent/provider-preferences/validation.js";

class Environment implements ProfileEnvironment {
  offline = false;
  loseReply = false;
  config;
  constructor(
    readonly serverId: string,
    model: string,
  ) {
    const profiles = [{ id: "review", name: "Review", provider: "codex", model }];
    this.config = MutableDaemonConfigSchema.parse({
      mcp: { injectIntoAgents: false },
      agentProfiles: profiles,
      sharedProviderPreferences: planProviderPreferencesMigration({ profiles, providers: {} })
        .preferences,
    });
  }
  async read() {
    if (this.offline) throw new Error("offline");
    return structuredClone(this.config);
  }
  async patch(patch: MutableDaemonConfigPatch) {
    const shared = patch.sharedProviderPreferences;
    if (
      !shared ||
      patch.expectedProviderPreferencesRevision !== this.config.sharedProviderPreferences?.revision
    )
      throw new Error("revision conflict");
    validateProviderPreferences({
      preferences: shared,
      providers: this.config.providers,
      legacyProfiles: this.config.agentProfiles ?? [],
    });
    this.config.sharedProviderPreferences = {
      ...structuredClone(shared),
      revision: shared.revision + 1,
    };
    if (this.loseReply) {
      this.loseReply = false;
      throw new Error("lost reply");
    }
    return structuredClone(this.config);
  }
  edit(field: "name" | "instructions", value: string) {
    const preferences = this.config.sharedProviderPreferences;
    if (!preferences) throw new Error("missing preferences");
    preferences.providers.codex.workflows[0][field] = value;
    preferences.revision++;
  }
}
class Journal implements ProfileSharingJournal {
  state: ProfileSharingState | null = null;
  backups = 0;
  failWrite = false;
  read() {
    return structuredClone(this.state);
  }
  write(state: ProfileSharingState) {
    if (this.failWrite) throw new Error("disk unavailable");
    this.state = structuredClone(state);
  }
  backup() {
    this.backups++;
  }
}
function fixture() {
  const container = new Environment("container", "model-a");
  const host = new Environment("host", "model-b");
  const journal = new Journal();
  const service = new InstallationProfiles(journal, [container, host]);
  return { container, host, journal, service };
}

test("imports colliding profile IDs without losing behavior, then converges without churn", async () => {
  const { container, host, journal, service } = fixture();
  await service.synchronize();
  await service.synchronize();
  const state = service.inspect();
  expect(
    state?.providers.codex.workflows.map(
      (profile) => profile.model ?? state.providers.codex.defaults.model,
    ),
  ).toEqual(["model-a", "model-b"]);
  expect(host.config.sharedProviderPreferences?.legacyProfiles.review.workflowId).not.toBe(
    "review",
  );
  expect(container.config.sharedProviderPreferences?.providers).toEqual(
    host.config.sharedProviderPreferences?.providers,
  );
  await service.synchronize();
  expect(service.inspect()).toEqual(state);
  expect(journal.backups).toBe(1);
});
test("merges independent edits and requires a revision-checked choice for conflicting fields", async () => {
  const { container, host, service } = fixture();
  await service.synchronize();
  await service.synchronize();
  container.edit("name", "Container review");
  host.edit("instructions", "Check races");
  await service.synchronize();
  await service.synchronize();
  expect(container.config.sharedProviderPreferences?.providers.codex.workflows[0]).toMatchObject({
    name: "Container review",
    instructions: "Check races",
  });
  container.edit("name", "Left");
  host.edit("name", "Right");
  await service.synchronize();
  const state = service.inspect();
  if (!state) throw new Error("missing journal");
  expect(state.sources.host.conflicts).toHaveLength(1);
  expect(host.config.sharedProviderPreferences?.providers.codex.workflows[0].name).toBe("Right");
  await expect(
    service.resolve({
      serverId: "host",
      expectedRevision: state.revision - 1,
      choice: "environment",
    }),
  ).rejects.toBeInstanceOf(ProfileSharingConflict);
  await service.resolve({
    serverId: "host",
    expectedRevision: state.revision,
    choice: "environment",
  });
  await service.synchronize();
  expect(container.config.sharedProviderPreferences?.providers.codex.workflows[0]).toMatchObject({
    name: "Right",
    instructions: "Check races",
  });
});
test("reconciles offline edits and lost acknowledgements after coordinator restart", async () => {
  const { container, host, journal, service } = fixture();
  await service.synchronize();
  await service.synchronize();
  host.offline = true;
  host.edit("instructions", "Offline work");
  container.edit("name", "Online work");
  await service.synchronize();
  expect(service.inspect()?.sources.host.error).toContain("offline");
  host.offline = false;
  host.loseReply = true;
  await service.synchronize();
  const restarted = new InstallationProfiles(journal, [container, host]);
  await restarted.synchronize();
  await restarted.synchronize();
  expect(container.config.sharedProviderPreferences?.providers).toEqual(
    host.config.sharedProviderPreferences?.providers,
  );
  expect(container.config.sharedProviderPreferences?.providers.codex.workflows[0]).toMatchObject({
    name: "Online work",
    instructions: "Offline work",
  });
  expect(journal.backups).toBe(1);
});
test("never writes a replica before durable migration storage succeeds", async () => {
  const { container, host, journal, service } = fixture();
  const original = structuredClone([container.config, host.config]);
  journal.failWrite = true;
  await expect(service.synchronize()).rejects.toThrow("disk unavailable");
  expect([container.config, host.config]).toEqual(original);
});
test("merges distinct additions and refuses an edit versus deletion", () => {
  const first = { id: "first", name: "First" };
  expect(mergeProfileEdits([first], [first, { id: "left" }], [first, { id: "right" }])).toEqual([
    first,
    { id: "left" },
    { id: "right" },
  ]);
  expect(() => mergeProfileEdits([first], [], [{ ...first, name: "Changed" }])).toThrow(
    ProfileSharingConflict,
  );
});

test("a conflict decision refuses unseen edits made after the review opened", async () => {
  const { container, host, service } = fixture();
  await service.synchronize();
  await service.synchronize();
  container.edit("name", "Left");
  host.edit("name", "Right");
  await service.synchronize();
  const reviewed = service.inspect();
  if (!reviewed) throw new Error("missing journal");
  host.edit("name", "Unreviewed");
  await expect(
    service.resolve({
      serverId: "host",
      expectedRevision: reviewed.revision,
      choice: "environment",
    }),
  ).rejects.toThrow("environment revision");
  await service.synchronize();
  expect(service.inspect()?.sources.host.conflictValues[0].environmentValue).toBe('"Unreviewed"');
});

test("retains workflows referenced by legacy launches in an offline environment", async () => {
  const { container, host, service } = fixture();
  await service.synchronize();
  await service.synchronize();
  const preferences = container.config.sharedProviderPreferences;
  if (!preferences) throw new Error("missing preferences");
  host.offline = true;
  preferences.providers.codex.workflows.pop();
  preferences.revision++;
  await service.synchronize();
  expect(service.inspect()?.providers.codex.workflows).toHaveLength(2);
  expect(service.inspect()?.sources.container.conflicts).toHaveLength(1);
});

test("shares worker teams without collapsing different workers and resolves local account aliases", () => {
  function preferences(model: string) {
    const profiles = [
      { id: "worker", name: "Worker", provider: "account", model },
      {
        id: "team",
        name: "Team",
        provider: "account",
        model: "supervisor",
        workerProfileId: "worker",
      },
    ];
    return planProviderPreferencesMigration({
      profiles,
      providers: { account: { extends: "codex" } },
    }).preferences;
  }
  const imported = importEnvironmentProfiles([
    { serverId: "container", preferences: preferences("worker-a") },
    { serverId: "host", preferences: preferences("worker-b") },
  ]);
  const teams = imported.providers.codex.workflows.filter((workflow) => workflow.name === "Team");
  expect(teams).toHaveLength(2);
  expect(teams[0].workerProfileId).not.toBe(teams[1].workerProfileId);
  const profiles = materializeSharedProfiles({
    preferences: { version: 1, revision: 1, providers: imported.providers, legacyProfiles: {} },
    providers: { localAccount: { extends: "codex" } },
    providerIds: ["localAccount"],
  });
  const localConfig = MutableDaemonConfigSchema.parse({
    mcp: { injectIntoAgents: false },
    providers: { account: { extends: "codex" } },
    sharedProviderPreferences: preferences("worker-a"),
  });
  localConfig.sharedProviderPreferences = projectEnvironmentProfiles({
    config: localConfig,
    providers: imported.providers,
    workflowIds: imported.workflowIds.container,
  });
  const legacyTeam = resolveProfileLaunch(
    { provider: "account", profileId: "team" },
    [],
    0,
    localConfig,
  );
  expect(legacyTeam.profileLaunch?.worker?.provider).toBe("account");
  expect(legacyTeam.profileLaunch?.worker?.model).toBe("worker-a");
  for (const team of profiles.filter((profile) => profile.name === "Team")) {
    expect(team.workerProfileId).toContain("shared-workflow/localAccount/");
    expect(profiles.some((profile) => profile.id === team.workerProfileId)).toBe(true);
  }
});

test("old shared references preserve their environment's behavior while new global references remain unambiguous", async () => {
  const { container, host, service } = fixture();
  await service.synchronize();
  await service.synchronize();
  const oldId = sharedWorkflowProfileId("codex", "review");
  const oldHost = resolveProfileLaunch(
    { provider: "codex", profileId: oldId },
    host.config.agentProfiles ?? [],
    0,
    host.config,
  );
  const oldContainer = resolveProfileLaunch(
    { provider: "codex", profileId: oldId },
    container.config.agentProfiles ?? [],
    0,
    container.config,
  );
  expect(oldHost.profileLaunch?.profile.model).toBe("model-b");
  expect(oldContainer.profileLaunch?.profile.model).toBe("model-a");
  const canonical = container.config.sharedProviderPreferences?.providers.codex.workflows[0].id;
  if (!canonical) throw new Error("missing global workflow");
  const selected = resolveProfileLaunch(
    { provider: "codex", profileId: sharedWorkflowProfileId("codex", canonical) },
    host.config.agentProfiles ?? [],
    0,
    host.config,
  );
  expect(selected.profileLaunch?.profile.model).toBe("model-a");
});

test("profile polling synchronizes immediately, repeats, and stops on cleanup", async () => {
  const { service, container, host } = fixture();
  const stop = startProfileSynchronization(service, pino({ level: "silent" }));
  try {
    await expect.poll(() => service.inspect()).not.toBeNull();
    container.edit("name", "Polled review");
    await expect
      .poll(() => host.config.sharedProviderPreferences?.providers.codex.workflows[0].name, {
        timeout: 7000,
      })
      .toBe("Polled review");
    stop();
    container.edit("name", "After cleanup");
    await delay(5200);
    expect(host.config.sharedProviderPreferences?.providers.codex.workflows[0].name).toBe(
      "Polled review",
    );
  } finally {
    stop();
  }
}, 15000);
