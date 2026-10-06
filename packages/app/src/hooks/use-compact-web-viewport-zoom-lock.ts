import { useEffect } from "react";
import { isWeb } from "@/constants/platform";

const DEFAULT_WEB_VIEWPORT_CONTENT = "width=device-width, initial-scale=1, viewport-fit=cover";

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

    viewportMeta.setAttribute("content", DEFAULT_WEB_VIEWPORT_CONTENT);

    return () => {
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
