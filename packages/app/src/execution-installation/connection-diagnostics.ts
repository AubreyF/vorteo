import { isWeb } from "@/constants/platform";
import {
  checkInstallationConnection,
  connectionEndpointLabel,
  type ConnectionCheckResult,
  type ConnectionCheckTarget,
  type ConnectionSession,
} from "./connection-check";

export interface DiagnosticProbe {
  state: "passed" | "failed" | "unknown";
  detail: string;
  elapsedMs: number;
}
export interface ConnectionDiagnostic extends ConnectionCheckResult {
  session: ConnectionSession | null;
  socket: DiagnosticProbe | null;
  crossOrigin: DiagnosticProbe | null;
  policy: string[];
}
export interface DeviceDiagnostic {
  online: boolean | null;
  secureContext: boolean | null;
  origin: string | null;
  browser: string | null;
  localNetworkPermission: string;
}

/** Query only. This cannot read or change macOS permissions or Tailscale settings. */
export async function inspectConnectionDevice(): Promise<DeviceDiagnostic> {
  if (!isWeb)
    return {
      online: null,
      secureContext: null,
      origin: null,
      browser: null,
      localNetworkPermission: "Not exposed on this platform",
    };
  return {
    online: navigator.onLine,
    secureContext: window.isSecureContext,
    origin: window.location.origin,
    browser: navigator.userAgent.slice(0, 300),
    localNetworkPermission: await localNetworkPermission(),
  };
}
async function localNetworkPermission(): Promise<string> {
  if (!navigator.permissions) return "Not exposed by this browser";
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const permission = await Promise.race([
      navigator.permissions.query({ name: "local-network-access" as PermissionName }),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), 1000);
      }),
    ]);
    return permission?.state ?? "Permission query timed out";
  } catch {
    return "Not exposed by this browser";
  } finally {
    clearTimeout(timer);
  }
}

/** No credentials, messages, retries or daemon mutations. A socket handshake is transport proof only. */
export function probeDiagnosticSocket(
  url: string,
  signal?: AbortSignal,
  timeoutMs = 5000,
): Promise<DiagnosticProbe> {
  return new Promise((resolve) => startSocketProbe(url, signal, timeoutMs, resolve));
}
function startSocketProbe(
  url: string,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  resolve: (result: DiagnosticProbe) => void,
): void {
  const start = Date.now();
  let socket: WebSocket | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let done = false;
  const finish = (state: DiagnosticProbe["state"], detail: string) => {
    if (done) return false;
    done = true;
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
    if (socket) {
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("error", onError);
      socket.removeEventListener("close", onClose);
      socket.close();
    }
    resolve({ state, detail, elapsedMs: Date.now() - start });
    return true;
  };
  const onOpen = () => {
    finish("passed", "WebSocket handshake accepted; authentication not tested by this probe");
  };
  const onError = () => {
    finish(
      "failed",
      "WebSocket handshake failed; browser hides the network or server rejection reason",
    );
  };
  const onClose = (event: CloseEvent) => {
    finish("failed", `WebSocket closed before opening (code ${event.code})`);
  };
  const cancel = () => {
    finish("unknown", "Check cancelled");
  };
  if (signal?.aborted) {
    cancel();
    return;
  }
  signal?.addEventListener("abort", cancel, { once: true });
  timer = setTimeout(() => finish("failed", "WebSocket handshake timed out"), timeoutMs);
  try {
    socket = new WebSocket(url);
    socket.addEventListener("open", onOpen);
    socket.addEventListener("error", onError);
    socket.addEventListener("close", onClose);
  } catch {
    finish("failed", "Browser refused to create the WebSocket connection");
  }
}

async function probeOpaqueResponse(url: string, signal?: AbortSignal): Promise<DiagnosticProbe> {
  const start = Date.now();
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) controller.abort();
  const timer = setTimeout(cancel, 4000);
  try {
    await fetch(url, {
      mode: "no-cors",
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      signal: controller.signal,
    });
    return {
      state: "passed",
      detail:
        "Response received without cross-origin read access; HTTP status and health remain unverified",
      elapsedMs: Date.now() - start,
    };
  } catch {
    return {
      state: "unknown",
      detail:
        "No response exposed even without cross-origin read access; DNS, TLS, routing and device policy remain indistinguishable",
      elapsedMs: Date.now() - start,
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  }
}

export async function diagnoseConnection(
  target: ConnectionCheckTarget,
  sessionFor: (serverId: string) => ConnectionSession,
  signal: AbortSignal,
): Promise<ConnectionDiagnostic> {
  const policy = new Set<string>();
  // Policy events can identify CSP blocks that fetch deliberately reduces to TypeError.
  const listener = (event: SecurityPolicyViolationEvent) => {
    if (event.disposition !== "enforce") return;
    if (
      event.blockedURI === new URL(target.url).origin ||
      event.blockedURI === target.url ||
      event.blockedURI === socketUrl(target.url)
    )
      policy.add(event.effectiveDirective);
  };
  if (isWeb) window.addEventListener("securitypolicyviolation", listener);
  try {
    const [health, socket] = await Promise.all([
      checkInstallationConnection(target, { signal }),
      target.serverId
        ? probeDiagnosticSocket(socketUrl(target.url), signal)
        : Promise.resolve(null),
    ]);
    const crossOrigin =
      isWeb && health.failure === "network" && new URL(target.url).origin !== window.location.origin
        ? await probeOpaqueResponse(target.url, signal)
        : null;
    return {
      ...health,
      socket,
      crossOrigin,
      policy: [...policy],
      session: target.serverId ? sessionFor(target.serverId) : null,
    };
  } finally {
    if (isWeb) window.removeEventListener("securitypolicyviolation", listener);
  }
}
function socketUrl(url: string): string {
  const parsed = new URL("/ws", url);
  parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
  return parsed.href;
}

export function connectionDiagnosis(result: ConnectionDiagnostic): string {
  if (result.policy.length)
    return `Browser content policy blocked this connection (${result.policy.join(", ")}).`;
  if (result.session?.authentication === "incorrect_password")
    return "The app rejected its saved password. Endpoint transport results below are independent of that rejection.";
  if (result.session?.state === "online")
    return "The authenticated app connection was online when sampled.";
  if (
    result.session?.endpoint &&
    connectionEndpointLabel(result.session.endpoint) !== new URL(result.target.url).host
  )
    return "The saved app address differs from the installation address. Reconnect through Installation controls to refresh the saved connection.";
  if (result.state === "reachable" && result.socket?.state === "failed")
    return "Health HTTP works, but WebSocket transport failed. Check proxy WebSocket routing and the server's allowed origin.";
  if (result.crossOrigin?.state === "passed")
    return "A response arrived, but the health request could not read it. Cross-origin read policy or a blocked redirect needs investigation; this is not proof of healthy service.";
  if (result.state === "failed" && result.socket?.state === "passed")
    return "WebSocket transport works while HTTP health fails. Investigate HTTP routing or browser cross-origin access; the private service is reachable by WebSocket.";
  if (result.failure === "network" || result.failure === "timeout")
    return "This device could not establish usable access. The browser does not expose enough evidence to distinguish DNS, certificate, VPN routing or device permissions. No single cause is confirmed.";
  if (result.state === "reachable")
    return "The health endpoint is reachable. App authentication and expected server identity are checked by the app connection separately.";
  return result.detail;
}

/** Allowlisted report: never include credentials, storage, query strings or server response bodies. */
export function connectionDiagnosticReport(
  device: DeviceDiagnostic | null,
  results: ConnectionDiagnostic[],
  build: string | null,
): string {
  return JSON.stringify(
    {
      format: "vorteo-connection-diagnostics-v1",
      build,
      device,
      results: results.map((result) => ({
        target: result.target.label,
        address: new URL(result.target.url).origin,
        checkedAt: result.checkedAt,
        elapsedMs: result.elapsedMs,
        health: {
          state: result.state,
          detail: result.detail,
          httpStatus: result.httpStatus,
          failure: result.failure,
        },
        websocket: result.socket,
        crossOrigin: result.crossOrigin,
        contentPolicy: result.policy,
        app: result.session
          ? {
              state: result.session.state,
              authentication: result.session.authentication,
              address: connectionEndpointLabel(result.session.endpoint),
            }
          : null,
        diagnosis: connectionDiagnosis(result),
      })),
    },
    null,
    2,
  );
}
