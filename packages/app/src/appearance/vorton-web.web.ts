import { observeWebViewport } from "../diagnostics/web-viewport.web";
import { isAppleHandheldPlatform } from "../utils/terminal-keys";
const CSS = `
@supports (height: 100dvh) {
  html, html body { height: calc(100dvh / var(--interface-scale, 1)); }
}
/* Safari can pan its visual viewport to the focused editor. Keep the complete shell
   inside that visible rectangle rather than scrolling its workspace header away. */
html[data-vorton-keyboard="true"] #root {
  position: fixed;
  top: calc(var(--vorton-visible-top) / var(--interface-scale, 1));
  left: 0;
  width: 100%;
  height: calc(var(--vorton-visible-height) / var(--interface-scale, 1)) !important;
  overflow: hidden;
}
/* Header and panel shells own safe-area spacing. Do not add a second top inset here. */
html[data-vorton-ios-standalone="true"] #root {
  box-sizing: border-box;
  background-color: var(--colors-surface-sidebar);
}
html[data-vorton-touch="true"] :is(button, [role="button"], [role="tab"], [role="menuitem"], [role="menuitemcheckbox"], [role="option"], [role="combobox"], [role="switch"]) {
  min-height: 44px !important;
  min-width: 44px !important;
  touch-action: manipulation;
}
/* Card drag columns own their compact width; keep the shared 44px height. */
html[data-vorton-touch="true"] [data-vorton-row-handle] { min-width: 0 !important; }
html[data-vorton-touch="true"] [data-keyboard-reorder] { touch-action: none; }
html[data-vorton-touch="true"] :is(input, textarea, [contenteditable="true"]) { font-size: max(16px, 1em); }
html :is(button, [role="button"], [role="tab"], [role="menuitem"], [role="combobox"]):focus-visible {
  outline: 2px solid currentColor;
  outline-offset: 2px;
}
html[data-vorton-touch="true"] [data-vorton-action-slot] { min-width: 44px; min-height: 44px; }
html[data-vorton-touch="true"] [data-vorton-action-slot] > * { min-width: 44px; min-height: 44px; }
`;
export function applyVortonWeb(touch: boolean): () => void {
  const root = document.documentElement;
  root.dataset.vortonTouch = String(touch);
  root.dataset.vortonIosStandalone = String(
    "standalone" in navigator &&
      navigator.standalone === true &&
      isAppleHandheldPlatform(navigator),
  );
  const statusBar = document.querySelector<HTMLMetaElement>(
    'meta[name="apple-mobile-web-app-status-bar-style"]',
  );
  const originalStatusBar = statusBar?.dataset.paseoStatusBarStyle ?? statusBar?.content;
  if (statusBar && originalStatusBar) {
    statusBar.content = isAppleHandheldPlatform(navigator) ? "default" : originalStatusBar;
  }
  const style = document.createElement("style");
  style.dataset.vortonStyles = "true";
  style.textContent = CSS;
  document.head.appendChild(style);
  const stopObserving = observeWebViewport();
  const viewport = window.visualViewport;
  const syncKeyboardViewport = () => {
    const focused = document.activeElement;
    const editing =
      focused instanceof HTMLElement &&
      (focused.matches("input, textarea") || focused.isContentEditable);
    // Pinch zoom owns its viewport. Never interpret zooming as a keyboard.
    const keyboard =
      touch &&
      viewport &&
      Math.abs(viewport.scale - 1) < 0.01 &&
      editing &&
      window.innerHeight - viewport.height > 100;
    if (keyboard && viewport) {
      root.style.setProperty("--vorton-visible-top", `${viewport.offsetTop}px`);
      root.style.setProperty("--vorton-visible-height", `${viewport.height}px`);
      root.dataset.vortonKeyboard = "true";
    } else {
      delete root.dataset.vortonKeyboard;
      root.style.removeProperty("--vorton-visible-top");
      root.style.removeProperty("--vorton-visible-height");
    }
  };
  viewport?.addEventListener("resize", syncKeyboardViewport);
  viewport?.addEventListener("scroll", syncKeyboardViewport);
  document.addEventListener("focusin", syncKeyboardViewport);
  document.addEventListener("focusout", syncKeyboardViewport);
  syncKeyboardViewport();
  return () => {
    stopObserving();
    viewport?.removeEventListener("resize", syncKeyboardViewport);
    viewport?.removeEventListener("scroll", syncKeyboardViewport);
    document.removeEventListener("focusin", syncKeyboardViewport);
    document.removeEventListener("focusout", syncKeyboardViewport);
    delete root.dataset.vortonKeyboard;
    root.style.removeProperty("--vorton-visible-top");
    root.style.removeProperty("--vorton-visible-height");
    if (statusBar && originalStatusBar) statusBar.content = originalStatusBar;
    style.remove();
    delete root.dataset.vortonTouch;
    delete root.dataset.vortonIosStandalone;
  };
}
