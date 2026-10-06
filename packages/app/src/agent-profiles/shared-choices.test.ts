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
