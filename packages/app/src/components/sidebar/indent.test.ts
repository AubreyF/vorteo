import { describe, expect, it } from "vitest";
import { SPACING } from "@/styles/theme";
import { SIDEBAR_INDENT_UNIT, SIDEBAR_ROW_INSET, sidebarIndent } from "./indent";

describe("sidebar indent", () => {
  it("steps each hierarchy level in by one 12px unit", () => {
    expect(SIDEBAR_INDENT_UNIT).toBe(SPACING[3]);
    expect([0, 1, 2, 3].map(sidebarIndent)).toEqual([
      SIDEBAR_ROW_INSET,
      SIDEBAR_ROW_INSET + SIDEBAR_INDENT_UNIT,
      SIDEBAR_ROW_INSET + 2 * SIDEBAR_INDENT_UNIT,
      SIDEBAR_ROW_INSET + 3 * SIDEBAR_INDENT_UNIT,
    ]);
  });

  it("puts project children on an 18px workspace rail", () => {
    expect(sidebarIndent(0)).toBe(6);
    expect(sidebarIndent(1)).toBe(18);
  });
});
