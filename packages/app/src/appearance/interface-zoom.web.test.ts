import { describe, expect, it } from "vitest";
import { interfaceZoomForKey, stepInterfaceZoom } from "./interface-zoom.web";

const key = (init: Partial<KeyboardEvent>) => ({
  key: "",
  code: "",
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  ...init,
});

describe("interface zoom shortcuts", () => {
  it("steps to the next multiple of 10 within the range", () => {
    expect(stepInterfaceZoom(100, 1)).toBe(110);
    expect(stepInterfaceZoom(105, 1)).toBe(110);
    expect(stepInterfaceZoom(105, -1)).toBe(100);
    expect(stepInterfaceZoom(200, 1)).toBe(200);
    expect(stepInterfaceZoom(75, -1)).toBe(75);
  });

  it("maps the platform zoom keys to interface zoom", () => {
    expect(interfaceZoomForKey(key({ key: "=", metaKey: true }), 100, true)).toBe(110);
    expect(interfaceZoomForKey(key({ key: "+", metaKey: true }), 100, true)).toBe(110);
    expect(interfaceZoomForKey(key({ key: "-", metaKey: true }), 100, true)).toBe(90);
    expect(interfaceZoomForKey(key({ key: "0", metaKey: true }), 150, true)).toBe(100);
    expect(interfaceZoomForKey(key({ code: "NumpadAdd", ctrlKey: true }), 100, false)).toBe(110);
  });

  it("leaves other modifiers and keys to their own handlers", () => {
    expect(interfaceZoomForKey(key({ key: "=", ctrlKey: true }), 100, true)).toBeNull();
    expect(interfaceZoomForKey(key({ key: "=", metaKey: true }), 100, false)).toBeNull();
    expect(
      interfaceZoomForKey(key({ key: "-", metaKey: true, altKey: true }), 100, true),
    ).toBeNull();
    expect(interfaceZoomForKey(key({ key: "1", metaKey: true }), 100, true)).toBeNull();
  });
});
