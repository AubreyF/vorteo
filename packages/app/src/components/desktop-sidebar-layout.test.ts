import { describe, expect, it } from "vitest";
import { DESKTOP_TRAFFIC_LIGHT_WIDTH } from "@/constants/layout";
import {
  COMPACT_RAIL_BUTTON_SIZE,
  COMPACT_RAIL_MARGIN,
  COMPACT_SIDEBAR_WIDTH,
} from "@/stores/panel-store/state";
import {
  canDesktopAppSidebarShare,
  resolveDesktopAppChromeLayout,
  resolveDesktopAppContentMinimum,
  resolveDesktopSidebarVisibility,
  resolveDesktopSidebarWidth,
} from "@/components/desktop-sidebar-layout";

describe("desktop sidebar layout", () => {
  it("keeps a retained sidebar hidden while app chrome is suppressed", () => {
    expect(
      resolveDesktopSidebarVisibility({
        chromeEnabled: false,
        isCompactLayout: false,
        isMounted: true,
        isOpen: true,
        canShare: true,
      }),
    ).toBe(false);
  });

  it("keeps the sidebar toggle window-owned beside left window controls", () => {
    expect(
      resolveDesktopAppChromeLayout({
        desktopSidebarRendered: true,
        hasTopLeftWindowControls: true,
        sidebarControlsEnabled: true,
      }),
    ).toEqual({
      sidebarCorners: "top-left",
      contentCorners: "top-right",
      sidebarToggleOwner: "window",
    });
    expect(
      resolveDesktopAppChromeLayout({
        desktopSidebarRendered: true,
        hasTopLeftWindowControls: false,
        sidebarControlsEnabled: true,
      }),
    ).toEqual({
      sidebarCorners: "none",
      contentCorners: "both",
      sidebarToggleOwner: "content",
    });
    expect(
      resolveDesktopAppChromeLayout({
        desktopSidebarRendered: false,
        hasTopLeftWindowControls: true,
        sidebarControlsEnabled: true,
      }),
    ).toEqual({
      sidebarCorners: "none",
      contentCorners: "both",
      sidebarToggleOwner: "window",
    });
  });

  it("hides the window-owned sidebar toggle when app chrome is suppressed", () => {
    expect(
      resolveDesktopAppChromeLayout({
        desktopSidebarRendered: false,
        hasTopLeftWindowControls: true,
        sidebarControlsEnabled: false,
      }).sidebarToggleOwner,
    ).toBe("none");
  });

  it("snaps at 160px while retaining fluid widths above the boundary", () => {
    expect(resolveDesktopSidebarWidth({ requestedWidth: 161, viewportWidth: 1800 })).toBe(161);
    expect(resolveDesktopSidebarWidth({ requestedWidth: 160, viewportWidth: 1800 })).toBe(50);
    expect(resolveDesktopSidebarWidth({ requestedWidth: 310, viewportWidth: 1800 })).toBe(310);
  });

  it("clamps a persisted wide sidebar to preserve the center pane", () => {
    const atHalfScreen = resolveDesktopSidebarWidth({ requestedWidth: 600, viewportWidth: 751 });
    expect(atHalfScreen).toBe(335);
    expect(751 - atHalfScreen - 16).toBe(400);

    const atBreakpoint = resolveDesktopSidebarWidth({ requestedWidth: 600, viewportWidth: 720 });
    expect(atBreakpoint).toBe(304);
    expect(720 - atBreakpoint - 16).toBe(400);

    expect(resolveDesktopSidebarWidth({ requestedWidth: 600, viewportWidth: 1440 })).toBe(600);
  });

  it("yields app navigation when settings needs the shell width", () => {
    const settingsMinimum = resolveDesktopAppContentMinimum({ isSettingsRoute: true });
    expect(settingsMinimum).toBe(720);
    expect(
      canDesktopAppSidebarShare({
        contentMinimumWidth: settingsMinimum,
        requestedSidebarWidth: 320,
        viewportWidth: 751,
      }),
    ).toBe(false);
  });

  it("lets the compact rail share space without consuming the saved expanded width", () => {
    expect(
      resolveDesktopSidebarWidth({ requestedWidth: 600, viewportWidth: 900, compact: true }),
    ).toBe(50);
    expect(
      canDesktopAppSidebarShare({
        contentMinimumWidth: 720,
        requestedSidebarWidth: 600,
        viewportWidth: 900,
        compact: true,
      }),
    ).toBe(true);
    expect(
      canDesktopAppSidebarShare({
        contentMinimumWidth: 720,
        requestedSidebarWidth: 600,
        viewportWidth: 900,
      }),
    ).toBe(false);
  });

  it("reserves native macOS controls in the compact rail and its width budget", () => {
    const input = {
      requestedWidth: 600,
      viewportWidth: 900,
      compact: true,
      hasTopLeftWindowControls: true,
    };
    expect(resolveDesktopSidebarWidth(input)).toBeGreaterThanOrEqual(DESKTOP_TRAFFIC_LIGHT_WIDTH);
    expect(
      canDesktopAppSidebarShare({
        contentMinimumWidth: 810,
        requestedSidebarWidth: 600,
        viewportWidth: 900,
        compact: true,
        hasTopLeftWindowControls: true,
      }),
    ).toBe(false);
    expect(
      canDesktopAppSidebarShare({
        contentMinimumWidth: 810,
        requestedSidebarWidth: 600,
        viewportWidth: 900,
        compact: true,
      }),
    ).toBe(true);
  });

  it("imposes no content minimum outside settings", () => {
    expect(resolveDesktopAppContentMinimum({ isSettingsRoute: false })).toBe(0);
    expect(
      canDesktopAppSidebarShare({
        contentMinimumWidth: resolveDesktopAppContentMinimum({ isSettingsRoute: false }),
        requestedSidebarWidth: 320,
        viewportWidth: 751,
      }),
    ).toBe(true);
  });
});

describe("compact rail width", () => {
  it("leaves the same margin beside each 44px button as above the first", () => {
    // Button, a margin on either side, and the panel's 1px border on either side.
    expect(COMPACT_SIDEBAR_WIDTH).toBe(COMPACT_RAIL_BUTTON_SIZE + 2 * COMPACT_RAIL_MARGIN + 2);
    expect(COMPACT_SIDEBAR_WIDTH).toBe(50);
  });
});
