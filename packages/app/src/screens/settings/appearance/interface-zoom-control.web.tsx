import {
  useCallback,
  useState,
  type ChangeEvent,
  type SyntheticEvent,
  type CSSProperties,
} from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import {
  INTERFACE_ZOOM_MIN,
  INTERFACE_ZOOM_MAX,
  INTERFACE_ZOOM_STEP,
  useInterfaceZoom,
} from "@/appearance/interface-zoom.web";

/** Commit range drags on release so the target never moves out from under a finger. */
export function InterfaceZoomControl() {
  const [zoom, setZoom] = useInterfaceZoom();
  const [draft, setDraft] = useState<number | null>(null);
  const value = draft ?? zoom;
  const decrease = useCallback(() => setZoom(Math.ceil(zoom / 10) * 10 - 10), [setZoom, zoom]);
  const increase = useCallback(() => setZoom(Math.floor(zoom / 10) * 10 + 10), [setZoom, zoom]);
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
    <View style={styles.row} testID="interface-zoom-control">
      <Button
        variant="ghost"
        textStyle={styles.smallA}
        accessibilityLabel="Decrease interface zoom"
        disabled={value <= INTERFACE_ZOOM_MIN}
        onPress={decrease}
      >
        A
      </Button>
      <input
        type="range"
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
      <Button
        variant="ghost"
        textStyle={styles.largeA}
        accessibilityLabel="Increase interface zoom"
        disabled={value >= INTERFACE_ZOOM_MAX}
        onPress={increase}
      >
        A
      </Button>
      <Button
        variant="ghost"
        style={styles.reset}
        accessibilityLabel={`Reset interface zoom, currently ${value}%`}
        onPress={reset}
      >
        {value}%
      </Button>
    </View>
  );
}
const rangeStyle: CSSProperties = {
  width: 120,
  minWidth: 60,
  flex: 1,
  height: 44,
  margin: 0,
  accentColor: "var(--colors-accent)",
  touchAction: "none",
};
const styles = StyleSheet.create({
  reset: { width: 72 },
  smallA: { fontSize: 12 },
  largeA: { fontSize: 20 },
  row: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    minHeight: 44,
    width: "100%",
    maxWidth: 376,
  },
});
