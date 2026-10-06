import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyVortonWeb } from "./vorton-web.web";

let stop = () => {};
let fixture: HTMLDivElement;
let styles: HTMLStyleElement[];

beforeEach(async () => {
  const response = await fetch("/index.html");
  const html = await response.text();
  const parsed = new DOMParser().parseFromString(html, "text/html");
  styles = Array.from(parsed.querySelectorAll("style"));
  for (const style of styles) document.head.appendChild(style);
  fixture = document.createElement("div");
  fixture.innerHTML =
    '<div id="vorton-ios-status-strip" aria-hidden="true"></div><div id="root"><button>Toolbar action</button></div>';
  document.body.appendChild(fixture);
});
afterEach(() => {
  stop();
  fixture.remove();
  for (const style of styles) style.remove();
});

describe("Home Screen chrome layout", () => {
  it("suppresses the native edge with an empty fixed element without reserving toolbar space", () => {
    stop = applyVortonWeb(true);
    // Supply the standalone presentation to exercise its CSS in Chromium.
    // Native scroll-pocket acceptance is verified separately on iOS.
    document.documentElement.dataset.vortonIosStandalone = "true";
    const strip = document.getElementById("vorton-ios-status-strip");
    const root = document.getElementById("root");
    if (!strip || !root) throw new Error("Missing chrome fixture");
    const before = root.getBoundingClientRect().toJSON();
    const style = getComputedStyle(strip);
    expect(style.position).toBe("fixed");
    expect(style.height).toBe("11px");
    expect(style.backgroundClip).toBe("text");
    expect(style.pointerEvents).toBe("none");
    expect(style.opacity).toBe("1");
    expect(strip.getBoundingClientRect().width).toBe(window.innerWidth);
    expect(strip.getAttribute("aria-hidden")).toBe("true");
    expect(strip.textContent).toBe("");
    document.documentElement.dataset.vortonIosStandalone = "false";
    expect(getComputedStyle(strip).display).toBe("none");
    expect(root.getBoundingClientRect().toJSON()).toEqual(before);
  });

  it("does not accumulate styles across repeated mounts", () => {
    const initial = document.head.querySelectorAll("style[data-vorton-styles]").length;
    for (let i = 0; i < 3; i++) {
      stop = applyVortonWeb(true);
      document.documentElement.dataset.vortonIosStandalone = "true";
      stop();
      stop = applyVortonWeb(false);
      expect(document.head.querySelectorAll("style[data-vorton-styles]").length).toBe(initial + 1);
      stop();
    }
    expect(document.head.querySelectorAll("style[data-vorton-styles]").length).toBe(initial);
  });
});
