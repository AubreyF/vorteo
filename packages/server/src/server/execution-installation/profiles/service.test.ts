import pino from "pino";
import { setTimeout as delay } from "node:timers/promises";
import { startProfileSynchronization } from "./runtime.js";
import { resolveProfileLaunch } from "../../agent/create-agent/profile.js";
import { sharedWorkflowProfileId } from "@getpaseo/protocol/provider-preferences";
import { materializeSharedProfiles } from "@getpaseo/protocol/provider-preferences";
import {
  importEnvironmentProfiles,
  projectEnvironmentProfiles,
  consolidateProfileDefinitions,
  normalizeLegacyProfileValues,
} from "./migration.js";
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
  workerAccounts = false;
  reads = 0;
  loseReply = false;
  config;
  constructor(
    readonly serverId: "host" | "container",
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
  get kind() {
    return this.serverId;
  }
  async read() {
    this.reads++;
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
  const service = new InstallationProfiles(
    journal,
    [container, host],
    "00000000-0000-4000-8000-000000000001",
  );
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

interface ImportedWorkerAccounts {
  host: Environment;
  container: Environment;
  snapshot: NonNullable<ReturnType<InstallationProfiles["snapshot"]>>;
}

function verifyImportedWorkerAccounts({ host, container, snapshot }: ImportedWorkerAccounts) {
  const importedHostTeam = snapshot.providers.codex.workflows.find(
    (profile) => profile.name === "Host team",
  );
  const importedDevTeam = snapshot.providers.codex.workflows.find(
    (profile) => profile.name === "Dev team",
  );
  if (!importedHostTeam || !importedDevTeam) throw new Error("missing team profiles");
  const imported = resolveProfileLaunch(
    {
      provider: "devOne",
      profileId: sharedWorkflowProfileId("devOne", importedHostTeam.id),
      cwd: "/work",
    },
    container.config.agentProfiles ?? [],
    0,
    container.config,
  );
  expect(imported.profileLaunch?.worker?.provider).toBe("devTwo");
  expect(imported.profileLaunch?.worker?.model).toBe("worker-model");
  const hostInput = {
    provider: "hostOne",
    profileId: sharedWorkflowProfileId("hostOne", importedDevTeam.id),
    cwd: "/work",
  };
  expect(() =>
    resolveProfileLaunch(hostInput, host.config.agentProfiles ?? [], 0, host.config),
  ).toThrow("Worker profile not found");
  host.config.providers.hostThree.enabled = true;
  const christian = resolveProfileLaunch(
    hostInput,
    host.config.agentProfiles ?? [],
    0,
    host.config,
  );
  expect(christian.profileLaunch?.worker?.provider).toBe("hostThree");
  expect(christian.profileLaunch?.worker?.model).toBe("third-model");
}

test("consolidates both account catalogs without dropping a third account or changing launch references", async () => {
  const { host, container, service } = fixture();
  const secondAccount = "71fca551-79a4-4af9-b9e6-9ec7222f9e1d";
  const thirdAccount = "8cba85c0-d92b-4fa4-a9e8-773a9f1f01cc";
  host.config.providers = {
    hostOne: { extends: "codex", label: "Codex 1", env: { CODEX_HOME: "/host/one" } },
    hostTwo: {
      extends: "codex",
      label: "Codex 2",
      env: { CODEX_HOME: "/host/two" },
      installationAccountId: secondAccount,
    },
    hostThree: {
      extends: "codex",
      label: "Codex 3",
      enabled: false,
      installationAccountId: thirdAccount,
    },
  };
  container.config.providers = {
    devOne: { extends: "codex", label: "Codex 1", env: { CODEX_HOME: "/dev/one" } },
    devTwo: {
      extends: "codex",
      label: "Codex 2",
      env: { CODEX_HOME: "/dev/two" },
      installationAccountId: secondAccount,
    },
    devThree: {
      extends: "codex",
      label: "Codex 3 (Christian)",
      enabled: true,
      installationAccountId: thirdAccount,
      env: { CODEX_HOME: "/dev/three" },
    },
    pi: { enabled: true },
  };
  host.config.agentProfiles = [
    { id: "one", name: "Host one", provider: "hostOne", model: "host-model" },
    { id: "two", name: "Host two", provider: "hostTwo", model: "worker-model" },
    {
      id: "team",
      name: "Host team",
      provider: "hostOne",
      model: "host-model",
      workerProfileId: "two",
    },
  ];
  container.config.agentProfiles = [
    { id: "one", name: "Dev one", provider: "devOne", model: "dev-model" },
    { id: "two", name: "Dev two", provider: "devTwo", model: "second-dev-model" },
    { id: "three", name: "Christian worker", provider: "devThree", model: "third-model" },
    { id: "local", name: "Local", provider: "pi", model: "local-model" },
    {
      id: "team",
      name: "Dev team",
      provider: "devOne",
      model: "dev-model",
      workerProfileId: "three",
    },
  ];
  const cases = [host, container].map((environment) => {
    const profiles = environment.config.agentProfiles ?? [];
    const providers = environment.config.providers;
    const preferences = planProviderPreferencesMigration({ profiles, providers }).preferences;
    environment.config.sharedProviderPreferences = preferences;
    const candidates = [
      ...profiles,
      ...materializeSharedProfiles({ preferences, providers, providerIds: Object.keys(providers) }),
    ];
    return {
      environment,
      providers: structuredClone(providers),
      profiles: structuredClone(profiles),
      launches: candidates.map((profile) => {
        const input = { provider: profile.provider, profileId: profile.id, cwd: "/work" };
        const launch = resolveProfileLaunch(input, profiles, 0, environment.config);
        return { input, launch };
      }),
    };
  });
  await service.synchronize();
  await service.synchronize();
  for (const { environment, providers, profiles, launches } of cases) {
    expect(environment.config.providers).toEqual(providers);
    expect(environment.config.agentProfiles).toEqual(profiles);
    for (const { input, launch: before } of launches) {
      const after = resolveProfileLaunch(input, profiles, 0, environment.config);
      expect(after.provider).toBe(before.provider);
      expect(after.model).toBe(before.model);
      expect(after.profileLaunch?.worker?.provider).toBe(before.profileLaunch?.worker?.provider);
      expect(after.profileLaunch?.worker?.model).toBe(before.profileLaunch?.worker?.model);
    }
  }
  const snapshot = service.snapshot();
  if (!snapshot) throw new Error("missing snapshot");
  const names = snapshot.providers.codex.workflows.map((profile) => profile.name);
  expect(names).toEqual(
    expect.arrayContaining(["Host one", "Host two", "Dev one", "Dev two", "Christian worker"]),
  );
  expect(snapshot.providers.pi.workflows.map((profile) => profile.name)).toEqual(["Local"]);
  expect(host.config.sharedProviderPreferences?.providers).toEqual(
    container.config.sharedProviderPreferences?.providers,
  );
  expect(host.config.providers.hostThree.enabled).toBe(false);
  expect(container.config.providers.devThree.enabled).toBe(true);
  verifyImportedWorkerAccounts({ host, container, snapshot });
  const providers = structuredClone(snapshot.providers);
  const team = providers.codex.workflows.find((profile) => profile.name === "Host team");
  if (!team) throw new Error("missing imported team");
  providers.codex.workflows.push({
    id: "replacement",
    name: "Replacement",
    provider: "codex",
    model: "replacement-model",
  });
  team.workerProfileId = sharedWorkflowProfileId("codex", "replacement");
  await service.patch({ expectedRevision: snapshot.revision, providers });
  await service.synchronize();
  const originalTeam = cases[0].launches.find(
    ({ input, launch }) =>
      input.profileId.startsWith("shared-workflow/") &&
      launch.profileLaunch?.profile.name === "Host team",
  );
  if (!originalTeam) throw new Error("missing original shared launch");
  const updated = resolveProfileLaunch(originalTeam.input, cases[0].profiles, 0, host.config);
  expect(updated.profileLaunch?.worker?.provider).toBe(originalTeam.input.provider);
  expect(updated.profileLaunch?.worker?.model).toBe("replacement-model");
});

test("daemon copies cannot redefine canonical profiles, including offline edits", async () => {
  const { container, host, journal, service } = fixture();
  await service.synchronize();
  const canonical = service.snapshot();
  host.offline = true;
  host.edit("instructions", "Offline override");
  container.edit("name", "Local override");
  await service.synchronize();
  expect(service.snapshot()?.providers).toEqual(canonical?.providers);
  expect(service.snapshot()?.revision).toBe(canonical?.revision);
  expect(service.status()?.sources.host.error).toContain("offline");
  host.offline = false;
  host.loseReply = true;
  await service.synchronize();
  const restarted = new InstallationProfiles(
    journal,
    [container, host],
    "00000000-0000-4000-8000-000000000001",
  );
  await restarted.synchronize();
  expect(host.config.sharedProviderPreferences?.providers).toEqual(canonical?.providers);
  expect(container.config.sharedProviderPreferences?.providers).toEqual(canonical?.providers);
  expect(restarted.snapshot()?.revision).toBe(canonical?.revision);
});

test("serializes canonical edits and rejects stale revisions before changing profiles", async () => {
  const { service, host } = fixture();
  await service.synchronize();
  const snapshot = service.snapshot();
  if (!snapshot) throw new Error("missing snapshot");
  const providers = structuredClone(snapshot.providers);
  providers.codex.workflows[0].instructions = "Canonical instructions";
  host.offline = true;
  const reads = host.reads;
  const saved = await service.patch({ expectedRevision: snapshot.revision, providers });
  expect(host.reads).toBe(reads);
  expect(saved.revision).toBe(snapshot.revision + 1);
  expect(saved.providers).toEqual(providers);
  await expect(
    service.patch({ expectedRevision: snapshot.revision, providers: snapshot.providers }),
  ).rejects.toBeInstanceOf(ProfileSharingConflict);
  expect(service.snapshot()?.providers).toEqual(providers);
  host.offline = false;
  await service.synchronize();
  expect(host.config.sharedProviderPreferences?.providers).toEqual(providers);
  expect(service.snapshot()?.revision).toBe(saved.revision);
});

test("failed canonical persistence leaves every cache and the current revision unchanged", async () => {
  const { service, host, container, journal } = fixture();
  await service.synchronize();
  const snapshot = service.snapshot();
  if (!snapshot) throw new Error("missing snapshot");
  const before = structuredClone([host.config, container.config]);
  const providers = structuredClone(snapshot.providers);
  providers.codex.workflows[0].name = "New name";
  journal.failWrite = true;
  await expect(service.patch({ expectedRevision: snapshot.revision, providers })).rejects.toThrow(
    "disk unavailable",
  );
  expect(service.snapshot()).toEqual(snapshot);
  expect([host.config, container.config]).toEqual(before);
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

test("retains workflows referenced by legacy launches in an offline environment", async () => {
  const { host, service } = fixture();
  await service.synchronize();
  const snapshot = service.snapshot();
  if (!snapshot) throw new Error("missing snapshot");
  host.offline = true;
  const providers = structuredClone(snapshot.providers);
  providers.codex.workflows.pop();
  await expect(
    service.patch({ expectedRevision: snapshot.revision, providers }),
  ).rejects.toBeInstanceOf(ProfileSharingConflict);
  expect(service.snapshot()).toEqual(snapshot);
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
    const snapshot = service.snapshot();
    if (!snapshot) throw new Error("missing snapshot");
    const providers = structuredClone(snapshot.providers);
    providers.codex.workflows[0].name = "Polled review";
    await service.patch({ expectedRevision: snapshot.revision, providers });
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

test("distinct saved reasoning choices remain separate while legacy bindings retain historical values", async () => {
  const { host, service } = fixture();
  const profiles = [
    { id: "review", name: "Review", provider: "codex", model: "model-b", thinkingOptionId: "high" },
    {
      id: "careful",
      name: "Careful",
      provider: "codex",
      model: "model-b",
      thinkingOptionId: "medium",
    },
  ];
  host.config.agentProfiles = profiles;
  host.config.sharedProviderPreferences = planProviderPreferencesMigration({
    profiles,
    providers: {},
  }).preferences;
  await service.synchronize();
  const bindings = host.config.sharedProviderPreferences?.legacyProfiles;
  expect(bindings?.review.workflowId).not.toBe(bindings?.careful.workflowId);
  expect(bindings?.review.model).toBe("model-b");
  expect(bindings?.careful.thinkingOptionId).toBe("medium");
  const review = resolveProfileLaunch(
    { provider: "codex", profileId: "review" },
    [],
    0,
    host.config,
  );
  const careful = resolveProfileLaunch(
    { provider: "codex", profileId: "careful" },
    [],
    0,
    host.config,
  );
  expect(review.thinkingOptionId).toBe("high");
  expect(careful.thinkingOptionId).toBe("medium");
  const before = service.snapshot();
  await service.synchronize();
  expect(service.snapshot()).toEqual(before);
});

test("legacy journals require every environment before identity migration and preserve canonical IDs", async () => {
  const { container, host, journal, service } = fixture();
  await service.synchronize();
  const old = journal.read();
  if (!old) throw new Error("missing journal");
  for (const source of Object.values(old.sources)) delete source.projection;
  journal.state = old;
  host.offline = true;
  const upgraded = new InstallationProfiles(
    journal,
    [container, host],
    "00000000-0000-4000-8000-000000000001",
  );
  expect(upgraded.snapshot()).toBeNull();
  await expect(upgraded.synchronize()).rejects.toThrow("Connect every environment");
  expect(journal.read()).toEqual(old);
  host.offline = false;
  await upgraded.synchronize();
  expect(upgraded.snapshot()?.providers).toEqual(old.providers);
  expect(upgraded.admission("host").legacyProfiles.review.workflowId).toBe(
    host.config.sharedProviderPreferences?.legacyProfiles.review.workflowId,
  );
  expect(journal.backups).toBe(2);
});

test("migration imports detached definitions with their effective values and local account bindings", async () => {
  const { host, container, journal, service } = fixture();
  const preferences = host.config.sharedProviderPreferences;
  const containerPreferences = container.config.sharedProviderPreferences;
  if (!preferences || !containerPreferences) throw new Error("missing preferences");
  delete preferences.legacyProfiles.review;
  preferences.providers.codex.defaults.featureValues = { hostDefault: true };
  containerPreferences.providers.codex.defaults.featureValues = { containerDefault: true };
  host.config.providers = { local: { extends: "codex", env: { LOCAL_BINDING: "retained" } } };
  const detached = {
    id: "review",
    name: "Detached review",
    provider: "local",
    model: "detached-model",
    thinkingOptionId: "high",
    modeId: "full-access",
    instructions: "Retain these instructions",
    notes: "Retain these notes",
    featureValues: { detached: true },
    excludedEnvironments: [],
  };
  host.config.agentProfiles = [detached];
  const before = resolveProfileLaunch(
    { provider: "local", cwd: "/work", profileId: "review" },
    host.config.agentProfiles,
    0,
    host.config,
  );
  const accounts = structuredClone(host.config.providers);
  await service.synchronize();
  const after = resolveProfileLaunch(
    { provider: "local", cwd: "/work", profileId: "review" },
    host.config.agentProfiles,
    0,
    host.config,
  );
  expect(after).toMatchObject({
    provider: before.provider,
    model: before.model,
    thinkingOptionId: before.thinkingOptionId,
    modeId: before.modeId,
    featureValues: before.featureValues,
    systemPrompt: before.systemPrompt,
  });
  expect(after.profileLaunch?.profile).toMatchObject(detached);
  expect(host.config.providers).toEqual(accounts);
  expect(host.config.sharedProviderPreferences?.legacyProfiles.review.provider).toBe("local");
  expect(host.config.sharedProviderPreferences?.legacyProfiles.review).not.toHaveProperty("model");
  expect(journal.backups).toBe(1);
  const imported = service.snapshot();
  const binding = host.config.sharedProviderPreferences?.legacyProfiles.review;
  await service.synchronize();
  expect(service.snapshot()).toEqual(imported);
  expect(host.config.sharedProviderPreferences?.legacyProfiles.review).toEqual(binding);
});

test.each([
  {
    choice: "inherit",
    model: undefined,
    thinking: undefined,
    expectedModel: "model-b",
    expectedThinking: "medium",
  },
  {
    choice: "clear",
    model: null,
    thinking: null,
    expectedModel: "request-default",
    expectedThinking: undefined,
  },
  {
    choice: "override",
    model: "override-model",
    thinking: "high",
    expectedModel: "override-model",
    expectedThinking: "high",
  },
])(
  "migration preserves $choice model and reasoning bindings",
  async ({ model, thinking, expectedModel, expectedThinking }) => {
    const { host, service } = fixture();
    const preferences = host.config.sharedProviderPreferences;
    if (!preferences) throw new Error("missing preferences");
    preferences.providers.codex.defaults.thinkingOptionId = "medium";
    if (model === undefined) delete preferences.legacyProfiles.review.model;
    else preferences.legacyProfiles.review.model = model;
    if (thinking === undefined) delete preferences.legacyProfiles.review.thinkingOptionId;
    else preferences.legacyProfiles.review.thinkingOptionId = thinking;
    const input = {
      provider: "codex",
      cwd: "/work",
      profileId: "review",
      model: "request-default",
    };
    const before = resolveProfileLaunch(input, host.config.agentProfiles ?? [], 0, host.config);
    await service.synchronize();
    const after = resolveProfileLaunch(input, host.config.agentProfiles ?? [], 0, host.config);
    expect(before.model).toBe(expectedModel);
    expect(after.model).toBe(expectedModel);
    expect(before.thinkingOptionId).toBe(expectedThinking);
    expect(after.thinkingOptionId).toBe(expectedThinking);
    expect(host.config.sharedProviderPreferences?.legacyProfiles.review.model).toBe(model);
    expect(host.config.sharedProviderPreferences?.legacyProfiles.review.thinkingOptionId).toBe(
      thinking,
    );
  },
);

test("detached supervisor and worker aliases preserve distinct local account bindings", async () => {
  const { host, service } = fixture();
  host.config.providers = {
    parentAccount: { extends: "codex" },
    workerAccount: { extends: "codex" },
  };
  const profiles = [
    {
      id: "worker",
      name: "Worker",
      provider: "workerAccount",
      model: "worker-model",
      thinkingOptionId: "high",
      instructions: "Worker instructions",
    },
    {
      id: "team",
      name: "Team",
      provider: "parentAccount",
      model: "supervisor-model",
      workerProfileId: "worker",
      maxWorkers: 3,
    },
  ];
  host.config.agentProfiles = profiles;
  const preferences = planProviderPreferencesMigration({
    profiles,
    providers: host.config.providers,
  }).preferences;
  delete preferences.legacyProfiles.worker;
  delete preferences.legacyProfiles.team;
  host.config.sharedProviderPreferences = preferences;
  const input = { provider: "parentAccount", cwd: "/work", profileId: "team" };
  const before = resolveProfileLaunch(input, profiles, 0, host.config);
  await service.synchronize();
  const after = resolveProfileLaunch(input, profiles, 0, host.config);
  expect(after.provider).toBe(before.provider);
  expect(after.model).toBe(before.model);
  expect(after.profileLaunch?.profile.maxWorkers).toBe(3);
  expect(after.profileLaunch?.worker).toMatchObject(profiles[0]);
  expect(host.config.sharedProviderPreferences?.legacyProfiles.team.workerProfileId).toBe("worker");
  const retained = service.snapshot();
  delete host.config.providers.workerAccount;
  const unavailable = resolveProfileLaunch(input, profiles, 0, host.config);
  expect(unavailable.profileLaunch?.worker?.provider).toBe("workerAccount");
  expect(service.snapshot()).toEqual(retained);
  host.config.providers.workerAccount = { extends: "codex" };

  const snapshot = service.snapshot();
  if (!snapshot) throw new Error("missing snapshot");
  const workerId = host.config.sharedProviderPreferences?.legacyProfiles.worker.workflowId;
  const teamId = host.config.sharedProviderPreferences?.legacyProfiles.team.workflowId;
  const providers = structuredClone(snapshot.providers);
  const canonicalTeam = providers.codex.workflows.find((entry) => entry.id === teamId);
  if (!canonicalTeam) throw new Error("missing canonical team");
  providers.codex.workflows.push({
    id: "replacement-worker",
    name: "Replacement",
    provider: "codex",
    model: "replacement-model",
  });
  canonicalTeam.workerProfileId = sharedWorkflowProfileId("codex", "replacement-worker");
  await service.patch({ expectedRevision: snapshot.revision, providers });
  await service.synchronize();
  const updated = resolveProfileLaunch(input, profiles, 0, host.config);
  expect(updated.profileLaunch?.worker?.model).toBe("replacement-model");
  expect(updated.profileLaunch?.worker?.id).toBe(
    sharedWorkflowProfileId("parentAccount", "replacement-worker"),
  );
  expect(host.config.sharedProviderPreferences?.legacyProfiles.worker.workflowId).toBe(workerId);
});

test("detached worker references through shared account aliases preserve the selected account", async () => {
  const { host, service } = fixture();
  host.config.providers = {
    parentAccount: { extends: "codex" },
    workerAccount: { extends: "codex" },
  };
  const profiles = [
    { id: "worker", name: "Worker", provider: "workerAccount", model: "worker-model" },
    {
      id: "team",
      name: "Team",
      provider: "parentAccount",
      model: "supervisor-model",
      workerProfileId: sharedWorkflowProfileId("workerAccount", "old-worker"),
    },
  ];
  host.config.agentProfiles = profiles;
  const preferences = planProviderPreferencesMigration({
    profiles,
    providers: host.config.providers,
  }).preferences;
  preferences.workflowAliases = { codex: { "old-worker": "worker" } };
  delete preferences.legacyProfiles.team;
  host.config.sharedProviderPreferences = preferences;
  await service.synchronize();
  const launch = resolveProfileLaunch(
    { provider: "parentAccount", cwd: "/work", profileId: "team" },
    profiles,
    0,
    host.config,
  );
  expect(launch.profileLaunch?.worker?.provider).toBe("workerAccount");
  expect(launch.profileLaunch?.worker?.model).toBe("worker-model");
  const workerBinding = host.config.sharedProviderPreferences?.legacyProfiles.worker;
  expect(launch.profileLaunch?.worker?.id).toBe(
    sharedWorkflowProfileId("workerAccount", workerBinding?.workflowId ?? "missing"),
  );
});

test("legacy journal upgrade imports detached definitions without replacing existing canonical IDs", async () => {
  const { host, container, journal, service } = fixture();
  await service.synchronize();
  const old = journal.read();
  const preferences = host.config.sharedProviderPreferences;
  if (!old || !preferences) throw new Error("missing migration state");
  for (const source of Object.values(old.sources)) delete source.projection;
  journal.state = old;
  delete preferences.legacyProfiles.review;
  host.config.agentProfiles = [
    {
      id: "review",
      name: "Detached",
      provider: "codex",
      model: "detached-after-old-journal",
      instructions: "Retain upgrade instructions",
    },
  ];
  const upgraded = new InstallationProfiles(
    journal,
    [container, host],
    "00000000-0000-4000-8000-000000000001",
  );
  await upgraded.synchronize();
  const snapshot = upgraded.snapshot();
  if (!snapshot) throw new Error("missing snapshot");
  const canonicalIds = snapshot.providers.codex.workflows.map((entry) => entry.id);
  for (const workflow of old.providers.codex.workflows) expect(canonicalIds).toContain(workflow.id);
  const detached = resolveProfileLaunch(
    { provider: "codex", cwd: "/work", profileId: "review" },
    [],
    0,
    host.config,
  );
  expect(detached.model).toBe("detached-after-old-journal");
  expect(detached.systemPrompt).toBe("Retain upgrade instructions");
  const shared = resolveProfileLaunch(
    { provider: "codex", cwd: "/work", profileId: sharedWorkflowProfileId("codex", "review") },
    [],
    0,
    host.config,
  );
  expect(shared.model).toBe("model-b");
  expect(journal.backups).toBe(2);
  const restarted = new InstallationProfiles(
    journal,
    [container, host],
    "00000000-0000-4000-8000-000000000001",
  );
  await restarted.synchronize();
  expect(restarted.snapshot()).toEqual(snapshot);
});

test("deletes unreferenced canonical profiles without requiring offline caches", async () => {
  const { host, container, journal, service } = fixture();
  await service.synchronize();
  const snapshot = service.snapshot();
  if (!snapshot) throw new Error("missing snapshot");
  const providers = structuredClone(snapshot.providers);
  providers.codex.workflows.push({
    id: "unreferenced",
    name: "Unreferenced",
    provider: "codex",
    model: "temporary",
  });
  const added = await service.patch({ expectedRevision: snapshot.revision, providers });
  const saved = journal.read();
  if (!saved) throw new Error("missing journal");
  saved.sources.host.retainedWorkflows.codex.push("unreferenced");
  journal.state = saved;
  const restarted = new InstallationProfiles(
    journal,
    [container, host],
    "00000000-0000-4000-8000-000000000001",
  );
  host.offline = true;
  const deleted = await restarted.patch({
    expectedRevision: added.revision,
    providers: snapshot.providers,
  });
  expect(deleted.providers).toEqual(snapshot.providers);
  expect(deleted.revision).toBe(added.revision + 1);
});

test("deletion rejects a concrete shared launch alias even without a legacy profile binding", async () => {
  const { host, service } = fixture();
  const preferences = host.config.sharedProviderPreferences;
  if (!preferences) throw new Error("missing preferences");
  preferences.legacyProfiles = {};
  host.config.agentProfiles = [];
  await service.synchronize();
  const snapshot = service.snapshot();
  const state = service.inspect();
  if (!snapshot || !state) throw new Error("missing snapshot");
  const target = state.sources.host.projection?.workflowAliases?.codex.review;
  if (!target) throw new Error("missing alias");
  const bindings = Object.values(state.sources).flatMap((source) =>
    Object.values(source.projection?.legacyProfiles ?? {}),
  );
  expect(bindings.some((binding) => binding.workflowId === target)).toBe(false);
  const providers = structuredClone(snapshot.providers);
  providers.codex.workflows = providers.codex.workflows.filter(
    (workflow) => workflow.id !== target,
  );
  await expect(
    service.patch({ expectedRevision: snapshot.revision, providers }),
  ).rejects.toBeInstanceOf(ProfileSharingConflict);
  expect(service.snapshot()).toEqual(snapshot);
});

test("deletion rejects a surviving worker reference and allows removing the unreferenced team and worker together", async () => {
  const { service } = fixture();
  await service.synchronize();
  const snapshot = service.snapshot();
  if (!snapshot) throw new Error("missing snapshot");
  const providers = structuredClone(snapshot.providers);
  providers.codex.workflows.push(
    { id: "new-worker", name: "Worker", provider: "codex", model: "worker" },
    {
      id: "new-team",
      name: "Team",
      provider: "codex",
      model: "team",
      workerProfileId: sharedWorkflowProfileId("codex", "new-worker"),
    },
  );
  const added = await service.patch({ expectedRevision: snapshot.revision, providers });
  const deletedWorker = structuredClone(added.providers);
  deletedWorker.codex.workflows = deletedWorker.codex.workflows.filter(
    (workflow) => workflow.id !== "new-worker",
  );
  await expect(
    service.patch({ expectedRevision: added.revision, providers: deletedWorker }),
  ).rejects.toBeInstanceOf(ProfileSharingConflict);
  expect(service.snapshot()).toEqual(added);
  const deletedBoth = await service.patch({
    expectedRevision: added.revision,
    providers: snapshot.providers,
  });
  expect(deletedBoth.providers).toEqual(snapshot.providers);
});

test("detached profiles with omitted model, reasoning and mode do not inherit canonical defaults", async () => {
  const { host, container, service } = fixture();
  const preferences = host.config.sharedProviderPreferences;
  const containerPreferences = container.config.sharedProviderPreferences;
  if (!preferences || !containerPreferences) throw new Error("missing preferences");
  delete preferences.legacyProfiles.review;
  host.config.agentProfiles = [{ id: "review", name: "Provider defaults", provider: "codex" }];
  containerPreferences.providers.codex.defaults.thinkingOptionId = "high";
  containerPreferences.providers.codex.defaults.modeId = "full-access";
  const input = { provider: "codex", cwd: "/work", profileId: "review", model: "request-default" };
  const before = resolveProfileLaunch(input, host.config.agentProfiles, 0, host.config);
  await service.synchronize();
  const after = resolveProfileLaunch(input, host.config.agentProfiles, 0, host.config);
  expect(after.model).toBe(before.model);
  expect(after.model).toBe("request-default");
  expect(after.thinkingOptionId).toBe(before.thinkingOptionId);
  expect(after.modeId).toBe(before.modeId);
});

test("deletion rejects a concrete default worker binding until the binding is removed", async () => {
  const { service } = fixture();
  await service.synchronize();
  const snapshot = service.snapshot();
  if (!snapshot) throw new Error("missing snapshot");
  const providers = structuredClone(snapshot.providers);
  providers.pi = {
    defaults: {},
    preferredModels: [],
    preferredThinkingOptions: [],
    defaultWorkflowId: null,
    workflows: [
      { id: "default-worker", name: "Default worker", provider: "pi", model: "local-worker" },
    ],
  };
  providers.codex.defaults.workerProfileId = sharedWorkflowProfileId("pi", "default-worker");
  const added = await service.patch({ expectedRevision: snapshot.revision, providers });
  const missingWorker = structuredClone(added.providers);
  delete missingWorker.pi;
  await expect(
    service.patch({ expectedRevision: added.revision, providers: missingWorker }),
  ).rejects.toBeInstanceOf(ProfileSharingConflict);
  expect(service.snapshot()).toEqual(added);
  delete missingWorker.codex.defaults.workerProfileId;
  const deleted = await service.patch({
    expectedRevision: added.revision,
    providers: missingWorker,
  });
  expect(deleted.providers).toEqual(snapshot.providers);
});

test("legacy journal upgrade recovers worker account bindings from the original launch aliases", async () => {
  const { host, container, journal, service } = fixture();
  const installationAccountId = "71fca551-79a4-4af9-b9e6-9ec7222f9e1d";
  host.config.providers = {
    parentAccount: { extends: "codex" },
    workerAccount: { extends: "codex", installationAccountId },
  };
  container.config.providers = {
    devParent: { extends: "codex" },
    devWorker: { extends: "codex", installationAccountId },
  };
  const profiles = [
    { id: "worker", name: "Worker", provider: "workerAccount", model: "worker-model" },
    {
      id: "team",
      name: "Team",
      provider: "parentAccount",
      model: "supervisor-model",
      workerProfileId: "worker",
    },
  ];
  host.config.agentProfiles = profiles;
  host.config.sharedProviderPreferences = planProviderPreferencesMigration({
    profiles,
    providers: host.config.providers,
  }).preferences;
  await service.synchronize();
  const old = journal.read();
  const preferences = host.config.sharedProviderPreferences;
  if (!old || !preferences) throw new Error("missing migration state");
  for (const source of Object.values(old.sources)) delete source.projection;
  delete preferences.workflowWorkerBindings;
  delete container.config.sharedProviderPreferences!.workflowWorkerBindings;
  for (const binding of Object.values(preferences.legacyProfiles)) delete binding.workerProfileId;
  journal.state = old;
  const upgraded = new InstallationProfiles(
    journal,
    [container, host],
    "00000000-0000-4000-8000-000000000001",
  );
  await upgraded.synchronize();
  const team = resolveProfileLaunch(
    { provider: "parentAccount", cwd: "/work", profileId: "team" },
    profiles,
    0,
    host.config,
  );
  expect(team.profileLaunch?.worker?.id).toBe("worker");
  expect(team.profileLaunch?.worker?.provider).toBe("workerAccount");
  expect(team.profileLaunch?.worker?.model).toBe("worker-model");
  const imported = upgraded
    .snapshot()!
    .providers.codex.workflows.find((profile) => profile.name === "Team")!;
  const moved = resolveProfileLaunch(
    {
      provider: "devParent",
      cwd: "/work",
      profileId: sharedWorkflowProfileId("devParent", imported.id),
    },
    container.config.agentProfiles ?? [],
    0,
    container.config,
  );
  expect(moved.profileLaunch?.worker?.provider).toBe("devWorker");
});

test("legacy overrides stay compatibility records instead of creating account profiles", () => {
  const { preferences } = planProviderPreferencesMigration({
    profiles: [
      {
        id: "shared",
        name: "Review",
        provider: "codex",
        model: "astra",
        thinkingOptionId: "medium",
      },
    ],
    providers: {},
  });
  preferences.legacyProfiles.old = {
    provider: "account-two",
    providerType: "codex",
    workflowId: "shared",
    model: "astra",
    thinkingOptionId: "ultra",
  };
  const normalized = normalizeLegacyProfileValues(preferences);
  expect(normalized.providers.codex.workflows).toEqual(preferences.providers.codex.workflows);
  expect(normalized.legacyProfiles.old).toEqual(preferences.legacyProfiles.old);
});

test("consolidation merges exact duplicates while preserving aliases and different reasoning", () => {
  const { preferences } = planProviderPreferencesMigration({
    profiles: [
      {
        id: "shared",
        name: "Review",
        provider: "codex",
        model: "astra",
        thinkingOptionId: "medium",
      },
    ],
    providers: {},
  });
  const workflow = preferences.providers.codex.workflows[0];
  preferences.providers.codex.workflows.push(
    { ...workflow, id: "account-copy" },
    { ...workflow, id: "deep", thinkingOptionId: "ultra" },
  );
  preferences.legacyProfiles.old = {
    provider: "account-two",
    providerType: "codex",
    workflowId: "account-copy",
  };
  const normalized = consolidateProfileDefinitions(preferences);
  expect(normalized.providers.codex.workflows.map((item) => item.id)).toEqual(["shared", "deep"]);
  expect(normalized.workflowAliases?.codex["account-copy"]).toBe("shared");
  expect(normalized.legacyProfiles.old).toEqual({
    provider: "account-two",
    providerType: "codex",
    workflowId: "shared",
  });
  expect(consolidateProfileDefinitions(normalized)).toEqual(normalized);
  expect(preferences.providers.codex.workflows).toHaveLength(3);
});

test("existing installations consolidate once and keep old launch references usable", async () => {
  const { container, host, journal, service } = fixture();
  await service.synchronize();
  const state = service.inspect()!;
  const original = state.providers.codex.workflows[0];
  state.providers.codex.workflows.push({ ...original, id: "account-copy" });
  for (const source of Object.values(state.sources)) {
    source.projection!.providers = structuredClone(state.providers);
    source.projection!.legacyProfiles["old-copy"] = {
      provider: "codex",
      providerType: "codex",
      workflowId: "account-copy",
    };
  }
  journal.state = state;
  const restarted = new InstallationProfiles(
    journal,
    [container, host],
    "00000000-0000-4000-8000-000000000001",
  );
  await restarted.synchronize();
  const consolidated = restarted.inspect()!;
  expect(consolidated.providers.codex.workflows).toHaveLength(
    state.providers.codex.workflows.length - 1,
  );
  expect(consolidated.sources.host.projection!.workflowAliases?.codex["account-copy"]).toBe(
    original.id,
  );
  const launch = resolveProfileLaunch(
    { provider: "codex", profileId: "shared-workflow/codex/account-copy" },
    [],
    0,
    host.config,
  );
  expect(launch.model).toBe(original.model ?? state.providers.codex.defaults.model);
  const revision = consolidated.revision;
  await restarted.synchronize();
  expect(restarted.inspect()!.revision).toBe(revision);
  expect(journal.backups).toBe(2);
});

test("explicit worker account survives coordinator save, reload and both environment projections", async () => {
  const { service, host, container, journal } = fixture();
  host.workerAccounts = true;
  container.workerAccounts = true;
  host.config.providers = {
    "worker-host": { extends: "codex", installationAccountId: "worker-account", enabled: true },
  };
  container.config.providers = {
    "worker-dev": { extends: "codex", installationAccountId: "worker-account", enabled: true },
  };
  await service.synchronize();
  const snapshot = service.snapshot()!;
  const providers = structuredClone(snapshot.providers);
  providers.codex.workflows.push({
    id: "explicit-worker",
    name: "Explicit worker",
    provider: "codex",
    model: "worker-model",
  });
  providers.claude = {
    defaults: {},
    preferredModels: [],
    preferredThinkingOptions: [],
    defaultWorkflowId: "explicit-team",
    workflows: [
      {
        id: "explicit-team",
        name: "Explicit team",
        provider: "claude",
        model: "claude-model",
        workerProfileId: "shared-profile/codex/explicit-worker",
        workerAccount: "installation-account/worker-account",
      },
    ],
  };
  const saved = await service.patch({ expectedRevision: snapshot.revision, providers });
  expect(saved.workerAccounts).toBe(true);
  await service.synchronize();
  const reloaded = new InstallationProfiles(
    journal,
    [host, container],
    "00000000-0000-4000-8000-000000000001",
  );
  expect(reloaded.snapshot()?.providers.claude.workflows[0].workerAccount).toBe(
    "installation-account/worker-account",
  );
  for (const [environment, account] of [
    [host, "worker-host"],
    [container, "worker-dev"],
  ] as const) {
    const launch = resolveProfileLaunch(
      { provider: "claude", cwd: "/work", profileId: "shared-profile/claude/explicit-team" },
      [],
      0,
      environment.config,
    );
    expect(launch.profileLaunch?.worker?.provider).toBe(account);
    expect(launch.profileLaunch?.worker?.model).toBe("worker-model");
  }
});

test("coordinator refuses a new explicit worker account until every environment supports it", async () => {
  const { service, host, container } = fixture();
  host.workerAccounts = true;
  container.workerAccounts = false;
  await service.synchronize();
  const snapshot = service.snapshot()!;
  const providers = structuredClone(snapshot.providers);
  providers.codex.workflows[0].workerAccount = "installation-account/new-worker";
  await expect(
    service.patch({ expectedRevision: snapshot.revision, providers }),
  ).rejects.toBeInstanceOf(ProfileSharingConflict);
  expect(service.snapshot()).toEqual(snapshot);
});

test("an explicit worker account cannot fall back to another account when unavailable", async () => {
  const { service, host, container } = fixture();
  host.workerAccounts = true;
  container.workerAccounts = true;
  host.config.providers = {
    chosen: { extends: "codex", installationAccountId: "chosen-account", enabled: true },
    other: { extends: "codex", enabled: true },
  };
  container.config.providers = {
    chosen: { extends: "codex", installationAccountId: "chosen-account", enabled: true },
  };
  await service.synchronize();
  const snapshot = service.snapshot()!;
  const providers = structuredClone(snapshot.providers);
  providers.codex.workflows.push(
    { id: "worker", name: "Worker", provider: "codex", model: "worker" },
    {
      id: "team",
      name: "Team",
      provider: "codex",
      model: "supervisor",
      workerProfileId: "shared-profile/codex/worker",
      workerAccount: "installation-account/chosen-account",
    },
  );
  await service.patch({ expectedRevision: snapshot.revision, providers });
  await service.synchronize();
  host.config.providers.chosen.enabled = false;
  expect(() =>
    resolveProfileLaunch(
      { provider: "other", cwd: "/work", profileId: "shared-profile/codex/team" },
      [],
      0,
      host.config,
    ),
  ).toThrow("worker account is unavailable");
});
