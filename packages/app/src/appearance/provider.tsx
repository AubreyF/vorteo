import { useApplyInterfaceZoom } from "./interface-zoom";
import { vortonAppearance } from "./vorton-appearance";
import { useVortonTouch } from "@/vorton-touch";

import { applyVortonWeb } from "./vorton-web";
import {
  createContext,
  type ReactNode,
  type Dispatch,
  type SetStateAction,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { UnistylesRuntime } from "react-native-unistyles";
import {
  DEFAULT_THEME_PREFERENCE,
  resolveContentMaxWidth,
  useAppSettings,
  type AppSettings,
} from "@/hooks/use-settings";
import {
  rememberPluginThemeHost,
  usePluginThemeCatalog,
  type PluginThemeOption,
} from "@/plugins/themes";
import {
  PLUGIN_THEME_NAMES,
  PLUGIN_THEME_PREFERENCE,
  THEME_TO_UNISTYLES,
  REGISTERED_THEMES,
} from "@/styles/theme";
import { isWeb } from "@/constants/platform";
import { useColorScheme } from "react-native";
import { applyShellAppearance } from "./apply-shell";
import { applyAppearance } from "./apply";
import type { AppearanceId } from "@/styles/appearance-catalog";

interface ContributedThemes {
  options: PluginThemeOption[];
  selected: PluginThemeOption | null;
  select: (option: PluginThemeOption) => void;
}

interface ApplyThemeInput {
  preference: AppSettings["theme"];
  contributedTheme: PluginThemeOption | null;
}

const ThemePreviewActiveContext = createContext(false);
export function useThemePreviewActive() {
  return useContext(ThemePreviewActiveContext);
}

const ThemePreviewContext = createContext<Dispatch<SetStateAction<AppearanceId | null>> | null>(
  null,
);

export function useThemePreview() {
  const preview = useContext(ThemePreviewContext);
  if (!preview) throw new Error("useThemePreview requires AppearanceProvider");
  return preview;
}

const ContributedThemesContext = createContext<ContributedThemes | null>(null);

function applyTheme({ preference, contributedTheme }: ApplyThemeInput): void {
  if (contributedTheme) {
    const themeName = PLUGIN_THEME_NAMES[contributedTheme.theme.colorScheme];
    UnistylesRuntime.updateTheme(themeName, () => contributedTheme.theme);
    UnistylesRuntime.setAdaptiveThemes(false);
    UnistylesRuntime.setTheme(themeName);
    return;
  }

  const builtInPreference =
    preference === PLUGIN_THEME_PREFERENCE ? DEFAULT_THEME_PREFERENCE : preference;
  if (builtInPreference === "auto") {
    UnistylesRuntime.setAdaptiveThemes(true);
    return;
  }

  UnistylesRuntime.setAdaptiveThemes(false);
  UnistylesRuntime.setTheme(THEME_TO_UNISTYLES[builtInPreference]);
}

export function AppearanceProvider({ children }: { children: ReactNode }) {
  const { settings, updateSettings, isLoading } = useAppSettings();
  const touch = useVortonTouch();
  useApplyInterfaceZoom();
  const [preview, setPreview] = useState<AppearanceId | null>(null);
  const [previewApplied, setPreviewApplied] = useState(false);
  const systemScheme = useColorScheme();

  useEffect(() => applyVortonWeb(touch), [touch]);
  const [hasAppliedAppearance, setHasAppliedAppearance] = useState(false);
  // Start the handoff only after the themed children have committed and painted.
  useEffect(() => {
    if (!isWeb || !hasAppliedAppearance) return;
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => {
        (window as Window & { __vorteoFinishBoot?: () => void }).__vorteoFinishBoot?.();
      });
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [hasAppliedAppearance]);
  const lastTransitionTheme = useRef<string | null>(null);
  useEffect(() => {
    if (isLoading || !isWeb) return;
    const next = preview ?? settings.theme;
    const previous = lastTransitionTheme.current;
    lastTransitionTheme.current = next;
    if (
      previous === null ||
      previous === next ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    )
      return;
    const root = document.getElementById("root");
    const animation = root?.animate?.(
      [
        { filter: "blur(1.5px)", opacity: 0.94 },
        { filter: "blur(0px)", opacity: 1 },
      ],
      { duration: 180, easing: "ease-out" },
    );
    return () => animation?.cancel();
  }, [isLoading, preview, settings.theme]);

  const options = usePluginThemeCatalog();
  const selected = useMemo(() => {
    if (settings.theme !== PLUGIN_THEME_PREFERENCE) return null;
    return options.find((option) => option.id === settings.pluginThemeId) ?? null;
  }, [options, settings.pluginThemeId, settings.theme]);

  useEffect(() => {
    if (isLoading) return;
    applyTheme({
      preference: preview ?? settings.theme,
      contributedTheme: preview ? null : selected,
    });
    applyAppearance(
      vortonAppearance(
        {
          uiFontFamily: settings.uiFontFamily,
          monoFontFamily: settings.monoFontFamily,
          uiBaseFontSize: settings.uiBaseFontSize,
          contentFontSize: settings.contentFontSize,
          codeFontSize: settings.codeFontSize,
          contentMaxWidth: resolveContentMaxWidth({ contentMaxWidth: settings.contentMaxWidth }),
          syntaxTheme: settings.syntaxTheme,
        },
        touch,
      ),
    );
    applyShellAppearance(
      preview
        ? REGISTERED_THEMES[UnistylesRuntime.themeName ?? "dark"]
        : (selected?.theme ?? REGISTERED_THEMES[UnistylesRuntime.themeName ?? "dark"]),
      preview === null,
    );
    setPreviewApplied(preview !== null);
    setHasAppliedAppearance(true);
  }, [
    isLoading,
    preview,
    touch,
    selected,
    settings.theme,
    settings.uiFontFamily,
    settings.monoFontFamily,
    settings.uiBaseFontSize,
    settings.contentFontSize,
    settings.codeFontSize,
    settings.contentMaxWidth,
    settings.syntaxTheme,
    systemScheme,
  ]);

  const select = useCallback(
    (option: PluginThemeOption) => {
      rememberPluginThemeHost(option);
      void updateSettings({
        theme: PLUGIN_THEME_PREFERENCE,
        pluginThemeId: option.id,
      });
    },
    [updateSettings],
  );
  const value = useMemo(() => ({ options, selected, select }), [options, selected, select]);

  // The first settings load changes appearance keys. Mount screens only after applying it
  // so startup does not destroy and recreate an already-visible workspace.
  if (!hasAppliedAppearance) return null;

  return (
    <ThemePreviewActiveContext.Provider value={preview !== null || previewApplied}>
      <ThemePreviewContext.Provider value={setPreview}>
        <ContributedThemesContext.Provider value={value}>
          {children}
        </ContributedThemesContext.Provider>
      </ThemePreviewContext.Provider>
    </ThemePreviewActiveContext.Provider>
  );
}

export function useContributedThemes(): ContributedThemes {
  const themes = useContext(ContributedThemesContext);
  if (themes === null) throw new Error("useContributedThemes requires AppearanceProvider");
  return themes;
}
