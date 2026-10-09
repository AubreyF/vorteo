import { describe, expect, it } from "vitest";
import { resolveColumnWidths, resizeColumn } from "./geometry";

describe("thread columns", () => {
  it("fits both minimum reading widths at the primary-region breakpoint", () => {
    expect(resolveColumnWidths(1080, { text: 820, cards: 440 })).toEqual({ text: 560, cards: 440 });
  });
  it("temporarily clamps preferences without losing the requested widths", () => {
    const preferred = { text: 900, cards: 600 };
    expect(resolveColumnWidths(1200, preferred)).toEqual({ text: 560, cards: 560 });
    expect(resolveColumnWidths(1700, preferred)).toEqual(preferred);
  });
  it("expands text symmetrically without changing card width", () => {
    expect(
      resizeColumn({
        column: "text",
        initial: { text: 600, cards: 440 },
        translation: 40,
        containerWidth: 1500,
      }),
    ).toEqual({ text: 680, cards: 440 });
  });
  it("expands cards leftward while leaving the text preference alone when it fits", () => {
    expect(
      resizeColumn({
        column: "cards",
        initial: { text: 600, cards: 440 },
        translation: -50,
        containerWidth: 1500,
      }),
    ).toEqual({ text: 600, cards: 490 });
  });
  it("prevents overlapping columns at either drag extreme", () => {
    for (const column of ["text", "cards"] as const) {
      for (const translation of [-10000, 10000]) {
        const widths = resizeColumn({
          column,
          initial: { text: 700, cards: 500 },
          translation,
          containerWidth: 1400,
        });
        expect(widths.text).toBeGreaterThanOrEqual(560);
        expect(widths.cards).toBeGreaterThanOrEqual(440);
        expect(widths.text + widths.cards + 80).toBeLessThanOrEqual(1400);
      }
    }
  });
});
