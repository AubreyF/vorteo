import { useCallback, useEffect, useRef, useState } from "react";
import type { DiagramColorScheme, MermaidRenderRequest } from "./render-model";
import { parseMermaidRuntimeMessage, type MermaidRuntimeRenderMessage } from "./runtime/messages";
import { MermaidRuntimeRequestDriver } from "./runtime/request-driver";

export interface MermaidRenderedMessage {
  revision: number;
  source: string;
  colorScheme: DiagramColorScheme;
  height: number;
  width: number;
}

interface MermaidIframeRuntimeProps {
  enabled?: boolean;
  request: MermaidRenderRequest | null;
  onRendered: (message: MermaidRenderedMessage) => void;
  onRenderFailed: (revision: number) => void;
}

/** Sandboxed Mermaid renderer. Sizing and gestures belong to the surrounding viewport. */
export function MermaidIframeRuntime({
  enabled = true,
  request,
  onRendered,
  onRenderFailed,
}: MermaidIframeRuntimeProps) {
  const [runtimeHtml, setRuntimeHtml] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    // Keep the embedded renderer out of the startup bundle. The host shows source
    // until the renderer is ready, including while this chunk is downloading.
    void import("./runtime/html.gen").then(
      ({ mermaidRuntimeHtml }) => {
        if (!cancelled) setRuntimeHtml(mermaidRuntimeHtml);
        return undefined;
      },
      () => {
        if (!cancelled) setLoadFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [enabled]);
  useEffect(() => {
    if (loadFailed && request) onRenderFailed(request.revision);
  }, [loadFailed, request, onRenderFailed]);

  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const driverRef = useRef<MermaidRuntimeRequestDriver | null>(null);
  driverRef.current ??= new MermaidRuntimeRequestDriver();

  const sendRequest = useCallback((current: MermaidRenderRequest | null) => {
    const target = iframeRef.current?.contentWindow;
    if (!current || !target) return;
    const message: MermaidRuntimeRenderMessage = {
      type: "render",
      revision: current.revision,
      source: current.source,
      colorScheme: current.colorScheme,
      interactive: false,
    };
    target.postMessage(message, "*");
  }, []);

  useEffect(() => {
    sendRequest(driverRef.current?.update(request) ?? null);
  }, [request, sendRequest]);

  useEffect(() => {
    function receiveMessage(event: MessageEvent): void {
      if (event.source !== iframeRef.current?.contentWindow) return;
      const message = parseMermaidRuntimeMessage(event.data);
      if (!message) return;
      if (message.type === "bridgeReady") {
        sendRequest(driverRef.current?.ready() ?? null);
        return;
      }
      if (message.type === "renderError") {
        onRenderFailed(message.revision);
        sendRequest(driverRef.current?.settled(message.revision, false) ?? null);
        return;
      }
      onRendered(message);
      sendRequest(driverRef.current?.settled(message.revision, true) ?? null);
    }
    window.addEventListener("message", receiveMessage);
    return () => window.removeEventListener("message", receiveMessage);
  }, [onRenderFailed, onRendered, sendRequest]);

  // `inert` (not just tabIndex) because the Modal focus trap focuses descendants
  // programmatically; a focused iframe swallows every keystroke, including Escape.
  if (!enabled || runtimeHtml === null) return null;

  return (
    <iframe
      ref={iframeRef}
      title=""
      aria-hidden
      inert
      sandbox="allow-scripts"
      srcDoc={runtimeHtml}
      tabIndex={-1}
      style={iframeStyle}
    />
  );
}

const iframeStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  height: "100%",
  border: 0,
  pointerEvents: "none",
  background: "transparent",
};
