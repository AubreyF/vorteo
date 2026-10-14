import type { Theme } from "@/styles/theme";
import { logoPalette } from "@/components/icons/vorteo-logo-palette";

/** Keep the pre-React loader on the same palette as mounted brand marks. */
export function applyBootLogo(theme: Theme): void {
  const brand = {
    ...logoPalette(theme),
    background: theme.colors.surface0,
    foreground: theme.colors.foreground,
  };
  try {
    localStorage.setItem("vorteo-boot-brand-v1", JSON.stringify(brand));
  } catch {
    /* Private browsing may disable storage. */
  }
  const bootWindow = window as Window & { __vorteoApplyBootBrand?: (value: typeof brand) => void };
  bootWindow.__vorteoApplyBootBrand?.(brand);
}
