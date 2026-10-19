import type { WebContents } from "electron";

export function isAppNavigationUrl(candidate: string, appUrl: string): boolean {
  if (!URL.canParse(candidate) || !URL.canParse(appUrl)) return false;
  const target = new URL(candidate);
  const trusted = new URL(appUrl);
  // Custom-scheme URLs have opaque origins, so comparing URL.origin would treat
  // unrelated custom schemes as identical. Compare their authority explicitly.
  return (
    target.protocol === trusted.protocol &&
    target.host === trusted.host &&
    target.username === "" &&
    target.password === ""
  );
}

export function registerAppNavigationGuards(contents: WebContents, appUrl: string): void {
  contents.on("will-navigate", (event, url) => {
    if (!isAppNavigationUrl(url, appUrl)) event.preventDefault();
  });
  contents.on("will-redirect", (event, url, _isInPlace, isMainFrame) => {
    if (isMainFrame && !isAppNavigationUrl(url, appUrl)) event.preventDefault();
  });
  // External links use the validated opener bridge. A new renderer must never
  // inherit the application preload for an arbitrary destination.
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
}
