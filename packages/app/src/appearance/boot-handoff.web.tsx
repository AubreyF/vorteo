import { useEffect } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

const PROBE_ID = "vorteo-boot-style-probe";

function stylesApplied(): boolean {
  const probe = document.getElementById(PROBE_ID);
  if (!probe) return false;
  const computed = getComputedStyle(probe);
  const runtimeStylesApplied =
    computed.display === "flex" &&
    computed.width === "1px" &&
    computed.height === "1px" &&
    computed.backgroundColor === document.body.style.backgroundColor;
  if (!runtimeStylesApplied) return false;

  for (const link of document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')) {
    // Data saver deliberately permits system fonts. Optional typography must not trap recovery.
    if (link.id === "vorteo-optional-fonts") continue;
    if (link.media && !matchMedia(link.media).matches) continue;
    if (link.dataset.vorteoStyleFailed === "true") return false;
    if (!link.sheet || link.disabled || link.sheet.disabled) return false;
  }
  return true;
}

/** The probe traverses the real RN Web and Unistyles paths, including theme variables. */
export function BootHandoff() {
  useEffect(() => {
    if (!document.getElementById("boot-overlay")) return;
    const root = document.getElementById("root");
    if (root) root.inert = true;
    let frame = 0;
    let readyFrames = 0;
    let finished = false;
    const report = (state: "waiting" | "ready") => {
      window.dispatchEvent(new CustomEvent("vorteo-boot-styles", { detail: state }));
    };
    const check = () => {
      frame = 0;
      if (finished) return;
      if (!stylesApplied()) {
        readyFrames = 0;
        return;
      }
      readyFrames++;
      if (readyFrames < 2) {
        frame = requestAnimationFrame(check);
        return;
      }
      finished = true;
      clearInterval(clock);
      document.removeEventListener("load", onLoad, true);
      report("ready");
      if (root) root.inert = false;
      (window as Window & { __vorteoFinishBoot?: () => void }).__vorteoFinishBoot?.();
    };
    const onLoad = () => {
      if (!frame) frame = requestAnimationFrame(check);
    };
    report("waiting");
    document.addEventListener("load", onLoad, true);
    // CSSOM rule changes need no DOM mutation or load event. Poll only during startup.
    const clock = setInterval(onLoad, 250);
    frame = requestAnimationFrame(check);
    return () => {
      finished = true;
      clearInterval(clock);
      cancelAnimationFrame(frame);
      document.removeEventListener("load", onLoad, true);
    };
  }, []);

  return (
    <div hidden aria-hidden="true">
      <View nativeID={PROBE_ID} style={styles.probe} />
    </div>
  );
}

const styles = StyleSheet.create((theme) => ({
  probe: { width: 1, height: 1, backgroundColor: theme.colors.surface0 },
}));
