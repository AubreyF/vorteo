import { describe, expect, it } from "vitest";
import { vortonAppearance } from "./vorton-appearance";
import type { AppearanceInput } from "./apply";
const saved: AppearanceInput = {
  uiFontFamily: "",
  monoFontFamily: "",
  uiBaseFontSize: 14,
  contentFontSize: 14,
  codeFontSize: 13,
  contentMaxWidth: 820,
  syntaxTheme: "github",
};
describe("Vorton appearance", () => {
  it("restores exact saved appearance when off without changing preferences", () => {
    const touch = vortonAppearance(saved, true);
    expect(touch.uiBaseFontSize).toBe(16);
    expect(touch.contentFontSize).toBe(17);
    expect(touch.codeFontSize).toBe(13);
    expect(vortonAppearance(saved, false)).toBe(saved);
    expect(saved.uiBaseFontSize).toBe(14);
  });
  it("preserves larger sizes selected by the user", () => {
    const large = { ...saved, uiBaseFontSize: 22, contentFontSize: 24 };
    expect(vortonAppearance(large, true)).toEqual(large);
  });
});
