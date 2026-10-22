import { describe, expect, it } from "vitest";
import {
  resolveColumnWidths,
  resizeColumn,
  resolveTextOffset,
  allocateCardHeights,
  allocateGridCardHeights,
  resolveStandaloneTextWidth,
} from "./geometry";

describe("thread columns", () => {
  it("resizes reading width after the workspace has already reserved the shared card group", () => {
    expect(resolveStandaloneTextWidth(900, 820)).toBe(820);
    expect(resolveStandaloneTextWidth(600, 820)).toBe(568);
    expect(
      resizeColumn({
        column: "text",
        initial: { text: 600, cards: 0 },
        translation: 40,
        containerWidth: 900,
        standaloneText: true,
      }),
    ).toEqual({ text: 680, cards: 0 });
  });
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
    expect(allocateCardHeights(800, [60, 1200, 1200])).toEqual([60, 362, 362]);
    expect(allocateCardHeights(800, [60, 100, 1200])).toEqual([60, 100, 624]);
    expect(allocateCardHeights(800, [1200, 1200])).toEqual([396, 396]);
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

describe("collapsed grid height allocation", () => {
  it("lets one open card fill the space between two collapsed rows", () => {
    const demands = new Map([
      ["goal", { height: 50, row: 0 }],
      ["tasks", { height: 1800 }],
      ["journal", { height: 50, row: 700 }],
      ["files", { height: 50, row: 700 }],
      ["queue", { height: 50, row: 700 }],
    ]);
    expect(allocateGridCardHeights(800, demands).get("tasks")).toBe(684);
  });
  it("budgets wrapped rows separately and redistributes short open cards", () => {
    const demands = new Map([
      ["goal", { height: 50, row: 0 }],
      ["journal", { height: 50, row: 58 }],
      ["tasks", { height: 1800 }],
      ["files", { height: 100 }],
    ]);
    const heights = allocateGridCardHeights(800, demands);
    expect(heights.get("files")).toBe(100);
    expect(heights.get("tasks")).toBe(576);
  });
  it("gives dragged cards their height before automatic cards share the rest", () => {
    const demands = new Map([
      ["questions", { height: 500, fixed: true }],
      ["tasks", { height: 1800 }],
      ["goal", { height: 60 }],
    ]);
    const heights = allocateGridCardHeights(800, demands);
    expect(heights.get("questions")).toBe(500);
    expect(heights.get("goal")).toBe(60);
    expect(heights.get("tasks")).toBe(800 - 500 - 60 - 2 * 8);
  });
  it("shrinks dragged cards so automatic cards keep their reserve", () => {
    const demands = new Map([
      ["questions", { height: 2000, fixed: true }],
      ["tasks", { height: 1800 }],
    ]);
    const heights = allocateGridCardHeights(800, demands);
    expect(heights.get("questions")).toBe(800 - 8 - 72);
    expect(heights.get("tasks")).toBe(72);
  });
  it("counts tiles on one line once", () => {
    // The demo's Journal and nested subagents tiles, measured against the grid, share row 244.
    // Before grid-relative measurement they reported 295 and 305 and reserved a phantom row.
    const demands = new Map([
      ["tasks", { height: 236 }],
      ["journal", { height: 50, row: 244 }],
      ["subagents", { height: 50, row: 244 }],
      ["files", { height: 850 }],
      ["changes", { height: 50, row: 742 }],
    ]);
    const heights = allocateGridCardHeights(731, demands);
    expect(heights.get("files")).toBe(731 - 236 - 50 - 50 - 3 * 8);
  });
  it("reserves a joined line's full extent when its tiles really are offset", () => {
    const demands = new Map([
      ["journal", { height: 50, row: 244 }],
      ["subagents", { height: 50, row: 254 }],
      ["files", { height: 900 }],
    ]);
    expect(allocateGridCardHeights(800, demands).get("files")).toBe(800 - 60 - 8);
  });
});
