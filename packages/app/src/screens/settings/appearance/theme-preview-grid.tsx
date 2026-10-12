import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Text, View, useWindowDimensions } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { useThemePreview, useThemePreviewActive } from "@/appearance/provider";
import { useAppSettings } from "@/hooks/use-settings";
import {
  APPEARANCE_DEFINITIONS,
  type AppearanceDefinition,
  type AppearanceId,
} from "@/styles/appearance-catalog";
import { THEME_OPTIONS } from "@/styles/theme";
import { isWeb } from "@/constants/platform";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
import { useVortonTouch } from "@/vorton-touch";
import { Tooltip, TooltipContent, TooltipText, TooltipTrigger } from "@/components/ui/tooltip";
import { ThemePreviewArtwork } from "./theme-preview-artwork";

const previewDataset = { ptheme: true };

interface ThemePreviewCardProps {
  compact?: boolean;
  appearance: AppearanceDefinition;
  selected: boolean;
  pending: boolean;
  onCommit: (id: AppearanceId) => void;
}

function ThemePreviewCard({
  appearance,
  selected,
  pending,
  onCommit,
  compact: forceCompact,
}: ThemePreviewCardProps) {
  const preview = useThemePreview();
  const touch = useVortonTouch();
  const { width } = useWindowDimensions();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearTimer = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);
  useEffect(() => {
    if (pending) clearTimer();
  }, [clearTimer, pending]);
  useEffect(() => {
    if (!isWeb) return clearTimer;
    const cancel = (event: KeyboardEvent) => {
      if (event.key === "Escape") clearTimer();
    };
    window.addEventListener("keydown", cancel, true);
    return () => {
      clearTimer();
      window.removeEventListener("keydown", cancel, true);
    };
  }, [clearTimer]);
  const stopPreview = useCallback(() => {
    clearTimer();
    preview((current) => (current === appearance.id ? null : current));
  }, [appearance.id, clearTimer, preview]);
  const enter = useCallback(() => {
    if (touch || pending) return;
    clearTimer();
    timer.current = setTimeout(() => preview(appearance.id), 180);
  }, [appearance.id, clearTimer, pending, preview, touch]);
  const focus = useCallback(() => {
    if (!touch && !pending) preview(appearance.id);
  }, [appearance.id, pending, preview, touch]);
  const commit = useCallback(() => {
    clearTimer();
    onCommit(appearance.id);
  }, [appearance.id, clearTimer, onCommit]);
  const option = THEME_OPTIONS.find((item) => item.name === appearance.id);
  if (!option || !("theme" in option)) throw new Error("Missing built-in theme");
  const palette = option.theme.colors;
  const compact = forceCompact || width < 640;
  const activeHeight = compact ? 35.2 : 38.4;
  const restingHeight = compact ? 17.6 : 19.2;
  const swatchHeight = selected ? activeHeight : restingHeight;
  const accessibilityState = useMemo(() => ({ selected, disabled: pending }), [pending, selected]);
  const cardStyle = useMemo(() => [styles.card, { width: compact ? 48 : 56 }], [compact]);
  const fillStyle = useMemo(
    () => [
      styles.swatch,
      {
        width: compact ? 48 : 56,
        height: swatchHeight,
        borderColor: selected ? palette.ring : "rgba(255,255,255,0.42)",
      },
      inlineUnistylesStyle({
        backgroundColor: palette.accent,
        ...(isWeb ? { backgroundImage: appearance.previewGradient } : {}),
      }),
    ],
    [appearance.previewGradient, compact, palette.accent, palette.ring, selected, swatchHeight],
  );
  // Button children are text. Keep graphics outside that wrapper so native text
  // layout cannot squeeze the swatch width.
  const swatch = useMemo(
    () => (
      <View style={fillStyle} testID={`theme-preview-surface-${appearance.id}`}>
        <ThemePreviewArtwork
          appearance={appearance.id}
          width={compact ? 48 : 56}
          height={swatchHeight}
        />
        <View style={styles.sheen} />
      </View>
    ),
    [appearance.id, compact, fillStyle, swatchHeight],
  );
  return (
    <View
      style={styles.hoverTarget}
      onPointerEnter={enter}
      onPointerLeave={stopPreview}
      dataSet={previewDataset}
    >
      <Tooltip delayDuration={180} enabledOnMobile>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            style={cardStyle}
            onPress={commit}
            onFocus={focus}
            onBlur={stopPreview}
            disabled={pending}
            accessibilityLabel={`${appearance.name}. ${appearance.description}`}
            accessibilityState={accessibilityState}
            aria-pressed={selected}
            testID={`theme-preview-${appearance.id}`}
            trailing={swatch}
          />
        </TooltipTrigger>
        <TooltipContent>
          <TooltipText
            label={appearance.name}
            description={`${appearance.tagline} ${appearance.description}`}
          />
        </TooltipContent>
      </Tooltip>
    </View>
  );
}

export function ThemePreviewGrid({
  compact = false,
  selectTheme,
}: { compact?: boolean; selectTheme?: (action: () => void) => void } = {}) {
  const previewing = useThemePreviewActive();
  const { settings, updateSettings } = useAppSettings();
  const preview = useThemePreview();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => () => preview(null), [preview]);
  useEffect(() => {
    if (!isWeb) return;
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !previewing) return;
      event.preventDefault();
      event.stopPropagation();
      preview(null);
    };
    window.addEventListener("keydown", dismiss, true);
    return () => {
      window.removeEventListener("keydown", dismiss, true);
    };
  }, [preview, previewing]);
  const commit = useCallback(
    async (id: AppearanceId) => {
      setSaving(true);
      setError(null);
      try {
        await updateSettings({ theme: id });
        preview(null);
      } catch {
        preview(null);
        setError("Could not save the theme. Try again.");
      } finally {
        setSaving(false);
      }
    },
    [preview, updateSettings],
  );
  const select = useCallback(
    (id: AppearanceId) => {
      if (selectTheme)
        selectTheme(() => {
          void commit(id);
        });
      else void commit(id);
    },
    [commit, selectTheme],
  );
  return (
    <View>
      <View style={styles.grid}>
        {APPEARANCE_DEFINITIONS.map((appearance) => (
          <ThemePreviewCard
            key={appearance.id}
            compact={compact}
            appearance={appearance}
            selected={settings.theme === appearance.id}
            pending={saving}
            onCommit={select}
          />
        ))}
      </View>
      {error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  grid: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 44 },
  hoverTarget: { position: "relative" },
  card: {
    padding: 0,
    borderWidth: 0,
    borderRadius: 25,
    height: 44,
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "transparent",
  },
  swatch: { width: "100%", borderRadius: 24, borderWidth: 1.5, overflow: "hidden" },
  sheen: {
    position: "absolute",
    left: 4,
    right: 4,
    top: 2,
    height: 5,
    borderRadius: 20,
    backgroundColor: "rgba(255,255,255,0.22)",
  },
  error: { color: theme.colors.statusDanger, padding: 12 },
}));
