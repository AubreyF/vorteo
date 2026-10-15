import { applyBootLogo } from "./apply-logo.web";
import type { Theme } from "@/styles/theme";

const STYLE_ID = "vorteo-appearance-shell";
const CSS = `
[data-appearance-canvas] {
  background: var(--vorteo-shell-background) !important;
  isolation: isolate;
}
[data-appearance-canvas]::before {
  content: "";
  position: absolute;
  inset: 0;
  pointer-events: none;
  background-image: var(--vorteo-shell-texture);
  background-size: var(--vorteo-shell-texture-size);
  background-repeat: var(--vorteo-shell-texture-repeat);
  z-index: -1;
}
@media (prefers-reduced-motion: reduce) {
  [data-appearance-canvas] { scroll-behavior: auto; }
}
`;

/** Keep browser chrome hints and the entire canvas on the central content color. */
export function applyShellAppearance(theme: Theme, persist = true): void {
  if (typeof document === "undefined") return;
  if (persist) applyBootLogo(theme);
  const root = document.documentElement;
  root.dataset.vorteoAppearance = theme.appearance?.id ?? "plugin";
  root.style.colorScheme = theme.colorScheme;
  root.style.setProperty("--vorteo-shell-background", theme.colors.surface0);
  root.style.setProperty("--vorteo-welcome-ink", theme.colors.accent);
  root.style.setProperty("--vorteo-shell-texture", "none");
  root.style.setProperty(
    "--vorteo-shell-texture-size",
    theme.appearance?.background?.textures.map((texture) => texture.size).join(", ") || "auto",
  );
  root.style.setProperty(
    "--vorteo-shell-texture-repeat",
    theme.appearance?.background?.textures.map((texture) => texture.repeat).join(", ") ||
      "no-repeat",
  );
  root.style.backgroundColor = theme.colors.surface0;
  document.body.style.backgroundColor = theme.colors.surface0;
  const appRoot = document.getElementById("root");
  if (appRoot) appRoot.style.backgroundColor = theme.colors.surface0;
  let tint = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!tint) {
    tint = document.createElement("meta");
    tint.name = "theme-color";
    document.head.appendChild(tint);
  }
  tint.content = theme.colors.surface0;
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.appendChild(style);
  }
}
