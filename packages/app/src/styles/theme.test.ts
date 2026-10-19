import { logoPalette } from "../components/icons/vorteo-logo-palette";
import { describe, expect, it } from "vitest";
import { darkTheme, FONT_SIZE, getNextThemePreference, lightTheme, THEME_OPTIONS } from "./theme";
import { APPEARANCE_DEFINITIONS } from "./appearance-catalog";
import { resolveAppearanceFont } from "./appearance-font";

describe("Theme catalog", () => {
  it("selects bundled body fonts and native display fonts in authored order", () => {
    const theme = APPEARANCE_DEFINITIONS.find((appearance) => appearance.id === "scriptorium")!;
    expect(
      resolveAppearanceFont({
        stack: theme.previewBodyFont,
        platform: "ios",
        systemFont: "system-ui",
      }),
    ).toBe("Barlow");
    expect(
      resolveAppearanceFont({
        stack: theme.previewDisplayFont,
        platform: "ios",
        systemFont: "system-ui",
      }),
    ).toBe("BarlowCondensed-Regular");
    expect(
      resolveAppearanceFont({
        stack: theme.previewBodyFont,
        platform: "web",
        systemFont: "system-ui",
      }),
    ).toBe(theme.previewBodyFont);
  });

  it("uses native generic fallbacks when the authored families are unavailable", () => {
    expect(
      resolveAppearanceFont({
        stack: '"Unknown", serif',
        platform: "ios",
        systemFont: "system-ui",
      }),
    ).toBe("Georgia");
    expect(
      resolveAppearanceFont({
        stack: '"Optima", sans-serif',
        platform: "android",
        systemFont: "normal",
      }),
    ).toBe("normal");
    expect(
      resolveAppearanceFont({
        stack: '"Baskerville", serif',
        platform: "android",
        systemFont: "normal",
      }),
    ).toBe("serif");
  });

  it("keeps the first available family across bundled and platform fonts", () => {
    for (const platform of ["ios", "android"]) {
      for (const family of ["Barlow", "Manrope", "Space Grotesk"]) {
        expect(
          resolveAppearanceFont({
            stack: `"Unavailable", "${family}", sans-serif`,
            platform,
            systemFont: "normal",
          }),
        ).toBe(family);
      }
    }
    expect(
      resolveAppearanceFont({
        stack: '"Optima", "Manrope", sans-serif',
        platform: "ios",
        systemFont: "normal",
      }),
    ).toBe("Optima");
    expect(
      resolveAppearanceFont({
        stack: '"Unavailable", "Avenir Next", sans-serif',
        platform: "ios",
        systemFont: "normal",
      }),
    ).toBe("Avenir Next");
  });
  it("preserves the condensed trait for iOS weight matching without changing Android registration", () => {
    const stack = '"Barlow Condensed", sans-serif';
    expect(resolveAppearanceFont({ stack, platform: "ios", systemFont: "normal" })).toBe(
      "BarlowCondensed-Regular",
    );
    expect(resolveAppearanceFont({ stack, platform: "android", systemFont: "normal" })).toBe(
      "Barlow Condensed",
    );
  });
  function contrast(a: string, b: string): number {
    const luminance = (hex: string) => {
      const channels = [1, 3, 5].map((start) => {
        const value = Number.parseInt(hex.slice(start, start + 2), 16) / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      });
      return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
    };
    const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (values[0] + 0.05) / (values[1] + 0.05);
  }

  it("keeps palette logo gradients distinct against every working surface", () => {
    for (const option of THEME_OPTIONS) {
      if (!("theme" in option)) continue;
      const palette = logoPalette(option.theme);
      if (option.name === "starship-light") {
        expect(palette.mode).toBe("rainbow");
        continue;
      }
      for (const color of [palette.start, palette.end]) {
        for (const surface of [option.theme.colors.surface0, option.theme.colors.surface3]) {
          expect(contrast(color, surface), option.name).toBeGreaterThanOrEqual(3);
        }
      }
    }
  });

  it("keeps normal text and primary button labels readable in every palette", () => {
    for (const option of THEME_OPTIONS) {
      if (!("theme" in option)) continue;
      const c = option.theme.colors;
      for (const surface of [c.surface0, c.surface1, c.surface2, c.surface3]) {
        expect(contrast(c.foreground, surface), option.name).toBeGreaterThanOrEqual(4.5);
        expect(contrast(c.foregroundMuted, surface), option.name).toBeGreaterThanOrEqual(4.5);
      }
      expect(contrast(c.accentForeground, c.accent), option.name).toBeGreaterThanOrEqual(4.5);
      expect(
        contrast(c.successForeground, c.success),
        option.name + " success button",
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrast(c.destructiveForeground, c.destructive),
        option.name + " destructive button",
      ).toBeGreaterThanOrEqual(4.5);
      for (const signal of [c.statusSuccess, c.statusDanger, c.statusWarning, c.statusMerged]) {
        expect(contrast(signal, c.surface3), option.name + " status text").toBeGreaterThanOrEqual(
          4.5,
        );
      }
    }
  });
  it("offers all six reference themes and system selection without retired choices", () => {
    expect(THEME_OPTIONS.map((option) => option.name)).toEqual([
      "starship-light",
      "starship-dark",
      "scriptorium",
      "midas",
      "ember",
      "neon",
      "auto",
    ]);
    expect(getNextThemePreference("neon")).toBe("auto");
    expect(getNextThemePreference("auto")).toBe("starship-light");
  });

  it("maps every appearance to a complete semantic theme and authored typography", () => {
    for (const appearance of APPEARANCE_DEFINITIONS) {
      const option = THEME_OPTIONS.find((item) => item.name === appearance.id);
      expect(option).toBeDefined();
      if (!option || !("theme" in option)) throw new Error("Missing concrete theme");
      expect(option.theme.colorScheme).toBe(appearance.surface);
      expect(option.theme.appearance).toEqual(appearance);
      expect(option.theme.fontFamily.ui).toBeTruthy();
      expect(option.theme.fontFamily.display).toBeTruthy();
      expect(option.theme.colors.terminal.foreground).toBe(option.theme.colors.foreground);
      expect(option.theme.colors.statusDanger).not.toBe(option.theme.colors.accent);
      expect(Object.keys(option.theme.colors).sort()).toEqual(Object.keys(darkTheme.colors).sort());
    }
  });

  it("uses the Starship pair for adaptive themes and terminal/plugin defaults", () => {
    expect(lightTheme.appearance.id).toBe("starship-light");
    expect(darkTheme.appearance.id).toBe("starship-dark");
    expect(darkTheme.colors.surface0).toBe("#222222");
    expect(lightTheme.colors.surface0).toBe("#e2e2ee");
  });

  it("keeps working surfaces opaque and sidebar selection distinct", () => {
    for (const option of THEME_OPTIONS) {
      if (!("theme" in option)) continue;
      const { colors } = option.theme;
      expect(colors.surface0).toMatch(/^#[0-9a-f]{6}$/i);
      expect(colors.surfaceSidebarSelected).not.toBe(colors.surfaceSidebar);
      expect(colors.foreground).not.toBe(colors.surface0);
    }
  });
});

describe("Typography scale", () => {
  it("keeps the established readable size tiers", () => {
    expect(FONT_SIZE).toEqual({
      code: 12,
      content: 15,
      sm: 12,
      base: 14,
      lg: 16,
      xl: 18,
      "2xl": 20,
      "3xl": 22,
      "4xl": 26,
    });
  });
});

it("keeps internal dividers quieter than borders across every appearance", () => {
  for (const option of THEME_OPTIONS) {
    if (!("theme" in option)) continue;
    const { theme } = option;
    const alpha = (color: string) => Number(color.match(/,\s*([\d.]+)\)$/)?.[1] ?? 1);
    expect(alpha(theme.colors.divider)).toBeCloseTo(alpha(theme.colors.border) * 0.55);
  }
});
