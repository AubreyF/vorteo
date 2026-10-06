// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
vi.mock("@/constants/platform", () => ({ isWeb: true }));
import { useCompactWebViewportZoomLock } from "./use-compact-web-viewport-zoom-lock";

describe("viewport zoom", () => {
  it("permits pinch zoom and restores the previous viewport on unmount", () => {
    document.head.innerHTML =
      '<meta name="viewport" content="width=device-width, initial-scale=1">';
    const viewport = document.head.querySelector('meta[name="viewport"]');
    const { unmount } = renderHook(useCompactWebViewportZoomLock);
    expect(viewport?.getAttribute("content")).not.toContain("user-scalable=no");
    expect(viewport?.getAttribute("content")).not.toContain("maximum-scale");
    expect(viewport?.getAttribute("content")).toContain("viewport-fit=cover");
    unmount();
    expect(viewport?.getAttribute("content")).toBe("width=device-width, initial-scale=1");
    document.head.innerHTML = "";
  });
});
