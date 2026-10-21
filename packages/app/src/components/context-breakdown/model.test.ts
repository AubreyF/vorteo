import { describe, expect, it } from "vitest";
import type { AgentContextBreakdown } from "@getpaseo/protocol/agent-context";
import {
  buildBreakdownModel,
  buildTotalsModel,
  formatBreakdownTokens,
  formatPercent,
  layoutDonut,
} from "./model";

const BREAKDOWN: AgentContextBreakdown = {
  totalTokens: 140_500,
  maxTokens: 1_000_000,
  categories: [
    { name: "Free space", tokens: 826_500, kind: "free" },
    { name: "Messages", tokens: 27_600, kind: "used" },
    { name: "Skills", tokens: 0, kind: "used" },
    { name: "System tools", tokens: 19_300, kind: "used" },
    { name: "Autocompact buffer", tokens: 33_000, kind: "buffer" },
    { name: "MCP tools (deferred)", tokens: 161_600, kind: "deferred" },
    { name: "Future row", tokens: 100, kind: "something-new" },
  ],
  groups: [],
  observedAt: "2026-10-21T12:00:00.000Z",
};

describe("buildBreakdownModel", () => {
  it("draws content, then the buffer, then free space, and lists deferred rows last", () => {
    const model = buildBreakdownModel(BREAKDOWN);
    expect(model.segments.map((row) => row.label)).toEqual([
      "Messages",
      "System tools",
      "Future row",
      "Autocompact buffer",
      "Free space",
    ]);
    expect(model.legend.at(-1)).toMatchObject({
      label: "MCP tools (deferred)",
      kind: "deferred",
      percentOfWindow: null,
      slot: null,
    });
  });

  it("keeps each used row's colour slot when an earlier row is empty", () => {
    const slots = buildBreakdownModel(BREAKDOWN).segments.map((row) => [row.label, row.slot]);
    // "Skills" is empty and hidden, but still holds slot 1.
    expect(slots).toEqual([
      ["Messages", 0],
      ["System tools", 2],
      ["Future row", 3],
      ["Autocompact buffer", null],
      ["Free space", null],
    ]);
  });
});

describe("buildTotalsModel", () => {
  it("splits the window into used and free", () => {
    const model = buildTotalsModel({
      usedTokens: 250,
      maxTokens: 1_000,
      usedLabel: "Used",
      freeLabel: "Free space",
    });
    expect(model.legend.map((row) => [row.label, row.tokens, row.percentOfWindow])).toEqual([
      ["Used", 250, 25],
      ["Free space", 750, 75],
    ]);
  });

  it("never reports negative free space when usage runs over the window", () => {
    const model = buildTotalsModel({
      usedTokens: 1_200,
      maxTokens: 1_000,
      usedLabel: "Used",
      freeLabel: "Free space",
    });
    expect(model.segments.map((row) => row.key)).toEqual(["used"]);
  });
});

describe("layoutDonut", () => {
  it("places arcs end to end with a gap between neighbours", () => {
    const arcs = layoutDonut({
      segments: [
        { key: "a", tokens: 25 },
        { key: "b", tokens: 75 },
      ],
      total: 100,
      circumference: 100,
      gap: 2,
    });
    expect(arcs).toEqual([
      { key: "a", length: 23, offset: 1 },
      { key: "b", length: 73, offset: 26 },
    ]);
  });

  it("draws a lone segment without a gap", () => {
    expect(
      layoutDonut({ segments: [{ key: "a", tokens: 10 }], total: 10, circumference: 50, gap: 2 }),
    ).toEqual([{ key: "a", length: 50, offset: 0 }]);
  });
});

describe("formatting", () => {
  it("formats tokens like Claude's context table", () => {
    expect(formatBreakdownTokens(950)).toBe("950");
    expect(formatBreakdownTokens(27_600)).toBe("27.6k");
    expect(formatBreakdownTokens(7_000)).toBe("7k");
    expect(formatBreakdownTokens(826_500)).toBe("827k");
    expect(formatBreakdownTokens(1_000_000)).toBe("1m");
  });

  it("formats shares of the window", () => {
    expect(formatPercent(2.76)).toBe("2.8%");
    expect(formatPercent(0.04)).toBe("<0.1%");
    expect(formatPercent(null)).toBe("");
  });
});
