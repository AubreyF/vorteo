import { expect, it } from "vitest";
import { selectedPresetPresentation } from "./selected-preset-presentation";

it.each([false, true])("uses composer width for the profile caption: narrow=%s", (compactName) => {
  const result = selectedPresetPresentation({
    selectedProfileId: "secondary",
    selectedProfileName: "Codex 2 Astra Medium",
    definitions: [
      { id: "secondary", name: "Codex 2 Astra Medium", nickname: "C2-AM", provider: "codex" },
    ],
    compactName,
    view: { kind: "loading" },
    now: 0,
  });
  expect(result.triggerLabel).toBe(compactName ? "C2-AM" : "Codex 2 Astra Medium");
});

it("shows the unselected profile caption", () => {
  const result = selectedPresetPresentation({
    definitions: [],
    currentProvider: "codex-third",
    entries: [{ provider: "codex-third", label: "Codex 3 (Christian)" }],
    view: { kind: "loading" },
    now: 0,
  });
  expect(result.triggerLabel).toBe("Choose profile");
  expect(result.accessibilityLabel).toBe("Choose profile");
});

it.each([false, true])(
  "includes the selected account at either width: narrow=%s",
  (compactName) => {
    const result = selectedPresetPresentation({
      selectedProfileId: "shared",
      selectedProfileName: "Astra + 6.1 Sol Workers",
      currentProvider: "codex-third",
      selected: { name: "Astra + 6.1 Sol Workers", provider: "codex-primary" },
      definitions: [
        {
          id: "shared",
          name: "Astra + 6.1 Sol Workers",
          nickname: "A+S",
          provider: "codex-primary",
        },
      ],
      entries: [
        { provider: "codex-primary", label: "Codex 1" },
        { provider: "codex-third", label: "Codex 3 (Christian)" },
      ],
      compactName,
      view: { kind: "loading" },
      now: 0,
    });
    expect(result.triggerLabel).toBe(compactName ? "C3 A+S" : "C3 Astra + 6.1 Sol Workers");
    expect(result.accessibilityLabel).toContain("account Codex 3 (Christian)");
  },
);

it("uses the profile account when no running provider is supplied", () => {
  const result = selectedPresetPresentation({
    selectedProfileId: "local",
    selected: { name: "Local model", provider: "pi" },
    definitions: [],
    entries: [{ provider: "pi", label: "Pi" }],
    compactName: false,
    view: { kind: "loading" },
    now: 0,
  });
  expect(result.triggerLabel).toBe("Pi Local model");
});

it("resolves the account from the saved definition before picker rows arrive", () => {
  const result = selectedPresetPresentation({
    selectedProfileId: "saved",
    selectedProfileName: "Astra",
    definitions: [{ id: "saved", name: "Astra", provider: "codex-third" }],
    entries: [{ provider: "codex-third", label: "Codex 3 (Christian)" }],
    compactName: false,
    view: { kind: "loading" },
    now: 0,
  });
  expect(result.triggerLabel).toBe("C3 Astra");
});
