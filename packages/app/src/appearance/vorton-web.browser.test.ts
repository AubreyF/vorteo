import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  vi.restoreAllMocks();
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

it("keeps the shell inside the keyboard viewport and releases it for zoom and blur", () => {
  const viewport = window.visualViewport!;
  let height = window.innerHeight;
  let top = 0;
  let scale = 1;
  vi.spyOn(viewport, "height", "get").mockImplementation(() => height);
  vi.spyOn(viewport, "offsetTop", "get").mockImplementation(() => top);
  vi.spyOn(viewport, "scale", "get").mockImplementation(() => scale);
  const input = document.createElement("textarea");
  const root = document.getElementById("root")!;
  root.appendChild(input);
  stop = applyVortonWeb(true);
  input.focus();
  height = window.innerHeight - 300;
  top = 120;
  viewport.dispatchEvent(new Event("resize"));
  expect(root.getBoundingClientRect().top).toBe(top);
  expect(root.getBoundingClientRect().height).toBe(height);
  top = 160;
  viewport.dispatchEvent(new Event("scroll"));
  expect(root.getBoundingClientRect().top).toBe(top);
  scale = 1.5;
  viewport.dispatchEvent(new Event("resize"));
  expect(document.documentElement.dataset.vortonKeyboard).toBeUndefined();
  scale = 1;
  viewport.dispatchEvent(new Event("resize"));
  input.blur();
  expect(document.documentElement.dataset.vortonKeyboard).toBeUndefined();
  input.focus();
  stop();
  expect(document.documentElement.dataset.vortonKeyboard).toBeUndefined();
  viewport.dispatchEvent(new Event("resize"));
  expect(document.documentElement.dataset.vortonKeyboard).toBeUndefined();
});
