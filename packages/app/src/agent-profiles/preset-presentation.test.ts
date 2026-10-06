import { expect, it } from "vitest";
import { generatedPresetNickname, presetNickname } from "./nickname";
import { selectedPresetPresentation } from "./selected-preset-presentation";

it("shows selected nicknames and quota rings", () => {
  const result = selectedPresetPresentation({
    selectedProfileId: "secondary",
    selectedProfileName: "Codex 2 Astra Medium",
    currentProvider: "codex-secondary",
    definitions: [
      {
        id: "secondary",
        name: "Codex 2 Astra Medium",
        nickname: "C2-AM",
        provider: "codex-secondary",
      },
    ],
    now: 100,
    view: {
      kind: "ready",
      isRefreshing: false,
      payload: {
        requestId: "test",
        fetchedAt: new Date(0).toISOString(),
        providers: [
          {
            providerId: "codex-secondary",
            displayName: "Codex Secondary",
            status: "available",
            planLabel: null,
            windows: [{ id: "weekly", label: "Weekly", remainingPct: 50 }],
          },
        ],
      },
    },
  });
  expect(result.triggerLabel).toBe("C2-AM");
  expect(result.showRing).toBe(true);
  expect(result.accessibilityLabel).toContain("50 percent remaining");
});

it("generates nicknames and preserves separately editable overrides", () => {
  expect(generatedPresetNickname("Codex 2 Astra Medium")).toBe("C2-AM");
  expect(generatedPresetNickname("Local Fast")).toBe("LF");
  expect(presetNickname({ name: "Codex 2 Astra Medium", nickname: " My coder " })).toBe("My coder");
  expect(presetNickname({ name: "Codex 2 Astra Medium", nickname: " " })).toBe("C2-AM");
});
