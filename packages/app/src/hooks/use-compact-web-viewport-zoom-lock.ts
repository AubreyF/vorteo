import { useEffect } from "react";
import { isWeb } from "@/constants/platform";

// The interface zoom control owns scaling. Browser pinch zoom crops the
// toolbars without reflowing them, so the viewport stays at 1x.
const LOCKED_WEB_VIEWPORT_CONTENT =
  "width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover";

// iOS Safari ignores user-scalable=no; cancelling its gesture events blocks pinch.
// Multi-touch pointer handlers, such as the image lightbox, are unaffected.
function preventPageGesture(event: Event) {
  event.preventDefault();
}
const GESTURE_EVENTS = ["gesturestart", "gesturechange", "gestureend"] as const;

export function useCompactWebViewportZoomLock() {
  useEffect(() => {
    if (!isWeb) {
      return;
    }

    const viewportMeta =
      document.querySelector<HTMLMetaElement>('meta[name="viewport"]') ??
      document.createElement("meta");
    const hadViewportMeta = viewportMeta.parentElement !== null;
    const previousContent = viewportMeta.getAttribute("content");

    if (!hadViewportMeta) {
      viewportMeta.name = "viewport";
      document.head.appendChild(viewportMeta);
    }

    viewportMeta.setAttribute("content", LOCKED_WEB_VIEWPORT_CONTENT);
    for (const name of GESTURE_EVENTS) {
      document.addEventListener(name, preventPageGesture, { passive: false });
    }

    return () => {
      for (const name of GESTURE_EVENTS) {
        document.removeEventListener(name, preventPageGesture);
      }
      if (!hadViewportMeta) {
        viewportMeta.remove();
        return;
      }
      if (previousContent !== null) {
        viewportMeta.setAttribute("content", previousContent);
      }
    };
  }, []);
}
