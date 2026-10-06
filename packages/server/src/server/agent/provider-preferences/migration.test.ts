import { describe, expect, test } from "vitest";
import {
  materializeLegacyProfiles,
  materializeSharedProfiles,
  sharedProfileDefinitions,
} from "@getpaseo/protocol/provider-preferences";
import { planProviderPreferencesMigration } from "./migration.js";

describe("shared provider preference migration", () => {
  test("retains reasoning, permission and team differences in shared profile definitions", () => {
    const plan = planProviderPreferencesMigration({
      profiles: [
        {
          id: "a",
          name: "Medium",
          provider: "account-a",
          model: "astra",
          thinkingOptionId: "medium",
          modeId: "full-access",
          isDefault: true,
        },
        {
          id: "b",
          name: "Ultra",
          provider: "account-b",
          model: "astra",
          thinkingOptionId: "ultra",
          modeId: "full-access",
        },
        { id: "safe", name: "Review", provider: "account-b", model: "astra", modeId: "read-only" },
        {
          id: "team",
          name: "Local team",
          provider: "account-a",
          model: "astra",
          thinkingOptionId: "ultra",
          modeId: "full-access",
          workerProfileId: "b",
          maxWorkers: 2,
        },
      ],
      providers: { "account-a": { extends: "codex" }, "account-b": { extends: "codex" } },
    });
    expect(plan.preferences.providers.codex.workflows.map((workflow) => workflow.id)).toEqual([
      "a",
      "b",
      "safe",
      "team",
    ]);
    expect(plan.preferences.providers.codex.preferredThinkingOptions).toEqual(["medium", "ultra"]);
    expect(plan.preferences.providers.codex.defaultWorkflowId).toBe("a");
    expect(plan.preferences.legacyProfiles.b).toEqual({
      provider: "account-b",
      providerType: "codex",
      workflowId: "b",
      model: "astra",
      thinkingOptionId: "ultra",
    });
    expect(plan.preferences.providers.codex.workflows[3].workerProfileId).toBe("b");
    expect(plan.report.mergedProfiles).toEqual([]);
  });
});

test("retains absent legacy overrides and gives a newly added account the shared workflows", () => {
  const providers = { one: { extends: "codex" }, two: { extends: "codex" } };
  const { preferences } = planProviderPreferencesMigration({
    providers,
    profiles: [
      {
        id: "explicit",
        name: "Explicit",
        provider: "one",
        model: "astra",
        thinkingOptionId: "high",
        modeId: "full-access",
        isDefault: true,
      },
      { id: "implicit", name: "Provider defaults", provider: "one" },
    ],
  });
  const implicit = materializeLegacyProfiles(preferences).find(
    (profile) => profile.id === "implicit",
  )!;
  expect(implicit.model).toBeUndefined();
  expect(implicit.thinkingOptionId).toBeUndefined();
  expect(implicit.modeId).toBe("");
  const inherited = materializeSharedProfiles({ preferences, providers, providerIds: ["two"] });
  expect(inherited).toHaveLength(2);
  expect(inherited[0]).toMatchObject({ provider: "two", model: "astra", thinkingOptionId: "high" });
});

test("the profile library has one identity across accounts", () => {
  const profiles = ["one", "two"].map((provider) => ({
    id: provider,
    name: "Review",
    provider,
    model: "astra",
    thinkingOptionId: "high",
  }));
  const providers = { one: { extends: "codex" }, two: { extends: "codex" } };
  const { preferences } = planProviderPreferencesMigration({ profiles, providers });
  const library = sharedProfileDefinitions(preferences);
  expect(library).toHaveLength(1);
  expect(library[0]).toMatchObject({
    id: "shared-profile/codex/one",
    provider: "codex",
    model: "astra",
    thinkingOptionId: "high",
  });
  expect(preferences.legacyProfiles.two.workflowId).toBe("one");
});

test("migration preserves profiles with distinct names or delegation notes", () => {
  const profiles = [
    { id: "review", name: "Review", provider: "one", model: "astra" },
    { id: "write", name: "Write", provider: "two", model: "astra" },
    { id: "ui", name: "Review", provider: "two", model: "astra", notes: "Use for interface work" },
  ];
  const { preferences } = planProviderPreferencesMigration({
    profiles,
    providers: { one: { extends: "codex" }, two: { extends: "codex" } },
  });
  expect(sharedProfileDefinitions(preferences).map((profile) => profile.name)).toEqual([
    "Review",
    "Write",
    "Review",
  ]);
});
