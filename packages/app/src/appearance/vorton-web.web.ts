import { observeWebViewport } from "../diagnostics/web-viewport.web";
import { isAppleHandheldPlatform } from "../utils/terminal-keys";
const CSS = `
@supports (height: 100dvh) {
  html[data-vorton-mode="true"], html[data-vorton-mode="true"] body { height: 100dvh; }
}
/* Header and panel shells own safe-area spacing. Do not add a second top inset here. */
html[data-vorton-mode="true"][data-vorton-ios-standalone="true"] #root {
  box-sizing: border-box;
  background-color: var(--colors-surface-sidebar);
}
html[data-vorton-touch="true"] :is(button, [role="button"], [role="tab"], [role="menuitem"], [role="menuitemcheckbox"], [role="option"], [role="combobox"], [role="switch"]):not([data-vorton-compact-mode]) {
  min-height: 44px !important;
  min-width: 44px !important;
  touch-action: manipulation;
}
html[data-vorton-touch="true"] :is(input, textarea, [contenteditable="true"]) { font-size: max(16px, 1em); }
html[data-vorton-mode="true"] :is(button, [role="button"], [role="tab"], [role="menuitem"], [role="combobox"]):focus-visible {
  outline: 2px solid currentColor;
  outline-offset: 2px;
}
html[data-vorton-touch="true"] [data-vorton-action-slot] { min-width: 44px; min-height: 44px; }
html[data-vorton-touch="true"] [data-vorton-action-slot] > * { min-width: 44px; min-height: 44px; }
`;
export function applyVortonWeb(enabled: boolean, touch: boolean): () => void {
  const root = document.documentElement;
  root.dataset.vortonMode = String(enabled);
  root.dataset.vortonTouch = String(enabled && touch);
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
    statusBar.content =
      enabled && isAppleHandheldPlatform(navigator) ? "default" : originalStatusBar;
  }
  const style = document.createElement("style");
  style.dataset.vortonStyles = "true";
  style.textContent = CSS;
  document.head.appendChild(style);
  const stopObserving = enabled ? observeWebViewport() : () => {};
  return () => {
    stopObserving();
    if (statusBar && originalStatusBar) statusBar.content = originalStatusBar;
    style.remove();
    delete root.dataset.vortonMode;
    delete root.dataset.vortonTouch;
    delete root.dataset.vortonIosStandalone;
  };
}
