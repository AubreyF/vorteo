import { describe, expect, it } from "vitest";
import { ICON_SIZE, SPACING } from "@/styles/theme";
import { SIDEBAR_INDENT_UNIT, SIDEBAR_ROW_INSET, sidebarIndent } from "./indent";

describe("sidebar indent", () => {
  it("steps each hierarchy level in by one icon slot and its title gap", () => {
    expect(SIDEBAR_INDENT_UNIT).toBe(ICON_SIZE.md + SPACING[2]);
    expect([0, 1, 2, 3].map(sidebarIndent)).toEqual([
      SIDEBAR_ROW_INSET,
      SIDEBAR_ROW_INSET + SIDEBAR_INDENT_UNIT,
      SIDEBAR_ROW_INSET + 2 * SIDEBAR_INDENT_UNIT,
      SIDEBAR_ROW_INSET + 3 * SIDEBAR_INDENT_UNIT,
    ]);
  });

  it("keeps project children on the established 30px workspace rail", () => {
    expect(sidebarIndent(0)).toBe(6);
    expect(sidebarIndent(1)).toBe(30);
  });
});
