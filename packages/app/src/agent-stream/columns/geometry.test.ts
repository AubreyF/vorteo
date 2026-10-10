import { describe, expect, it } from "vitest";
import {
  resolveColumnWidths,
  resizeColumn,
  resolveTextOffset,
  allocateCardHeights,
} from "./geometry";

describe("thread columns", () => {
  it("fits both minimum reading widths at the primary-region breakpoint", () => {
    expect(resolveColumnWidths(1080, { text: 820, cards: 440 })).toEqual({ text: 576, cards: 440 });
  });
  it("temporarily clamps preferences without losing the requested widths", () => {
    const preferred = { text: 900, cards: 600 };
    expect(resolveColumnWidths(1200, preferred)).toEqual({ text: 560, cards: 576 });
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
        expect(widths.cards).toBeGreaterThanOrEqual(220);
        expect(widths.text + widths.cards + 64).toBeLessThanOrEqual(1400);
      }
    }
  });
});

describe("centered conversation and bounded cards", () => {
  it("centers against the full view until the cards require a left shift", () => {
    const widths = { text: 800, cards: 440 };
    expect(resolveTextOffset(2400, widths)).toBe(800);
    expect(resolveTextOffset(1800, widths)).toBe(500);
    expect(resolveTextOffset(1400, widths)).toBe(112);
  });
  it("keeps the minimum gutter while narrowing", () => {
    for (const width of [1080, 1200, 1400, 1800, 2400]) {
      const columns = resolveColumnWidths(width, { text: 800, cards: 500 });
      const left = resolveTextOffset(width, columns);
      expect(left).toBeGreaterThanOrEqual(16);
      expect(left + columns.text + 32).toBeLessThanOrEqual(width - 16 - columns.cards);
    }
  });
  it("caps a single card at its content or the entire available height", () => {
    expect(allocateCardHeights(800, [1200])).toEqual([800]);
    expect(allocateCardHeights(800, [120])).toEqual([120]);
  });
  it("redistributes space from small and collapsed cards", () => {
    expect(allocateCardHeights(800, [60, 1200, 1200])).toEqual([60, 354, 354]);
    expect(allocateCardHeights(800, [60, 100, 1200])).toEqual([60, 100, 608]);
    expect(allocateCardHeights(800, [1200, 1200])).toEqual([392, 392]);
    expect(allocateCardHeights(0, [1200, 1200])).toEqual([0, 0]);
    expect(allocateCardHeights(800, [])).toEqual([]);
  });
});

it("allows narrow cards to restore full-region message centering", () => {
  const widths = resizeColumn({
    column: "cards",
    initial: { text: 700, cards: 440 },
    translation: 300,
    containerWidth: 1200,
  });
  expect(widths).toEqual({ text: 700, cards: 220 });
  expect(resolveTextOffset(1200, widths)).toBe(232);
  expect(resolveTextOffset(1300, widths)).toBe(300);
});
