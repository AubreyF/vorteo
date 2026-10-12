import {
  getAppearanceDefinition,
  type AppearanceId,
  type AppearanceDefinition,
} from "./appearance-catalog";
import { hexColorWithAlpha } from "@/utils/color";
import { Platform } from "react-native";
import { resolveAppearanceFont } from "./appearance-font";
import { darkHighlightColors, lightHighlightColors } from "@getpaseo/highlight";

export const LOADING_INDICATOR = {
  small: 20,
  large: 48,
  smallStroke: 1.75,
  largeStroke: 1.5,
} as const;

export const EXECUTION_ENVIRONMENT_COLORS = {
  container: "#7CB68B",
  host: "#E6B566",
} as const;

export const baseColors = {
  // Base colors
  white: "#ffffff",
  black: "#000000",

  // Zinc scale (primary gray palette)
  zinc: {
    50: "#fafafa",
    100: "#f4f4f5",
    200: "#e4e4e7",
    300: "#d4d4d8",
    400: "#a1a1aa",
    500: "#71717a",
    600: "#52525b",
    700: "#3f3f46",
    800: "#27272a",
    850: "#1a1a1d",
    900: "#18181b",
    950: "#121214",
  },

  // Gray scale
  gray: {
    50: "#f9fafb",
    100: "#f3f4f6",
    200: "#e5e7eb",
    300: "#d1d5db",
    400: "#9ca3af",
    500: "#6b7280",
    600: "#4b5563",
    700: "#374151",
    800: "#1f2937",
    900: "#111827",
  },

  // Slate scale
  slate: {
    200: "#e2e8f0",
  },

  // Blue scale
  blue: {
    50: "#eff6ff",
    100: "#dbeafe",
    200: "#bfdbfe",
    300: "#93c5fd",
    400: "#60a5fa",
    500: "#3b82f6",
    600: "#2563eb",
    700: "#1d4ed8",
    800: "#1e40af",
    900: "#1e3a8a",
    950: "#172554",
  },

  // Green scale
  green: {
    100: "#dcfce7",
    200: "#bbf7d0",
    400: "#4ade80",
    500: "#22c55e",
    600: "#16a34a",
    800: "#166534",
    900: "#14532d",
  },

  // Red scale
  red: {
    100: "#fee2e2",
    200: "#fecaca",
    300: "#fca5a5",
    500: "#ef4444",
    600: "#dc2626",
    800: "#991b1b",
    900: "#7f1d1d",
  },

  // Teal scale
  teal: {
    200: "#99f6e4",
  },

  // Amber scale
  amber: {
    500: "#f59e0b",
    700: "#b45309",
  },

  // Yellow scale
  yellow: {
    400: "#fbbf24",
  },

  // Purple scale
  purple: {
    500: "#a855f7",
    600: "#9333ea",
  },

  // Orange scale
  orange: {
    500: "#f97316",
    600: "#ea580c",
  },
} as const;

// Diff colors — the +/- inside a diff view, where the color *is* the signal and has to
// survive being scanned line by line, so it stays saturated. Light uses muted tones, dark
// uses the brighter palette values.
//
// A diff *stat* — the "+12 −3" footnote next to a title — is not this. It is a status
// signal, so it uses statusSuccess/statusDanger below rather than a tier of its own.
const lightDiffColors = {
  diffAddition: "#15803d", // green-700 — readable on white without screaming
  diffDeletion: "#b91c1c", // red-700
};

const darkDiffColors = {
  diffAddition: "#4ade80", // green-400
  diffDeletion: "#ef4444", // red-500
};

// Status colors — semantic signals for success/danger/warning/merged. There is exactly one
// token per signal, and every status surface uses it: PR state icons, CI check icons and
// pies, diff stats, file-change icons, status badges, usage bars. Status *dots* are the
// exception and have their own band below. A surface does not otherwise get a quieter or
// louder variant of a status color because of where it sits — if a dense list feels loud,
// that is a density or weight problem, not a color problem.
//
// The level is set by the densest consumer, the sidebar workspace list: quiet enough that a
// column of green checks reads as one line of subtitle and the single red row still stands
// out, saturated enough to name the state on its own. Every other surface follows it.
//
// Normalized, not hand-picked. Every color below shares one lightness and one chroma; only
// the hue changes, and each hue is the one that family already had. Chroma is a fixed
// fraction of what sRGB allows at that lightness and hue, because the gamut is lopsided —
// amber runs out of room long before red does, so a literal equal-chroma set leaves amber
// flat and red screaming. Equal fractions is what makes four hues read as one family.
// Regenerate with the same rule rather than nudging one value.
//
// Hues are fixed per family across both themes: success 150, danger 27, warning 70.5,
// merged 300.
const lightStatusColors = {
  // L=0.50, chroma 60% of gamut max
  statusSuccess: "#3e704a",
  statusDanger: "#9d433b",
  statusWarning: "#7b5d39",
  statusMerged: "#7347af",
};

const darkStatusColors = {
  // L=0.70, chroma 55% of gamut max
  statusSuccess: "#6cb17b",
  statusDanger: "#d8847b",
  statusWarning: "#c09664",
  statusMerged: "#a890d5",
};

// Status tints — the fill of a status badge. The status color itself at low opacity, so a
// badge takes its state's hue from the same source as its text and never drifts from it.
// Dark surfaces swallow more of the tint, so the dark band runs a little stronger.
function statusTints(colors: typeof lightStatusColors, alphaHex: string) {
  return {
    statusSuccessTint: `${colors.statusSuccess}${alphaHex}`,
    statusDangerTint: `${colors.statusDanger}${alphaHex}`,
    statusWarningTint: `${colors.statusWarning}${alphaHex}`,
  };
}

const lightStatusTints = statusTints(lightStatusColors, "1f"); // 12%
const darkStatusTints = statusTints(darkStatusColors, "29"); // 16%

// Status *dot* colors — the small filled discs on a sidebar row, and the glyphs that stand in
// for them. Same four hues and the same generation rule as the status colors above, but its
// own band, because a dot is doing a different job than a check icon or a host badge.
//
// A dot is 6pt of solid color with no shape to read and no label attached. At the status
// band's lightness the dots read dimmer than the static text and icons beside them on the same
// row, which is backwards — the dot is the row's state. The loudness comes from chroma: 90% of
// gamut max against the status family's 55-60%.
//
// Lightness is set by hue separation, not by distance from the surface. A dark dot on a light
// surface has plenty of contrast but the four hues collapse into each other at 6pt — dark green,
// dark red, dark amber and dark blue all read as "dark blob", and the point of the dot is telling
// them apart at a glance. So the light band runs as bright as the contrast floor allows: L=0.62
// is the last step where all four clear 3:1 against the sidebar's surface2 (success is the
// binding one at 3.10, and drops under 3 by L=0.64), which is WCAG's non-text minimum for a
// control that carries state.
//
// All four move together. A dot matching its siblings in lightness and chroma says only which
// state the row is in; one that does not says "this row matters more", which is a claim the
// color has no business making. Regenerate the set, never one hue.
//
// 90% and not 100%: at the gamut edge the lopsidedness is worst — green reaches C=0.215 while
// blue manages 0.116 — so the set stops reading as one family and green wins. Red running out
// of chroma as lightness climbs is what caps the dark band at L=0.72; higher turns the failed
// dot pink, and the light band pastels out the same way just above its own cap. Running is blue
// at hue 250, clear of
// identity-colors' blue at 256.6 so a blue host badge and a working dot on the same row do not
// read as related.
const lightStatusDotColors = {
  // L=0.62, chroma 90% of gamut max
  statusDotSuccess: "#299f51",
  statusDotDanger: "#f12e2f",
  statusDotWarning: "#b37824",
  statusDotRunning: "#268ae0",
};

const darkStatusDotColors = {
  // L=0.72, chroma 90% of gamut max
  statusDotSuccess: "#35c264",
  statusDotDanger: "#f7796d",
  statusDotWarning: "#db932e",
  statusDotRunning: "#5caaf6",
};

export interface LightThemeConfig {
  surface0: string;
  surface1: string;
  surface2: string;
  surface3: string;
  surface4: string;
  surfaceDiffEmpty: string;
  surfaceSidebar: string;
  foreground: string;
  foregroundMuted: string;
  foregroundExtraMuted: string;
  border: string;
  borderAccent: string;
  accent: string;
  accentBright: string;
  accentForeground?: string;
  primary: string;
  primaryForeground: string;
  destructive: string;
  terminalBlack: string;
  terminalBrightBlack: string;
  ring: string;
}

const lightTerminalAnsi = {
  red: "#dc2626",
  green: "#16a34a",
  yellow: "#ca8a04",
  blue: "#2563eb",
  magenta: "#9333ea",
  cyan: "#0891b2",
  white: "#ffffff",
  brightRed: "#ef4444",
  brightGreen: "#22c55e",
  brightYellow: "#f59e0b",
  brightBlue: "#3b82f6",
  brightMagenta: "#a855f7",
  brightCyan: "#06b6d4",
  brightWhite: "#fafafa",
} as const;

export function buildLightSemanticColors(tint: LightThemeConfig) {
  return {
    surface0: tint.surface0,
    surface1: tint.surface1,
    surface2: tint.surface2,
    surface3: tint.surface3,
    surface4: tint.surface4,
    surfaceDiffEmpty: tint.surfaceDiffEmpty,
    surfaceSidebar: tint.surfaceSidebar,
    surfaceSidebarHover: tint.surface1,
    surfaceSidebarSelected: tint.surface3,
    surfaceWorkspace: tint.surface0,
    interactionHighlight: "rgba(0, 0, 0, 0.06)",

    foreground: tint.foreground,
    foregroundMuted: tint.foregroundMuted,
    foregroundExtraMuted: tint.foregroundExtraMuted,

    border: tint.border,
    borderAccent: tint.borderAccent,

    accent: tint.accent,
    accentSubtle: hexColorWithAlpha(tint.accent, 0.13),
    accentSubtleHovered: hexColorWithAlpha(tint.accent, 0.2),
    accentBright: tint.accentBright,
    accentForeground: tint.accentForeground ?? tint.surface0,

    destructive: tint.destructive,
    destructiveForeground: tint.surface0,
    success: tint.accent,
    successForeground: tint.surface0,

    background: tint.surface0,
    popover: tint.surface0,
    popoverForeground: tint.foreground,
    primary: tint.primary,
    primaryForeground: tint.primaryForeground,
    secondary: tint.surface2,
    secondaryForeground: tint.foreground,
    muted: tint.surface2,
    mutedForeground: tint.foregroundMuted,
    accentBorder: tint.borderAccent,
    input: tint.surface2,
    ring: tint.ring,

    ...lightDiffColors,
    ...lightStatusColors,
    ...lightStatusTints,
    ...lightStatusDotColors,

    terminal: {
      background: tint.surface0,
      foreground: tint.foreground,
      cursor: tint.foreground,
      cursorAccent: tint.surface0,
      selectionBackground: "rgba(0, 0, 0, 0.15)",
      selectionForeground: tint.foreground,
      black: tint.terminalBlack,
      ...lightTerminalAnsi,
      brightBlack: tint.terminalBrightBlack,
    },
  };
}

// ---------------------------------------------------------------------------
// Dark theme variant builder
// ---------------------------------------------------------------------------

export interface DarkThemeConfig {
  surface0: string;
  surface1: string;
  surface2: string;
  surface3: string;
  surface4: string;
  surfaceDiffEmpty: string;
  surfaceSidebar: string;
  foregroundMuted: string;
  foregroundExtraMuted: string;
  border: string;
  borderAccent: string;
  accent: string;
  accentBright: string;
  accentForeground?: string;
  destructive: string;
  terminalBlack: string;
  terminalBrightBlack: string;
  foreground?: string;
  ring?: string;
}

const darkTerminalAnsi = {
  red: "#e07070",
  green: "#5dba80",
  yellow: "#d4a44a",
  blue: "#6a9de0",
  magenta: "#b07ad0",
  cyan: "#4aabb8",
  white: "#d4d4d8",
  brightRed: "#e89090",
  brightGreen: "#7ecf9a",
  brightYellow: "#e0be6e",
  brightBlue: "#8ab4e8",
  brightMagenta: "#c49ae0",
  brightCyan: "#6ec2cc",
  brightWhite: "#f0f0f2",
} as const;

export function buildDarkSemanticColors(tint: DarkThemeConfig) {
  const foreground = tint.foreground ?? "#fafafa";
  const ring = tint.ring ?? "#d4d4d8";
  return {
    surface0: tint.surface0,
    surface1: tint.surface1,
    surface2: tint.surface2,
    surface3: tint.surface3,
    surface4: tint.surface4,
    surfaceDiffEmpty: tint.surfaceDiffEmpty,
    surfaceSidebar: tint.surfaceSidebar,
    surfaceSidebarHover: tint.surface1,
    surfaceSidebarSelected: tint.surface2,
    surfaceWorkspace: tint.surface1,
    interactionHighlight: "rgba(255, 255, 255, 0.08)",

    foreground,
    foregroundMuted: tint.foregroundMuted,
    foregroundExtraMuted: tint.foregroundExtraMuted,

    border: tint.border,
    borderAccent: tint.borderAccent,

    accent: tint.accent,
    accentSubtle: hexColorWithAlpha(tint.accent, 0.13),
    accentSubtleHovered: hexColorWithAlpha(tint.accent, 0.2),
    accentBright: tint.accentBright,
    accentForeground: tint.accentForeground ?? "#ffffff",

    destructive: tint.destructive,
    destructiveForeground: "#ffffff",
    success: tint.accent,
    successForeground: "#ffffff",

    // Legacy aliases (for gradual migration)
    background: tint.surface0,
    popover: tint.surface2,
    popoverForeground: foreground,
    primary: foreground,
    primaryForeground: tint.surface0,
    secondary: tint.surface2,
    secondaryForeground: foreground,
    muted: tint.surface2,
    mutedForeground: tint.foregroundMuted,
    accentBorder: tint.borderAccent,
    input: tint.surface2,
    ring,

    ...darkDiffColors,
    ...darkStatusColors,
    ...darkStatusTints,
    ...darkStatusDotColors,

    terminal: {
      background: tint.surface0,
      foreground,
      cursor: foreground,
      cursorAccent: tint.surface0,
      selectionBackground: "rgba(255, 255, 255, 0.2)",
      selectionForeground: foreground,
      black: tint.terminalBlack,
      ...darkTerminalAnsi,
      brightBlack: tint.terminalBrightBlack,
    },
  };
}

export const SPACING = {
  0: 0,
  0.5: 2,
  1: 4,
  1.5: 6,
  2: 8,
  3: 12,
  4: 16,
  6: 24,
  8: 32,
  12: 48,
  16: 64,
  20: 80,
  24: 96,
  32: 128,
} as const;

export const FONT_SIZE = {
  code: 12,
  content: 15,
  sm: 12,
  base: 14,
  lg: 16,
  xl: 18,
  "2xl": 20,
  "3xl": 22,
  "4xl": 26,
} as const;

export const LINE_HEIGHT = {
  diff: 22,
} as const;

export const ICON_SIZE = {
  xs: 12,
  sm: 14,
  md: 16,
  lg: 20,
  xl: 24,
} as const;

export const ICON_STROKE_WIDTH = 1.5;

export const FONT_WEIGHT = {
  normal: "normal" as const,
  medium: "500" as const,
  semibold: "600" as const,
  bold: "bold" as const,
} as const;

export const BORDER_RADIUS = {
  none: 0,
  sm: 2,
  base: 4,
  md: 6,
  lg: 8,
  xl: 12,
  "2xl": 16,
  full: 9999,
} as const;

export const BORDER_WIDTH = {
  0: 0,
  1: 1,
  2: 2,
} as const;

export const OPACITY = {
  0: 0,
  50: 0.5,
  100: 1,
} as const;

// Platform default font stacks — copied verbatim from constants/theme.ts `Fonts`
// (sans -> ui, mono -> mono). These seed the dynamic `fontFamily` theme token and
// are the fallback an empty user-supplied family resolves to at apply time.
export const DEFAULT_UI_FONT_STACK: string = Platform.select({
  ios: "system-ui",
  default: "normal",
  web: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
});

export const DEFAULT_MONO_FONT_STACK: string = Platform.select({
  ios: "ui-monospace",
  default: "monospace",
  web: "SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
});

// Chat and markdown content column; the appearance updater patches the user's width in.
export const DEFAULT_CONTENT_MAX_WIDTH = 820;

// `fontSize`, `fontFamily`, `lineHeight`, and `contentMaxWidth` are deliberately widened to plain
// `number`/`string` (not narrowed by `as const`) so the appearance updater can patch
// them at runtime via `UnistylesRuntime.updateTheme`. The remaining tokens keep their
// literal types.
interface CommonTheme {
  spacing: typeof SPACING;
  fontSize: Record<keyof typeof FONT_SIZE, number>;
  fontFamily: { ui: string; mono: string; display: string };
  appearance: AppearanceDefinition | null;
  lineHeight: Record<keyof typeof LINE_HEIGHT, number>;
  contentMaxWidth: number;
  iconSize: typeof ICON_SIZE;
  fontWeight: typeof FONT_WEIGHT;
  borderRadius: typeof BORDER_RADIUS;
  borderWidth: typeof BORDER_WIDTH;
  opacity: typeof OPACITY;
}

const commonTheme: CommonTheme = {
  spacing: SPACING,
  fontSize: FONT_SIZE,
  fontFamily: {
    ui: DEFAULT_UI_FONT_STACK,
    mono: DEFAULT_MONO_FONT_STACK,
    display: DEFAULT_UI_FONT_STACK,
  },
  appearance: null,
  lineHeight: LINE_HEIGHT,
  contentMaxWidth: DEFAULT_CONTENT_MAX_WIDTH,
  iconSize: ICON_SIZE,
  fontWeight: FONT_WEIGHT,
  borderRadius: BORDER_RADIUS,
  borderWidth: BORDER_WIDTH,
  opacity: OPACITY,
};

const darkShadow = {
  sm: {
    shadowColor: "rgba(0, 0, 0, 0.25)",
    shadowOffset: { width: 0, height: 2 },
    shadowRadius: 4,
    elevation: 2,
  },
  md: {
    shadowColor: "rgba(0, 0, 0, 0.20)",
    shadowOffset: { width: 0, height: 4 },
    shadowRadius: 8,
    elevation: 8,
  },
  lg: {
    shadowColor: "rgba(0, 0, 0, 0.40)",
    shadowOffset: { width: 0, height: 12 },
    shadowRadius: 24,
    elevation: 8,
  },
} as const;

export function buildDarkTheme(semanticColors: ReturnType<typeof buildDarkSemanticColors>) {
  return {
    colorScheme: "dark" as const,
    colors: {
      ...semanticColors,
      palette: baseColors,
      syntax: darkHighlightColors,
    },
    shadow: darkShadow,
    ...commonTheme,
  } as const;
}

const lightShadow = {
  sm: {
    shadowColor: "rgba(0, 0, 0, 0.02)",
    shadowOffset: { width: 0, height: 2 },
    shadowRadius: 8,
    elevation: 2,
  },
  md: {
    shadowColor: "rgba(0, 0, 0, 0.04)",
    shadowOffset: { width: 0, height: 4 },
    shadowRadius: 16,
    elevation: 4,
  },
  lg: {
    shadowColor: "rgba(0, 0, 0, 0.08)",
    shadowOffset: { width: 0, height: 8 },
    shadowRadius: 24,
    elevation: 8,
  },
} as const;

export function buildLightTheme(semanticColors: ReturnType<typeof buildLightSemanticColors>) {
  return {
    colorScheme: "light" as const,
    colors: {
      ...semanticColors,
      palette: baseColors,
      syntax: lightHighlightColors,
    },
    shadow: lightShadow,
    ...commonTheme,
  } as const;
}

// Semantic adapters for Vorton's authored palettes. Opaque working surfaces keep
// code and small text readable; shell textures are rendered separately on web.
interface AppearancePalette {
  root: string;
  deep: string;
  surface: string;
  raised: string;
  text: string;
  secondary: string;
  muted: string;
  border: string;
  strong: string;
  accent: string;
  bright: string;
}
const APPEARANCE_PALETTES: Record<AppearanceId, AppearancePalette> = {
  "starship-light": {
    root: "#e2e2ee",
    deep: "#e8e8f1",
    surface: "#eeeef6",
    raised: "#f0f0f8",
    text: "#16163a",
    secondary: "#4a4a84",
    muted: "#5f5f9c",
    border: "rgba(0,0,40,0.1)",
    strong: "rgba(0,0,40,0.22)",
    accent: "#2997ff",
    bright: "#1672c8",
  },
  "starship-dark": {
    root: "#222222",
    deep: "#29292b",
    surface: "#2c2c2e",
    raised: "#38383a",
    text: "#f5f5f7",
    secondary: "#c7c7cc",
    muted: "#aeaeb2",
    border: "rgba(84,84,88,0.72)",
    strong: "#646468",
    accent: "#2997ff",
    bright: "#64d2ff",
  },
  scriptorium: {
    root: "#f4ead7",
    deep: "#ece0ca",
    surface: "#f8efdf",
    raised: "#faf2e4",
    text: "#2a1f17",
    secondary: "#5d4634",
    muted: "#85684b",
    border: "rgba(136,106,74,0.18)",
    strong: "rgba(132,100,68,0.28)",
    accent: "#86684a",
    bright: "#86684a",
  },
  midas: {
    root: "#2b231d",
    deep: "#352b23",
    surface: "#3e3229",
    raised: "#493c30",
    text: "#f3e9da",
    secondary: "#d0b89c",
    muted: "#a8967f",
    border: "rgba(188,157,108,0.28)",
    strong: "rgba(176,138,72,0.34)",
    accent: "#b08a48",
    bright: "#d0b89c",
  },
  ember: {
    root: "#180f0d",
    deep: "#221411",
    surface: "#2a1a16",
    raised: "#38221c",
    text: "#f7ede9",
    secondary: "#d5b4a6",
    muted: "#ab8474",
    border: "rgba(193,90,46,0.24)",
    strong: "rgba(193,90,46,0.32)",
    accent: "#c15a2e",
    bright: "#e99468",
  },
  neon: {
    root: "#0a0a0a",
    deep: "#0f0f15",
    surface: "#14141b",
    raised: "#20202d",
    text: "#f7f7fb",
    secondary: "#c2c3d5",
    muted: "#8b8da8",
    border: "rgba(255,255,255,0.08)",
    strong: "rgba(139,92,246,0.24)",
    accent: "#3b82f6",
    bright: "#a78bfa",
  },
};

function appearanceFont(stack: string): string {
  return resolveAppearanceFont({ stack, platform: Platform.OS, systemFont: DEFAULT_UI_FONT_STACK });
}

function buildAppearanceTheme(id: AppearanceId) {
  const appearance = getAppearanceDefinition(id);
  const p = APPEARANCE_PALETTES[id];
  const light = appearance.surface === "light";
  // The reference themes include warmer, lighter raised surfaces than the
  // legacy dark palette. Lift the whole status family by the same 16% white
  // blend so small status text keeps 4.5:1 contrast on every raised surface.
  const status = light
    ? lightStatusColors
    : {
        statusSuccess: "#84bd90",
        statusDanger: "#de9890",
        statusWarning: "#caa77d",
        statusMerged: "#b6a2dc",
      };
  const config = {
    surface0: p.root,
    surface1: p.deep,
    surface2: p.surface,
    surface3: p.raised,
    surface4: p.strong,
    surfaceDiffEmpty: p.deep,
    surfaceSidebar: id === "starship-light" ? p.surface : p.root,
    foreground: p.text,
    foregroundMuted: p.secondary,
    foregroundExtraMuted: p.muted,
    border: p.border,
    borderAccent: p.strong,
    accent: p.accent,
    accentBright: p.bright,
    accentForeground: id === "scriptorium" ? "#ffffff" : "#000000",
    primary: p.text,
    primaryForeground: p.root,
    destructive: light ? "#b3261e" : "#ff7168",
    terminalBlack: light ? "#353540" : "#777780",
    terminalBrightBlack: light ? "#5f5f69" : "#aeaeb2",
    ring: p.bright,
  };
  const base = light
    ? buildLightTheme(buildLightSemanticColors(config))
    : buildDarkTheme(buildDarkSemanticColors(config));
  return {
    ...base,
    colors: {
      ...base.colors,
      surfaceSidebarSelected: id === "starship-light" ? p.root : base.colors.surfaceSidebarSelected,
      ...status,
      ...statusTints(status, light ? "1f" : "29"),
      success: status.statusSuccess,
      successForeground: light ? "#ffffff" : "#000000",
      destructiveForeground: light ? "#ffffff" : "#000000",
    },
    appearance,
    fontFamily: {
      ...base.fontFamily,
      ui: appearanceFont(appearance.previewBodyFont),
      display: appearanceFont(appearance.previewDisplayFont),
    },
  };
}

// Keep these public aliases for terminal and plugin consumers. They now refer to
// the Starship pair, which also occupies Unistyles' adaptive light/dark slots.
export const lightTheme = buildAppearanceTheme("starship-light");
export const darkTheme = buildAppearanceTheme("starship-dark");
export const theme = darkTheme;

export const THEME_OPTIONS = [
  {
    name: "starship-light",
    group: "primary",
    unistylesName: "light",
    theme: lightTheme,
    swatch: "#e2e2ee",
  },
  {
    name: "starship-dark",
    group: "primary",
    unistylesName: "dark",
    theme: darkTheme,
    swatch: "#222222",
  },
  {
    name: "scriptorium",
    group: "variant",
    unistylesName: "scriptorium",
    theme: buildAppearanceTheme("scriptorium"),
    swatch: "#d8c4a1",
  },
  {
    name: "midas",
    group: "variant",
    unistylesName: "midas",
    theme: buildAppearanceTheme("midas"),
    swatch: "#b08a48",
  },
  {
    name: "ember",
    group: "variant",
    unistylesName: "ember",
    theme: buildAppearanceTheme("ember"),
    swatch: "#c15a2e",
  },
  {
    name: "neon",
    group: "variant",
    unistylesName: "neon",
    theme: buildAppearanceTheme("neon"),
    swatch: "#8b5cf6",
  },
  { name: "auto", group: "primary" },
] as const;

export const PLUGIN_THEME_PREFERENCE = "plugin";
export const PLUGIN_THEME_NAMES = {
  light: "pluginLight",
  dark: "pluginDark",
} as const;

export type ThemePreference =
  | (typeof THEME_OPTIONS)[number]["name"]
  | typeof PLUGIN_THEME_PREFERENCE;
export type ThemeName = Exclude<ThemePreference, "auto" | typeof PLUGIN_THEME_PREFERENCE>;
type ConcreteThemeOption = Exclude<(typeof THEME_OPTIONS)[number], { name: "auto" }>;
export interface Theme extends CommonTheme {
  colorScheme: "light" | "dark";
  colors: ReturnType<typeof buildAppearanceTheme>["colors"];
  shadow: typeof lightShadow | typeof darkShadow;
}

const CONCRETE_THEME_OPTIONS = THEME_OPTIONS.filter(
  (option): option is ConcreteThemeOption => option.name !== "auto",
);

type ThemeToUnistyles = {
  [Name in ThemeName]: Extract<ConcreteThemeOption, { name: Name }>["unistylesName"];
};

type ThemeSwatches = {
  [Name in ThemeName]: Extract<ConcreteThemeOption, { name: Name }>["swatch"];
};

type RegisteredThemes = {
  [Option in ConcreteThemeOption as Option["unistylesName"]]: Theme;
} & {
  pluginLight: Theme;
  pluginDark: Theme;
};

export const THEME_TO_UNISTYLES = Object.fromEntries(
  CONCRETE_THEME_OPTIONS.map((option) => [option.name, option.unistylesName]),
) as ThemeToUnistyles;

export const THEME_SWATCHES = Object.fromEntries(
  CONCRETE_THEME_OPTIONS.map((option) => [option.name, option.swatch]),
) as ThemeSwatches;

export const REGISTERED_THEMES = {
  ...Object.fromEntries(
    CONCRETE_THEME_OPTIONS.map((option) => [option.unistylesName, option.theme]),
  ),
  [PLUGIN_THEME_NAMES.light]: lightTheme,
  [PLUGIN_THEME_NAMES.dark]: darkTheme,
} as RegisteredThemes;

export function getNextThemePreference(current: ThemePreference): ThemePreference {
  const currentIndex = THEME_OPTIONS.findIndex((option) => option.name === current);
  const nextIndex = (currentIndex + 1) % THEME_OPTIONS.length;
  return THEME_OPTIONS[nextIndex]?.name ?? THEME_OPTIONS[0].name;
}
