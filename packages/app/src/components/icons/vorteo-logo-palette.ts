import type { Theme } from "@/styles/theme";

export interface LogoPalette {
  mode: "rainbow" | "white" | "gradient";
  start: string;
  end: string;
}
const palettes: Record<string, LogoPalette> = {
  "starship-light": { mode: "rainbow", start: "#2456b8", end: "#b32672" },
  "starship-dark": { mode: "white", start: "#ffffff", end: "#c7c7cc" },
  scriptorium: { mode: "gradient", start: "#86684a", end: "#3f2b1c" },
  midas: { mode: "gradient", start: "#f3dfad", end: "#d0b078" },
  ember: { mode: "gradient", start: "#ffd0a8", end: "#e99468" },
  neon: { mode: "gradient", start: "#bba4ff", end: "#69c8ff" },
};

export function logoPalette(theme: Theme): LogoPalette {
  return (
    palettes[theme.appearance?.id ?? ""] ??
    (theme.colorScheme === "light"
      ? palettes["starship-light"]
      : { mode: "gradient", start: theme.colors.foreground, end: theme.colors.accentBright })
  );
}
