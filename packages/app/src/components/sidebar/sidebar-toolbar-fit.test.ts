import { describe, expect, it } from "vitest";
import { sidebarToolbarFit } from "./sidebar-toolbar-fit";

describe("sidebarToolbarFit", () => {
  it("shows every button once six fit with a gap between the groups", () => {
    // Collapse, Search, Schedules, History, Settings and More at 44px plus the 8px gap.
    expect(sidebarToolbarFit(272)).toBe(3);
    expect(sidebarToolbarFit(330)).toBe(3);
  });

  it("moves buttons into the menu only when they would overlap", () => {
    expect(sidebarToolbarFit(271)).toBe(2);
    expect(sidebarToolbarFit(228)).toBe(2);
    expect(sidebarToolbarFit(227)).toBe(1);
    expect(sidebarToolbarFit(184)).toBe(1);
    expect(sidebarToolbarFit(183)).toBe(0);
  });

  it("never reports a negative count or more than the optional buttons", () => {
    expect(sidebarToolbarFit(0)).toBe(0);
    expect(sidebarToolbarFit(2000)).toBe(3);
    expect(sidebarToolbarFit(Infinity)).toBe(3);
  });
});
