import type { ExecutionInstallation } from "@getpaseo/protocol/execution-installation";

export interface ConnectionCheckTarget {
  id: "installation" | "host" | "container";
  label: string;
  url: string;
  installationId?: string;
  serverId?: string;
}
export interface ConnectionCheckResult {
  target: ConnectionCheckTarget;
  state: "reachable" | "failed";
  detail: string;
  checkedAt: string;
  elapsedMs: number;
  httpStatus?: number;
  failure?: "http" | "response" | "network" | "timeout" | "cancelled";
}
export interface ConnectionSession {
  state: "online" | "offline" | "connecting" | "uninitialized" | "idle" | "error";
  authentication: "password_required" | "incorrect_password" | null;
  directory?: "ready" | "loading" | "failed" | "unknown";
  endpoint: string | null;
}

export function installationConnectionTargets(
  installation: ExecutionInstallation,
): ConnectionCheckTarget[] {
  return [
    {
      id: "installation",
      label: "Installation",
      url: new URL("/api/installation/health", installation.origin).href,
      installationId: installation.installationId,
    },
    ...installation.environments.map((environment) => ({
      id: environment.kind,
      label: environment.kind === "host" ? "Host" : "Dev",
      url: new URL(
        "/api/health",
        `${environment.useTls ? "https" : "http"}://${environment.endpoint}`,
      ).href,
      serverId: environment.serverId,
    })),
  ];
}

/** Read-only browser requests: never send installation or daemon credentials. */
export async function checkInstallationConnection(
  target: ConnectionCheckTarget,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<ConnectionCheckResult> {
  const start = Date.now();
  const timeoutMs = options.timeoutMs ?? 8000;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) controller.abort();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const result = (
    state: ConnectionCheckResult["state"],
    detail: string,
    extra: Pick<ConnectionCheckResult, "failure" | "httpStatus"> = {},
  ): ConnectionCheckResult => ({
    target,
    state,
    detail,
    checkedAt: new Date().toISOString(),
    elapsedMs: Date.now() - start,
    ...extra,
  });
  try {
    const response = await fetch(target.url, {
      signal: controller.signal,
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
    });
    if (!response.ok)
      return result("failed", `Health check returned HTTP ${response.status}.`, {
        failure: "http",
        httpStatus: response.status,
      });
    const text = await response.text();
    const failure = healthResponseFailure(text, target);
    if (failure)
      return result("failed", failure, { failure: "response", httpStatus: response.status });
    return result("reachable", "This device reached the health endpoint.", {
      httpStatus: response.status,
    });
  } catch {
    if (timedOut)
      return result("failed", `No health response within ${timeoutMs / 1000} seconds.`, {
        failure: "timeout",
      });
    if (options.signal?.aborted)
      return result("failed", "Check cancelled.", { failure: "cancelled" });
    return result(
      "failed",
      "This device could not reach or read the health endpoint. The browser withheld the network error details.",
      { failure: "network" },
    );
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
  }
}

function healthResponseFailure(text: string, target: ConnectionCheckTarget): string | null {
  if (text.length > 4096) return "Health response was larger than expected.";
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return "The address responded, but did not return health information.";
  }
  if (typeof body !== "object" || body === null) return "Health response was not valid.";
  if (target.id === "installation") {
    if (!("installationId" in body) || body.installationId !== target.installationId)
      return "This address belongs to a different or unrecognized installation.";
  } else if (!("status" in body) || body.status !== "ok")
    return "The service did not report a healthy response.";
  return null;
}

export function connectionSessionDescription(session: ConnectionSession | null): string {
  if (!session || session.state === "uninitialized" || session.state === "idle")
    return "App connection has not initialized.";
  if (session.authentication === "incorrect_password")
    return "The saved password was rejected. Reconnect using Installation controls.";
  if (session.authentication === "password_required")
    return "The app connection needs authentication. Connect using Installation controls.";
  if (session.state === "online") return "Authenticated app connection is online.";
  if (session.state === "connecting") return "The app connection is still connecting.";
  return "The app connection is offline. A reachable health endpoint does not verify its saved credentials or server identity.";
}

export function connectionReadinessDescription(session: ConnectionSession | null): string {
  if (session?.state !== "online") return "Session readiness: unknown until the app connects.";
  switch (session.directory) {
    case "ready":
      return "Thread directory: ready. Selected workspace readiness is not measured by this check.";
    case "loading":
      return "Thread directory: loading. Transport and authentication have already connected.";
    case "failed":
      return "Thread directory: failed to load. Retry the connection check, then reload if needed.";
    default:
      return "Thread directory: unknown. An authenticated connection alone does not prove workspace readiness.";
  }
}

export function connectionEndpointLabel(endpoint: string | null | undefined): string | null {
  if (!endpoint) return null;
  try {
    const parsed = new URL(endpoint.includes("://") ? endpoint : `https://${endpoint}`);
    return parsed.host || null;
  } catch {
    return null;
  }
}
