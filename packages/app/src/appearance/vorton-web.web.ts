import { observeWebViewport } from "../diagnostics/web-viewport.web";
import { isAppleHandheldPlatform } from "../utils/terminal-keys";
const CSS = `
@supports (height: 100dvh) {
  html, html body { height: 100dvh; }
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
  return () => {
    stopObserving();
    if (statusBar && originalStatusBar) statusBar.content = originalStatusBar;
    style.remove();
    delete root.dataset.vortonTouch;
    delete root.dataset.vortonIosStandalone;
  };
}
