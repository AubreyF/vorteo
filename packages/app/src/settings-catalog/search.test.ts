import { describe, expect, it } from "vitest";
import { labelMatchRanges, searchSettings, type SearchableSetting } from "./search";

const entry = (overrides: Partial<SearchableSetting> & { label: string }): SearchableSetting => ({
  id: overrides.label,
  pane: "pane",
  section: "section",
  ...overrides,
});

const vim = entry({ label: "Vim keybindings", keywords: ["vi", "modal editing"] });
const theme = entry({ label: "Theme", keywords: ["dark", "light", "pure black"] });
const highlight = entry({ label: "Highlight theme", keywords: ["syntax"] });
const contentWidth = entry({
  label: "Content width",
  hint: "Max width of chat and Markdown files on wide screens",
});
const scrollback = entry({
  label: "Terminal scrollback",
  keywords: ["buffer", "lines"],
  context: ["Terminal"],
});
const outline = entry({ label: "Chat outline", context: ["Chat & editor"] });
const darkKeyword = entry({ label: "Contrast", keywords: ["dark mode"] });

const ids = (query: string, entries: SearchableSetting[]) =>
  searchSettings(entries, query).map((result) => result.entry.id);

describe("searchSettings", () => {
  it("returns nothing for an empty query", () => {
    expect(searchSettings([vim, theme], "  ")).toEqual([]);
  });

  it("ranks an exact label above a later word and label hits above keywords", () => {
    expect(ids("theme", [highlight, theme])).toEqual(["Theme", "Highlight theme"]);
    expect(ids("dark", [darkKeyword, entry({ label: "Dark sidebar" })])).toEqual([
      "Dark sidebar",
      "Contrast",
    ]);
  });

  it("matches every query word across label, keywords, hint and context", () => {
    expect(ids("terminal lines", [scrollback])).toEqual(["Terminal scrollback"]);
    expect(ids("editor outline", [outline])).toEqual(["Chat outline"]);
    expect(ids("editor theme", [outline])).toEqual([]);
    expect(ids("markdown files", [contentWidth])).toEqual(["Content width"]);
  });

  it("forgives a typo in longer words but not short ones", () => {
    expect(ids("scrolback", [scrollback])).toEqual(["Terminal scrollback"]);
    expect(ids("thmee", [theme])).toEqual(["Theme"]);
    expect(ids("vix", [vim])).toEqual([]);
  });

  it("keeps catalog order for equal matches", () => {
    const a = entry({ id: "a", label: "Code size" });
    const b = entry({ id: "b", label: "Content size" });
    expect(searchSettings([a, b], "size").map((result) => result.entry.id)).toEqual(["a", "b"]);
  });
});

describe("labelMatchRanges", () => {
  it("marks each matched word", () => {
    expect(labelMatchRanges("Vim keybindings", "vim key")).toEqual([
      { start: 0, length: 3 },
      { start: 4, length: 3 },
    ]);
    expect(labelMatchRanges("Theme", "xyz")).toEqual([]);
  });
});
