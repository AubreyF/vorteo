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
    view: { kind: "loading" },
    now: 0,
  });
  expect(result.triggerLabel).toBe("Choose profile");
  expect(result.accessibilityLabel).toBe("Choose profile");
});
