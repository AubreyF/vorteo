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
    vortonMode: true,
    view: { kind: "loading" },
    now: 0,
  });
  expect(result.triggerLabel).toBe(compactName ? "C2-AM" : "Codex 2 Astra Medium");
});

it.each([
  { vortonMode: true, caption: "Choose profile", accessibility: "Choose profile" },
  {
    vortonMode: false,
    caption: "Select configuration",
    accessibility: "Profile (Select configuration, Select configuration)",
  },
])("shows the unselected caption in mode $vortonMode", ({ vortonMode, caption, accessibility }) => {
  const result = selectedPresetPresentation({
    definitions: [],
    vortonMode,
    view: { kind: "loading" },
    now: 0,
  });
  expect(result.triggerLabel).toBe(caption);
  expect(result.accessibilityLabel).toBe(accessibility);
});
