import {
  useCallback,
  useEffect,
  useState,
  type ChangeEvent,
  type SyntheticEvent,
  type CSSProperties,
} from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import {
  INTERFACE_ZOOM_MIN,
  INTERFACE_ZOOM_MAX,
  INTERFACE_ZOOM_STEP,
  stepInterfaceZoom,
  useInterfaceZoom,
} from "@/appearance/interface-zoom.web";

const SLIDER_CLASS = "vorteo-zoom-slider";
const SLIDER_STYLE_ID = "vorteo-zoom-slider-styles";
const DEFAULT_STOP = ((100 - INTERFACE_ZOOM_MIN) / (INTERFACE_ZOOM_MAX - INTERFACE_ZOOM_MIN)) * 100;

// Range pseudo-elements cannot be styled inline. Freed's slim track, 100% tick
// and ringed thumb live in one shared stylesheet.
function installSliderStyles() {
  if (document.getElementById(SLIDER_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = SLIDER_STYLE_ID;
  const track = `linear-gradient(90deg, transparent calc(${DEFAULT_STOP}% - 1px), var(--colors-foreground-muted) calc(${DEFAULT_STOP}% - 1px), var(--colors-foreground-muted) calc(${DEFAULT_STOP}% + 1px), transparent calc(${DEFAULT_STOP}% + 1px)), linear-gradient(90deg, var(--colors-border), var(--colors-border))`;
  const thumb = `width: 14px; height: 14px; border: 1px solid var(--colors-accent); border-radius: 999px; background: var(--colors-surface0); box-shadow: 0 0 0 2px color-mix(in srgb, var(--colors-accent) 18%, transparent), 0 2px 8px rgba(0,0,0,0.18);`;
  style.textContent = `
.${SLIDER_CLASS} { appearance: none; -webkit-appearance: none; background: transparent; cursor: pointer; }
.${SLIDER_CLASS}:focus-visible { outline: 2px solid color-mix(in srgb, var(--colors-accent) 65%, transparent); outline-offset: 3px; border-radius: 999px; }
.${SLIDER_CLASS}::-webkit-slider-runnable-track { height: 3.5px; border-radius: 999px; background: ${track}; }
.${SLIDER_CLASS}::-moz-range-track { height: 3.5px; border-radius: 999px; background: ${track}; }
.${SLIDER_CLASS}::-webkit-slider-thumb { -webkit-appearance: none; margin-top: -5.25px; ${thumb} }
.${SLIDER_CLASS}::-moz-range-thumb { ${thumb} }
`;
  document.head.appendChild(style);
}

/** Commit range drags on release so the target never moves out from under a finger. */
export function InterfaceZoomControl() {
  const [zoom, setZoom] = useInterfaceZoom();
  const [draft, setDraft] = useState<number | null>(null);
  const value = draft ?? zoom;
  useEffect(installSliderStyles, []);
  const decrease = useCallback(() => setZoom(stepInterfaceZoom(zoom, -1)), [setZoom, zoom]);
  const increase = useCallback(() => setZoom(stepInterfaceZoom(zoom, 1)), [setZoom, zoom]);
  const change = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => setDraft(Number(event.target.value)),
    [],
  );
  const commit = useCallback(
    (event: SyntheticEvent<HTMLInputElement>) => {
      setZoom(Number(event.currentTarget.value));
      setDraft(null);
    },
    [setZoom],
  );
  const cancel = useCallback(() => setDraft(null), []);
  const blur = useCallback(
    (event: SyntheticEvent<HTMLInputElement>) => {
      if (draft !== null) setZoom(Number(event.currentTarget.value));
      setDraft(null);
    },
    [draft, setZoom],
  );
  const reset = useCallback(() => {
    setDraft(null);
    setZoom(100);
  }, [setZoom]);
  return (
    <View style={styles.section} testID="interface-zoom-control">
      <View style={styles.header}>
        <Text style={styles.label}>Zoom</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Reset interface zoom, currently ${value}%`}
          onPress={reset}
          style={styles.valueButton}
        >
          <Text style={styles.value}>{value}%</Text>
        </Pressable>
      </View>
      <View style={styles.group}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Decrease interface zoom"
          disabled={value <= INTERFACE_ZOOM_MIN}
          onPress={decrease}
          style={stepStyle(value <= INTERFACE_ZOOM_MIN)}
        >
          <Text style={styles.smallA}>A</Text>
        </Pressable>
        <input
          type="range"
          className={SLIDER_CLASS}
          aria-label="Interface zoom"
          aria-valuetext={`${value}%`}
          min={INTERFACE_ZOOM_MIN}
          max={INTERFACE_ZOOM_MAX}
          step={INTERFACE_ZOOM_STEP}
          value={value}
          style={rangeStyle}
          onChange={change}
          onPointerUp={commit}
          onPointerCancel={cancel}
          onKeyUp={commit}
          onBlur={blur}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Increase interface zoom"
          disabled={value >= INTERFACE_ZOOM_MAX}
          onPress={increase}
          style={stepStyle(value >= INTERFACE_ZOOM_MAX)}
        >
          <Text style={styles.largeA}>A</Text>
        </Pressable>
      </View>
    </View>
  );
}

function stepStyle(disabled: boolean) {
  return ({ hovered, pressed }: { hovered?: boolean; pressed: boolean }) => [
    styles.step,
    disabled ? styles.stepDisabled : (hovered || pressed) && styles.stepActive,
  ];
}

const rangeStyle: CSSProperties = {
  flex: 1,
  minWidth: 40,
  height: 20,
  margin: 0,
  touchAction: "none",
};

const styles = StyleSheet.create((theme) => ({
  section: { width: "100%", gap: 6 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 4,
  },
  label: { fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted },
  valueButton: { borderRadius: 6, paddingHorizontal: 4, paddingVertical: 2 },
  value: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    fontVariant: ["tabular-nums"],
  },
  // Freed's inset group: one bordered capsule holds both step buttons and the track.
  group: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    height: 44,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface1,
    overflow: "hidden",
  },
  step: {
    alignSelf: "stretch",
    width: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.md,
  },
  stepActive: { backgroundColor: theme.colors.surface2 },
  stepDisabled: { opacity: 0.38 },
  smallA: { fontSize: 11, fontWeight: "700", color: theme.colors.foregroundMuted },
  largeA: { fontSize: 16, fontWeight: "700", color: theme.colors.foregroundMuted },
}));
