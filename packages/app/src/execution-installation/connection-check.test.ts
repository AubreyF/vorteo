import { createServer, type Server } from "node:http";
import { afterEach, expect, test } from "vitest";
import {
  checkInstallationConnection,
  connectionEndpointLabel,
  connectionSessionDescription,
} from "./connection-check";

import {
  connectionDiagnosis,
  connectionDiagnosticReport,
  type ConnectionDiagnostic,
} from "./connection-diagnostics";

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
async function fixture(status: number, body: string, delay = 0) {
  const seen: Array<{
    url: string | undefined;
    authorization: string | undefined;
    cookie: string | undefined;
  }> = [];
  const server = createServer((request, response) => {
    seen.push({
      url: request.url,
      authorization: request.headers.authorization,
      cookie: request.headers.cookie,
    });
    setTimeout(() => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(body);
    }, delay);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test address");
  return { url: `http://127.0.0.1:${address.port}/api/health`, seen };
}

test("health checks use real read-only HTTP without app credentials", async () => {
  const f = await fixture(200, JSON.stringify({ status: "ok" }));
  const result = await checkInstallationConnection({ id: "host", label: "Host", url: f.url });
  expect(result.state).toBe("reachable");
  expect(f.seen).toEqual([{ url: "/api/health", authorization: undefined, cookie: undefined }]);
});

test("installation health verifies the exact installation identity", async () => {
  const f = await fixture(200, JSON.stringify({ installationId: "other-installation" }));
  const result = await checkInstallationConnection({
    id: "installation",
    label: "Installation",
    url: f.url,
    installationId: "expected-installation",
  });
  expect(result.state).toBe("failed");
  expect(result.detail).toContain("different");
});

test.each([
  [503, '{"status":"ok"}', "HTTP 503"],
  [200, "<html>Not health</html>", "did not return health"],
  [200, '{"status":"degraded"}', "did not report a healthy"],
] as const)("health rejects unusable HTTP responses %s", async (status, body, detail) => {
  const f = await fixture(status, body);
  const result = await checkInstallationConnection({ id: "container", label: "Dev", url: f.url });
  expect(result.state).toBe("failed");
  expect(result.detail).toContain(detail);
});

test("a stalled endpoint times out instead of leaving the check running", async () => {
  const f = await fixture(200, '{"status":"ok"}', 200);
  const result = await checkInstallationConnection(
    { id: "host", label: "Host", url: f.url },
    { timeoutMs: 20 },
  );
  expect(result.state).toBe("failed");
  expect(result.detail).toContain("No health response");
});

test("network reachability never conceals rejected authentication or missing client startup", () => {
  expect(
    connectionSessionDescription({
      state: "offline",
      authentication: "incorrect_password",
      endpoint: null,
    }),
  ).toContain("saved password was rejected");
  expect(connectionSessionDescription(null)).toContain("not initialized");
  expect(connectionEndpointLabel("wss://user:secret@host.example:44445/socket?token=private")).toBe(
    "host.example:44445",
  );
});

function diagnostic(): ConnectionDiagnostic {
  return {
    target: { id: "host", label: "Host", url: "https://private.example:44445/api/health" },
    state: "failed",
    failure: "network",
    detail: "Browser withheld error details",
    elapsedMs: 3,
    checkedAt: "2026-10-15T20:00:00.000Z",
    socket: { state: "failed", detail: "Handshake failed", elapsedMs: 2 },
    crossOrigin: null,
    policy: [],
    session: null,
  };
}
test("a generic network rejection never becomes a fabricated permission diagnosis", () => {
  expect(connectionDiagnosis(diagnostic())).toContain("No single cause is confirmed");
  const crossOrigin = {
    ...diagnostic(),
    crossOrigin: { state: "passed" as const, detail: "Opaque response", elapsedMs: 2 },
  };
  expect(connectionDiagnosis(crossOrigin)).toContain("Cross-origin read policy");
  expect(connectionDiagnosis({ ...diagnostic(), policy: ["connect-src"] })).toContain(
    "content policy blocked",
  );
});
test("the diagnostic report excludes credentials, query strings and unknown session fields", () => {
  const result = diagnostic();
  result.target.url = "https://user:secret@private.example:44445/api/health?token=hidden";
  result.session = {
    state: "connecting",
    authentication: null,
    endpoint: "wss://user:secret@private.example:44445/ws?token=hidden",
  };
  Object.assign(result.session, { password: "also-secret" });
  const report = connectionDiagnosticReport(null, [result], null);
  expect(report).not.toContain("secret");
  expect(report).not.toContain("hidden");
  expect(report).not.toContain("token=");
  expect(JSON.parse(report).results[0].app.address).toBe("private.example:44445");
});
