// Theme metadata and background recipes adapted from Vorton web/design/theme-registry.ts
// at 6e84901, originally shared with Freed. Keep IDs and reference copy aligned.
export const DEFAULT_APPEARANCE_ID = "starship-dark" as const;

export type AppearanceId =
  | "starship-light"
  | "starship-dark"
  | "neon"
  | "midas"
  | "ember"
  | "scriptorium";

export type AppearanceSurface = "dark" | "light";
export type AppearanceMode = "freed" | "starship";
export type AppearanceEffects = "dramatic" | "restrained";
export type AtmosphereChannel = "primary" | "secondary" | "tertiary";

export interface AppearanceTextureLayer {
  image: string;
  size: string;
  repeat: "repeat" | "no-repeat";
  compactSize?: string;
  compactOpacity?: number;
}

export interface AppearanceHeroOrb {
  channel: AtmosphereChannel;
  xMin: number;
  xRange: number;
  yMin: number;
  yRange: number;
  sizeMin: number;
  sizeRange: number;
  intensity: number;
}

export interface AppearanceRowOrbs {
  countPerRow: number;
  channels: readonly AtmosphereChannel[];
  xMin: number;
  xRange: number;
  yRangeFactor: number;
  sizeMin: number;
  sizeRange: number;
  intensityMin: number;
  intensityRange: number;
}

export interface AppearanceBackgroundRecipe {
  shellBackground: string;
  overlayBackground: string;
  baseOpacity: number;
  textures: readonly AppearanceTextureLayer[];
  heroOrbs: readonly AppearanceHeroOrb[];
  rowOrbs: AppearanceRowOrbs;
  renderer?: "legacy" | "responsive";
  overlayEnabled?: boolean;
}

export interface AppearanceDefinition {
  id: AppearanceId;
  name: string;
  tagline: string;
  description: string;
  previewGradient: string;
  previewDisplayFont: string;
  previewBodyFont: string;
  surface: AppearanceSurface;
  mode: AppearanceMode;
  effects: AppearanceEffects;
  background?: AppearanceBackgroundRecipe;
}

const NOISE_TEXTURE = `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='1.2' numOctaves='4' stitchTiles='stitch' result='noise'/%3E%3CfeColorMatrix type='matrix' values='0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.5 0' in='noise' result='dark'/%3E%3CfeComponentTransfer in='dark'%3E%3CfeFuncA type='linear' slope='1.5'/%3E%3C/feComponentTransfer%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")`;
const MIDAS_NOISE_TEXTURE = `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='1.05' numOctaves='3' stitchTiles='stitch' result='noise'/%3E%3CfeColorMatrix type='matrix' values='0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.42 0' in='noise' result='dark'/%3E%3CfeComponentTransfer in='dark'%3E%3CfeFuncA type='linear' slope='0.95'/%3E%3C/feComponentTransfer%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.58'/%3E%3C/svg%3E")`;
const LIGHT_NOISE_TEXTURE = `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.7' numOctaves='2' seed='7' stitchTiles='stitch' result='paper'/%3E%3CfeColorMatrix type='matrix' values='0 0 0 0 0.28 0 0 0 0 0.2 0 0 0 0 0.12 0 0 0 0.08 0' in='paper' result='paperTint'/%3E%3CfeTurbulence type='fractalNoise' baseFrequency='2.4' numOctaves='1' seed='11' stitchTiles='stitch' result='speckle'/%3E%3CfeColorMatrix type='matrix' values='0 0 0 0 0.38 0 0 0 0 0.29 0 0 0 0 0.18 0 0 0 0.028 0' in='speckle' result='speckleTint'/%3E%3CfeBlend in='paperTint' in2='speckleTint' mode='multiply'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.4'/%3E%3C/svg%3E")`;
const VELLUM_FIBER_TEXTURE = `url("data:image/svg+xml,%3Csvg viewBox='0 0 320 320' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='f'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.014 0.082' numOctaves='2' seed='19' stitchTiles='stitch' result='fiber'/%3E%3CfeColorMatrix type='matrix' values='0 0 0 0 0.5 0 0 0 0 0.38 0 0 0 0 0.22 0 0 0 0.065 0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23f)' opacity='0.44'/%3E%3C/svg%3E")`;

const DEFAULT_HERO_ORBS: readonly AppearanceHeroOrb[] = [
  {
    channel: "secondary",
    xMin: 15,
    xRange: 35,
    yMin: 100,
    yRange: 300,
    sizeMin: 600,
    sizeRange: 400,
    intensity: 1.2,
  },
  {
    channel: "primary",
    xMin: 50,
    xRange: 35,
    yMin: 200,
    yRange: 400,
    sizeMin: 550,
    sizeRange: 400,
    intensity: 1,
  },
] as const;

const DEFAULT_ROW_ORBS: AppearanceRowOrbs = {
  countPerRow: 2,
  channels: ["secondary", "primary", "tertiary"],
  xMin: 10,
  xRange: 80,
  yRangeFactor: 0.5,
  sizeMin: 500,
  sizeRange: 400,
  intensityMin: 0.6,
  intensityRange: 0.6,
};

const DEFAULT_OVERLAY_BACKGROUND = `radial-gradient(
      ellipse 900px 900px at -10% -15%,
      rgb(var(--theme-accent-secondary-rgb) / 0.11) 0%,
      rgb(var(--theme-accent-secondary-rgb) / 0.028) 36%,
      transparent 65%
    ),
    radial-gradient(
      ellipse 800px 800px at 110% 110%,
      rgb(var(--theme-accent-primary-rgb) / 0.09) 0%,
      rgb(var(--theme-accent-primary-rgb) / 0.022) 35%,
      transparent 65%
    ),
    radial-gradient(
      ellipse 720px 720px at 52% 108%,
      rgb(var(--theme-accent-tertiary-rgb) / 0.06) 0%,
      rgb(var(--theme-accent-tertiary-rgb) / 0.016) 34%,
      transparent 65%
    ),
    linear-gradient(180deg, transparent 0%, rgb(var(--theme-shell-rgb) / 0.05) 100%)`;

const NEON_SHELL_BACKGROUND = "linear-gradient(180deg, #090a11 0%, #0a0a0f 34%, #090909 100%)";
const MIDAS_SHELL_BACKGROUND = `radial-gradient(circle at 14% 14%, rgb(176 138 72 / 0.12) 0, transparent 36%),
    radial-gradient(circle at 78% 8%, rgb(124 92 56 / 0.1) 0, transparent 32%),
    radial-gradient(circle at 78% 84%, rgb(95 74 50 / 0.08) 0, transparent 34%),
    linear-gradient(180deg, #2b231d 0%, #342a22 42%, #241d18 100%)`;
const EMBER_SHELL_BACKGROUND = `radial-gradient(circle at 16% 14%, rgb(193 90 46 / 0.12) 0, transparent 36%),
    radial-gradient(circle at 78% 8%, rgb(122 47 31 / 0.12) 0, transparent 30%),
    radial-gradient(circle at 74% 84%, rgb(91 23 17 / 0.08) 0, transparent 32%),
    linear-gradient(180deg, #160d0c 0%, #1d1210 44%, #130a09 100%)`;
const SCRIPTORIUM_SHELL_BACKGROUND = `radial-gradient(circle at 16% 13%, rgb(176 138 97 / 0.06) 0, transparent 40%),
    radial-gradient(circle at 82% 10%, rgb(134 104 74 / 0.05) 0, transparent 34%),
    radial-gradient(circle at 70% 88%, rgb(216 196 161 / 0.04) 0, transparent 32%),
    linear-gradient(180deg, #f4ead7 0%, #efe3ce 44%, #eadcc4 100%)`;

export const APPEARANCE_DEFINITIONS: readonly AppearanceDefinition[] = [
  {
    id: "starship-light",
    name: "Starship",
    tagline: "Bright command deck",
    description: "The original AubOS command interface in its daylight palette.",
    previewGradient:
      "radial-gradient(circle at 71% 22%, #faffff 0 7%, rgb(139 234 255 / 0.34) 8% 13%, transparent 14%), radial-gradient(ellipse 82% 58% at 50% 112%, #77f1ff 0%, #3a8ee8 30%, #3644b8 68%, #211c72 100%), linear-gradient(180deg, #fbffff 0%, #e9f8ff 35%, #c9e6ff 68%, #aabcf6 100%)",
    previewDisplayFont: '"Barlow Condensed", sans-serif',
    previewBodyFont: '"Barlow", sans-serif',
    surface: "light",
    mode: "starship",
    effects: "restrained",
  },
  {
    id: "starship-dark",
    name: "Dark Star",
    tagline: "Night command deck",
    description: "The original AubOS command interface in its low-light palette.",
    previewGradient:
      "radial-gradient(circle at 72% 28%, #d8f7ff 0 4%, transparent 5%), linear-gradient(145deg, #07090d 0%, #171a24 54%, #28405e 100%)",
    previewDisplayFont: '"Barlow Condensed", sans-serif',
    previewBodyFont: '"Barlow", sans-serif',
    surface: "dark",
    mode: "starship",
    effects: "restrained",
  },
  {
    id: "scriptorium",
    name: "Scriptorium",
    tagline: "Warm paper, dark ink, and a mind finally left alone.",
    description:
      "A low-blue-light editorial theme for long reading sessions. Vellum, walnut, and quietly dignified typography.",
    previewGradient: "linear-gradient(135deg, #f4ead7, #d8c4a1 55%, #86684a)",
    previewDisplayFont:
      '"Baskerville", "Hoefler Text", "Iowan Old Style", "Palatino Linotype", Georgia, serif',
    previewBodyFont: '"Manrope", "Avenir Next", "Segoe UI", "Helvetica Neue", Arial, sans-serif',
    surface: "light",
    mode: "freed",
    effects: "restrained",
    background: {
      shellBackground: SCRIPTORIUM_SHELL_BACKGROUND,
      overlayBackground: DEFAULT_OVERLAY_BACKGROUND,
      baseOpacity: 0.05,
      textures: [
        { image: VELLUM_FIBER_TEXTURE, size: "420px 420px", repeat: "repeat" },
        { image: LIGHT_NOISE_TEXTURE, size: "256px 256px", repeat: "repeat" },
      ],
      heroOrbs: DEFAULT_HERO_ORBS,
      rowOrbs: DEFAULT_ROW_ORBS,
    },
  },
  {
    id: "midas",
    name: "Midas",
    tagline: "A rescued scroll lit by candle and ambition.",
    description: "Parchment, bronze, and old-world warmth. Elegant, ceremonial, and quietly grand.",
    previewGradient: "linear-gradient(135deg, #7c5c38, #b08a48 55%, #5f4a32)",
    previewDisplayFont: '"Baskerville", "Didot", "Bodoni 72", "Palatino Linotype", serif',
    previewBodyFont: '"Iowan Old Style", "Palatino Linotype", "Book Antiqua", Georgia, serif',
    surface: "dark",
    mode: "freed",
    effects: "dramatic",
    background: {
      shellBackground: MIDAS_SHELL_BACKGROUND,
      overlayBackground: DEFAULT_OVERLAY_BACKGROUND,
      baseOpacity: 0.082,
      textures: [{ image: MIDAS_NOISE_TEXTURE, size: "256px 256px", repeat: "repeat" }],
      heroOrbs: DEFAULT_HERO_ORBS,
      rowOrbs: DEFAULT_ROW_ORBS,
    },
  },
  {
    id: "ember",
    name: "Ember",
    tagline: "Iron, soot, and a hand that means it.",
    description:
      "Volcanic charcoal with ember-orange heat. Heavier, sharper, and forged for impact.",
    previewGradient: "linear-gradient(135deg, #7a2f1f, #c15a2e 55%, #5b1711)",
    previewDisplayFont: '"Avenir Next Condensed", "Impact", "Arial Black", sans-serif',
    previewBodyFont: '"Optima", "Avenir Next", "Segoe UI", "Helvetica Neue", sans-serif',
    surface: "dark",
    mode: "freed",
    effects: "dramatic",
    background: {
      shellBackground: EMBER_SHELL_BACKGROUND,
      overlayBackground: DEFAULT_OVERLAY_BACKGROUND,
      baseOpacity: 0.078,
      textures: [{ image: MIDAS_NOISE_TEXTURE, size: "320px 320px", repeat: "repeat" }],
      heroOrbs: DEFAULT_HERO_ORBS,
      rowOrbs: DEFAULT_ROW_ORBS,
    },
  },
  {
    id: "neon",
    name: "Neon",
    tagline: "Electric, rebellious, and gloriously overclocked.",
    description:
      "Blue, purple, and cyan. Wired hot, moving fast, and ready to defend a sovereign protopia.",
    previewGradient: "linear-gradient(135deg, #3b82f6, #8b5cf6 55%, #06b6d4)",
    previewDisplayFont: '"Space Grotesk", "Manrope", system-ui, sans-serif',
    previewBodyFont: '"Manrope", system-ui, -apple-system, sans-serif',
    surface: "dark",
    mode: "freed",
    effects: "dramatic",
    background: {
      shellBackground: NEON_SHELL_BACKGROUND,
      overlayBackground: "none",
      baseOpacity: 0.12,
      textures: [{ image: NOISE_TEXTURE, size: "256px 256px", repeat: "repeat" }],
      heroOrbs: DEFAULT_HERO_ORBS,
      rowOrbs: DEFAULT_ROW_ORBS,
      renderer: "legacy",
      overlayEnabled: false,
    },
  },
] as const;

const APPEARANCE_MAP = new Map(
  APPEARANCE_DEFINITIONS.map((appearance) => [appearance.id, appearance] as const),
);

export function isAppearanceId(value: string | null | undefined): value is AppearanceId {
  return Boolean(value && APPEARANCE_MAP.has(value as AppearanceId));
}

export function resolveAppearanceId(value: string | null | undefined): AppearanceId {
  return isAppearanceId(value) ? value : DEFAULT_APPEARANCE_ID;
}

export function getAppearanceDefinition(appearanceId: AppearanceId): AppearanceDefinition {
  return APPEARANCE_MAP.get(appearanceId) ?? APPEARANCE_DEFINITIONS[0];
}

export function getAppearanceAttributes(appearanceId: AppearanceId) {
  const appearance = getAppearanceDefinition(appearanceId);
  return {
    theme: appearance.id,
    surface: appearance.surface,
    mode: appearance.mode,
  } as const;
}
