// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { installBrowserScrollOptions } from "./scroll-view.web";

afterEach(() => vi.restoreAllMocks());

test("browser scrolling retains top/left while native callers retain x/y and cleanup", () => {
  const node = document.createElement("div");
  const browserScroll = vi.fn(function (this: Element, options: ScrollToOptions) {
    this.scrollTop = options.top ?? this.scrollTop;
    this.scrollLeft = options.left ?? this.scrollLeft;
  });
  const previous = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTo");
  Object.defineProperty(Element.prototype, "scrollTo", {
    configurable: true,
    writable: true,
    value: browserScroll,
  });
  const nativeScroll = vi.fn();
  node.scrollTo = nativeScroll;
  const restore = installBrowserScrollOptions(node);
  try {
    node.scrollTo({ top: 227, behavior: "auto" });
    expect(node.scrollTop).toBe(227);
    node.scrollTo({ left: 31, behavior: "smooth" });
    expect(node.scrollTop).toBe(227);
    expect(node.scrollLeft).toBe(31);
    expect(nativeScroll).not.toHaveBeenCalled();
    Reflect.apply(node.scrollTo, node, [{ x: 12, y: 45, animated: false }]);
    expect(nativeScroll).toHaveBeenLastCalledWith({ x: 12, y: 45, animated: false }, undefined);
    node.scrollTo(45, 12);
    expect(nativeScroll).toHaveBeenLastCalledWith(45, 12);
    restore();
    expect(node.scrollTo).toBe(nativeScroll);
  } finally {
    restore();
    if (previous) Object.defineProperty(Element.prototype, "scrollTo", previous);
    else Reflect.deleteProperty(Element.prototype, "scrollTo");
  }
});
