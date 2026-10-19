import { expect, test } from "vitest";
import { profileCatalogState, sharedChoiceState } from "./shared-choices";

test("keeps shared reasoning visible but unavailable on a limited account", () => {
  const full = {
    status: "ready" as const,
    models: [
      {
        provider: "one",
        id: "model",
        label: "Model",
        thinkingOptions: [
          { id: "medium", label: "Medium" },
          { id: "high", label: "High" },
        ],
      },
    ],
  };
  const limited = {
    status: "ready" as const,
    models: [
      {
        provider: "two",
        id: "model",
        label: "Model",
        thinkingOptions: [{ id: "medium", label: "Medium" }],
      },
    ],
  };
  const selection = sharedChoiceState({
    profile: { id: "workflow", name: "Everyday", provider: "two", model: "model" },
    choices: { model: "model", thinkingOptionId: "high" },
    entry: limited,
    family: [full, limited],
  });
  expect(selection.choices).toEqual({ model: "model", thinkingOptionId: "high" });
  expect(selection.unavailable).toBe(true);
  expect(selection.thinkingOptions).toContainEqual({
    id: "high",
    value: "high",
    label: "High",
    available: false,
  });
  const supported = sharedChoiceState({
    profile: { id: "workflow", name: "Everyday", provider: "one", model: "model" },
    choices: selection.choices,
    entry: full,
    family: [full, limited],
  });
  expect(supported.unavailable).toBe(false);
  expect(supported.choices).toEqual(selection.choices);
});

test("missing or failed discovery is not an incompatible profile", () => {
  const profile = {
    id: "saved",
    name: "Saved",
    provider: "one",
    model: "model",
    thinkingOptionId: "high",
  };
  for (const entry of [
    undefined,
    { status: "loading" as const },
    { status: "error" as const },
    { status: "ready" as const },
  ]) {
    const selection = sharedChoiceState({ profile, choices: {}, entry });
    expect(selection.unavailable).toBe(false);
    expect(selection.modelError).toBe(null);
    expect(selection.thinkingError).toBe(null);
  }
});

test("uses the account default model to check a profile with only reasoning saved", () => {
  const selection = sharedChoiceState({
    profile: { id: "default", name: "Default model", provider: "one", thinkingOptionId: "high" },
    choices: {},
    entry: {
      status: "ready",
      models: [
        {
          id: "default-model",
          provider: "one",
          label: "Default",
          isDefault: true,
          thinkingOptions: [{ id: "high", label: "High" }],
        },
      ],
    },
  });
  expect(selection.choices).toEqual({ model: "", thinkingOptionId: "high" });
  expect(selection.unavailable).toBe(false);
});

test("distinguishes discovery states from a completed empty catalog", () => {
  expect(profileCatalogState(undefined)).toBe("loading");
  expect(profileCatalogState({ status: "loading", models: [] })).toBe("loading");
  expect(profileCatalogState({ status: "error", models: [] })).toBe("error");
  expect(profileCatalogState({ status: "ready" })).toBe("error");
  expect(profileCatalogState({ status: "ready", models: [] })).toBe("ready");
  expect(
    sharedChoiceState({
      profile: { id: "saved", name: "Saved", provider: "one", model: "missing" },
      choices: {},
      entry: { status: "ready", models: [] },
    }).modelError,
  ).toBe("Model missing is not offered by this account.");
});

test("saved aliases stay literal across account and environment catalogs", () => {
  const host = {
    status: "ready" as const,
    models: [
      {
        provider: "host-account",
        id: "host-opus",
        aliases: ["opus"],
        label: "Host Opus",
        thinkingOptions: [
          { id: "medium", label: "Medium" },
          { id: "high", label: "High" },
        ],
      },
    ],
  };
  const dev = {
    status: "ready" as const,
    models: [
      {
        provider: "dev-account",
        id: "dev-opus",
        aliases: ["opus", "host-opus"],
        label: "Dev Opus",
        thinkingOptions: [{ id: "medium", label: "Medium" }],
      },
    ],
  };
  const profile = {
    id: "saved",
    name: "Saved",
    provider: "claude",
    model: "opus",
    thinkingOptionId: "medium",
  };
  for (const entry of [host, dev]) {
    const selected = sharedChoiceState({ profile, choices: {}, entry, family: [host, dev] });
    expect(selected.choices).toEqual({ model: "opus", thinkingOptionId: "medium" });
    expect(selected.unavailable).toBe(false);
    expect(selected.modelDisplay.label).toBe(entry.models[0].label);
    expect(selected.thinkingDisplay.label).toBe("Medium");
    expect(selected.thinkingOptions).toContainEqual({
      id: "medium",
      value: "medium",
      label: "Medium",
      available: true,
    });
  }
  const limited = sharedChoiceState({
    profile,
    choices: { thinkingOptionId: "high" },
    entry: dev,
    family: [host, dev],
  });
  expect(limited.modelError).toBeNull();
  expect(limited.thinkingError).toContain("Dev Opus");
  expect(limited.unavailable).toBe(true);
  expect(limited.thinkingOptions).toContainEqual({
    id: "high",
    value: "high",
    label: "High",
    available: false,
  });
  expect(limited.modelOptions).toContainEqual({
    id: "host-opus",
    value: "host-opus",
    label: "Host Opus",
    available: true,
  });
  expect(profile.model).toBe("opus");
});

test("aliases never make nonselectable models available", () => {
  const entry = {
    status: "ready" as const,
    models: [
      {
        provider: "claude",
        id: "hidden",
        aliases: ["opus"],
        label: "Hidden Opus",
        isSelectable: false,
        thinkingOptions: [{ id: "high", label: "High" }],
      },
    ],
  };
  const selected = sharedChoiceState({
    profile: { id: "saved", name: "Saved", provider: "claude", model: "opus" },
    choices: {},
    entry,
  });
  expect(selected.choices.model).toBe("opus");
  expect(selected.unavailable).toBe(true);
  expect(selected.modelError).toBe("Model opus is not offered by this account.");
  expect(selected.modelDisplay.label).toBe("opus");
  expect(selected.modelOptions).toEqual([]);
  expect(selected.thinkingOptions).toEqual([
    { id: "provider-default", value: "", label: "Provider default", available: true },
  ]);
});

test("exact selectable IDs take precedence over colliding aliases for reasoning", () => {
  const entry = {
    status: "ready" as const,
    models: [
      {
        provider: "claude",
        id: "versioned",
        aliases: ["opus"],
        label: "Alias model",
        thinkingOptions: [{ id: "high", label: "High" }],
      },
      {
        provider: "claude",
        id: "opus",
        label: "Exact model",
        thinkingOptions: [{ id: "medium", label: "Medium" }],
      },
    ],
  };
  const selected = sharedChoiceState({
    profile: {
      id: "saved",
      name: "Saved",
      provider: "claude",
      model: "opus",
      thinkingOptionId: "medium",
    },
    choices: {},
    entry,
  });
  expect(selected.modelDisplay.label).toBe("Exact model");
  expect(selected.unavailable).toBe(false);
  expect(selected.thinkingOptions.map((option) => option.id)).toEqual([
    "provider-default",
    "medium",
  ]);
});
