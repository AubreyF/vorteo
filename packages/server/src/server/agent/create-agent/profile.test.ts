import { describe, expect, it } from "vitest";
import { resolveProfileLaunch } from "./profile.js";
import { MutableDaemonConfigSchema } from "@getpaseo/protocol/messages";
import { planProviderPreferencesMigration } from "../provider-preferences/migration.js";
import { sharedWorkflowProfileId, sharedProfileId } from "@getpaseo/protocol/provider-preferences";
import { ProviderDefaultsSchema } from "@getpaseo/protocol/provider-preferences";
import { AgentProfileSchema } from "@getpaseo/protocol/messages";

it("shares workflow permissions across accounts while freezing explicit reasoning and team selection", () => {
  const profiles = [
    {
      id: "everyday",
      name: "Everyday",
      provider: "one",
      model: "astra",
      thinkingOptionId: "medium",
      modeId: "full-access",
    },
    {
      id: "team",
      name: "Team",
      provider: "one",
      model: "astra",
      modeId: "full-access",
      workerProfileId: "worker",
      maxWorkers: 2,
    },
    { id: "worker", name: "Worker", provider: "pi", model: "local" },
  ];
  const providers = { one: { extends: "codex" }, two: { extends: "codex" } };
  const { preferences } = planProviderPreferencesMigration({ profiles, providers });
  const settings = MutableDaemonConfigSchema.parse({
    mcp: { injectIntoAgents: true },
    providers,
    sharedProviderPreferences: preferences,
  });
  const launch = resolveProfileLaunch(
    {
      provider: "two",
      cwd: "/work",
      profileId: sharedWorkflowProfileId("two", "everyday"),
      model: "astra",
      thinkingOptionId: "ultra",
      modeId: "stale-mode",
    },
    profiles,
    1000,
    settings,
  );
  expect(launch).toMatchObject({
    provider: "two",
    model: "astra",
    thinkingOptionId: "ultra",
    modeId: "full-access",
    profileLaunch: { providerType: "codex", configurationRevision: 1, workflowId: "everyday" },
  });
  expect(launch.profileLaunch?.worker).toBeUndefined();
  const team = resolveProfileLaunch(
    { provider: "two", cwd: "/work", profileId: sharedWorkflowProfileId("two", "team") },
    profiles,
    1000,
    settings,
  );
  expect(team.profileLaunch?.worker).toEqual(profiles[2]);
  preferences.providers.codex.workflows[0].modeId = "read-only";
  expect(resolveProfileLaunch(launch, profiles, 2000, settings).modeId).toBe("full-access");
});

describe("profile launch", () => {
  const profile = {
    id: "supervisor",
    name: "Frontier with local workers",
    provider: "codex-primary",
    model: "frontier",
    thinkingOptionId: "high",
    modeId: "unsafe",
    instructions: "Review every worker diff.",
    workerProfileId: "local",
    maxWorkers: 2,
  };
  const worker = { id: "local", name: "Local fast", provider: "pi", model: "local-model" };

  it("applies and freezes profile permissions when the launch omits a mode", () => {
    const saved = { ...profile, modeId: "full-access" };
    const config = resolveProfileLaunch({ provider: "stale", cwd: "/work", profileId: saved.id }, [
      saved,
      worker,
    ]);
    expect(config.modeId).toBe("full-access");
    saved.modeId = "auto-review";
    expect(resolveProfileLaunch(config, [saved, worker]).modeId).toBe("full-access");
  });

  it("resolves on the server without overriding the separately selected permissions", () => {
    const config = resolveProfileLaunch(
      {
        provider: "stale",
        cwd: "/work",
        profileId: profile.id,
        modeId: "read-only",
        systemPrompt: "Project instructions.",
      },
      [profile, worker],
    );
    expect(config.provider).toBe("codex-primary");
    expect(config.modeId).toBe("read-only");
    expect(config.model).toBe("frontier");
    expect(config.systemPrompt).toContain("Review every worker diff.");
    expect(config.systemPrompt).toContain("Project instructions.");
    expect(config.profileLaunch?.worker).toEqual(worker);
    expect(config.profileId).toBeUndefined();
    profile.instructions = "Changed later.";
    expect(config.profileLaunch?.profile.instructions).toBe("Review every worker diff.");
    expect(resolveProfileLaunch(config, [])).toEqual(config);
  });

  it("refuses missing profiles and recursive teams", () => {
    const config = { provider: "codex", cwd: "/work", profileId: "missing" };
    expect(() => resolveProfileLaunch(config, [])).toThrow("not found");
    expect(() =>
      resolveProfileLaunch({ ...config, profileId: profile.id }, [
        profile,
        { ...worker, workerProfileId: profile.id },
      ]),
    ).toThrow("cannot supervise");
  });
});

describe("reserve launch policy", () => {
  const profile = {
    id: "secondary",
    name: "Secondary",
    provider: "codex-secondary",
    quotaReservePolicy: { kind: "protected" as const, cruisePct: 25, redlinePct: 12 },
  };
  const config = { provider: "codex-secondary", cwd: "/work", profileId: profile.id };

  it("does not attach a profile policy without explicit launch opt-in", () => {
    expect(resolveProfileLaunch(config, [profile]).quotaReserve).toBeUndefined();
  });

  it("freezes the profile defaults and consumes the launch-only request", () => {
    const mutableProfile = structuredClone(profile);
    const resolved = resolveProfileLaunch(
      { ...config, quotaReservePolicy: { kind: "profile" } },
      [mutableProfile],
      1000,
    );
    mutableProfile.quotaReservePolicy.cruisePct = 90;
    expect(resolved.quotaReserve).toEqual({
      policy: { kind: "protected", cruisePct: 25, redlinePct: 12 },
      state: { kind: "ready", revision: 0, changedAt: new Date(1000).toISOString() },
    });
    expect(resolved.quotaReservePolicy).toBeUndefined();
    expect(resolveProfileLaunch(resolved, [])).toEqual(resolved);
  });

  it("uses the approved 15/10 defaults when a profile has no reserve setting", () => {
    const resolved = resolveProfileLaunch({ ...config, quotaReservePolicy: { kind: "profile" } }, [
      { id: profile.id, name: profile.name, provider: profile.provider },
    ]);
    expect(resolved.quotaReserve?.policy).toEqual({
      kind: "protected",
      cruisePct: 15,
      redlinePct: 10,
    });
  });

  it("allows an explicit task override including Off", () => {
    expect(
      resolveProfileLaunch({ ...config, quotaReservePolicy: { kind: "off" } }, [profile])
        .quotaReserve?.policy,
    ).toEqual({ kind: "off" });
    expect(
      resolveProfileLaunch(
        { ...config, quotaReservePolicy: { kind: "protected", cruisePct: 40, redlinePct: 20 } },
        [profile],
      ).quotaReserve?.policy,
    ).toEqual({ kind: "protected", cruisePct: 40, redlinePct: 20 });
  });

  it("rejects invalid threshold ordering and reattachment to a frozen task", () => {
    expect(() =>
      resolveProfileLaunch(
        { ...config, quotaReservePolicy: { kind: "protected", cruisePct: 10, redlinePct: 15 } },
        [profile],
      ),
    ).toThrow("Redline must be lower");
    const frozen = resolveProfileLaunch({ ...config, quotaReservePolicy: { kind: "profile" } }, [
      profile,
    ]);
    expect(() =>
      resolveProfileLaunch({ ...frozen, quotaReservePolicy: { kind: "off" } }, [profile]),
    ).toThrow("Use task controls");
  });
});

it("a frozen shared worker ignores mutable model and reasoning overrides", () => {
  const worker = {
    id: "shared-workflow/codex/worker",
    name: "Worker",
    provider: "codex",
    model: "astra",
    thinkingOptionId: "medium",
  };
  const resolved = resolveProfileLaunch(
    {
      provider: "codex",
      cwd: "/tmp",
      profileId: worker.id,
      model: "other",
      thinkingOptionId: "high",
    },
    [worker],
  );
  expect(resolved.model).toBe("astra");
  expect(resolved.thinkingOptionId).toBe("medium");
});

it("rejects a migrated workflow selected from another account", () => {
  const providers = { one: { extends: "codex" }, two: { extends: "codex" } };
  const profiles = [{ id: "review", name: "Review", provider: "one", model: "astra" }];
  const { preferences } = planProviderPreferencesMigration({ profiles, providers });
  preferences.workflowAliases = { codex: { "old-review": "review" } };
  const settings = MutableDaemonConfigSchema.parse({
    mcp: { injectIntoAgents: false },
    providers,
    sharedProviderPreferences: preferences,
  });
  expect(() =>
    resolveProfileLaunch(
      { provider: "two", profileId: sharedWorkflowProfileId("one", "old-review") },
      profiles,
      0,
      settings,
    ),
  ).toThrow("The selected workflow belongs to another account.");
});

it("stores exclusions only on individual profiles and preserves explicit clearing", () => {
  expect(ProviderDefaultsSchema.parse({ model: "astra", excludedEnvironments: ["host"] })).toEqual({
    model: "astra",
  });
  expect(
    AgentProfileSchema.parse({
      id: "review",
      name: "Review",
      provider: "codex",
      excludedEnvironments: [],
    }).excludedEnvironments,
  ).toEqual([]);
});

it("rejects excluded profiles and worker teams before freezing a launch", () => {
  const worker = {
    id: "worker",
    name: "Worker",
    provider: "codex",
    model: "astra",
    excludedEnvironments: ["host" as const],
  };
  const team = {
    id: "team",
    name: "Team",
    provider: "codex",
    model: "astra",
    workerProfileId: "worker",
  };
  expect(() =>
    resolveProfileLaunch(
      { provider: "codex", profileId: "worker" },
      [worker],
      0,
      undefined,
      "host",
    ),
  ).toThrow("excluded from the host");
  expect(() =>
    resolveProfileLaunch(
      { provider: "codex", profileId: "team" },
      [team, worker],
      0,
      undefined,
      "host",
    ),
  ).toThrow("excluded from the host");
  const launch = resolveProfileLaunch(
    { provider: "codex", profileId: "worker" },
    [worker],
    0,
    undefined,
    "container",
  );
  expect(launch.profileLaunch?.profile.id).toBe("worker");
  expect(resolveProfileLaunch(launch, [], 1, undefined, "host")).toEqual(launch);
});

it("canonical installation profiles ignore local model and reasoning edits", () => {
  const profiles = [
    { id: "review", name: "Review", provider: "codex", model: "astra", thinkingOptionId: "medium" },
  ];
  const preferences = planProviderPreferencesMigration({ profiles, providers: {} }).preferences;
  preferences.providers.codex.workflows[0].thinkingOptionId = "medium";
  preferences.installation = {
    installationId: "00000000-0000-4000-8000-000000000001",
    environment: "host",
    serverId: "host",
    revision: 1,
  };
  const settings = MutableDaemonConfigSchema.parse({
    mcp: { injectIntoAgents: false },
    sharedProviderPreferences: preferences,
  });
  const launch = resolveProfileLaunch(
    {
      provider: "codex",
      profileId: sharedWorkflowProfileId("codex", "review"),
      model: "other",
      thinkingOptionId: "ultra",
    },
    [],
    0,
    settings,
  );
  expect(launch.model).toBe("astra");
  expect(launch.thinkingOptionId).toBe("medium");
  expect(() =>
    resolveProfileLaunch(
      { provider: "codex", cwd: "/work", profileId: "local-only" },
      [{ id: "local-only", name: "Cache edit", provider: "codex", model: "other" }],
      0,
      settings,
    ),
  ).toThrow("not found");
});

it("one canonical profile launches on either account without changing its identity", () => {
  const providers = { one: { extends: "codex" }, two: { extends: "codex" } };
  const profiles = [
    { id: "review", name: "Review", provider: "one", model: "astra", thinkingOptionId: "high" },
  ];
  const preferences = planProviderPreferencesMigration({ profiles, providers }).preferences;
  const settings = MutableDaemonConfigSchema.parse({
    mcp: { injectIntoAgents: false },
    providers,
    sharedProviderPreferences: preferences,
  });
  const profileId = sharedProfileId("codex", "review");
  for (const provider of ["one", "two"]) {
    const launch = resolveProfileLaunch({ provider, profileId }, [], 0, settings);
    expect(launch.provider).toBe(provider);
    expect(launch.profileLaunch?.profile.id).toBe(profileId);
    expect(launch.profileLaunch?.workflowId).toBe("review");
    expect(launch.model).toBe("astra");
    expect(launch.thinkingOptionId).toBe("high");
  }
});

it("new teams bind same-provider workers to the parent account and retain local worker providers", () => {
  const providers = { one: { extends: "codex" }, two: { extends: "codex" }, pi: {} };
  const profiles = [
    { id: "team", name: "Team", provider: "one", model: "astra", workerProfileId: "worker" },
    { id: "worker", name: "Worker", provider: "two", model: "sol", thinkingOptionId: "low" },
    {
      id: "local-team",
      name: "Local team",
      provider: "one",
      model: "astra",
      workerProfileId: "local",
    },
    { id: "local", name: "Local", provider: "pi", model: "local-model" },
  ];
  const preferences = planProviderPreferencesMigration({ profiles, providers }).preferences;
  const settings = MutableDaemonConfigSchema.parse({
    mcp: { injectIntoAgents: false },
    providers,
    sharedProviderPreferences: preferences,
  });
  for (const provider of ["one", "two"]) {
    const team = resolveProfileLaunch(
      { provider, profileId: sharedProfileId("codex", "team") },
      [],
      0,
      settings,
    );
    expect(team.profileLaunch?.worker).toMatchObject({
      id: sharedProfileId("codex", "worker"),
      provider,
      model: "sol",
      thinkingOptionId: "low",
    });
    const local = resolveProfileLaunch(
      { provider, profileId: sharedProfileId("codex", "local-team") },
      [],
      0,
      settings,
    );
    expect(local.profileLaunch?.worker).toMatchObject({
      id: sharedProfileId("pi", "local"),
      provider: "pi",
      model: "local-model",
    });
  }
  const oldTeam = resolveProfileLaunch(
    { provider: "one", profileId: sharedWorkflowProfileId("one", "team") },
    [],
    0,
    settings,
  );
  expect(oldTeam.profileLaunch?.worker?.provider).toBe("two");
});
