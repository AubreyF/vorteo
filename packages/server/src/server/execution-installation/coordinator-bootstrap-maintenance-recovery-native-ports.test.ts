import { createServer } from "node:http";
import { once } from "node:events";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, readFileSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { test, expect, afterEach } from "vitest";
import { BootstrapProcessIdentitySchema } from "@getpaseo/protocol/coordinator-bootstrap";
import {
  maintenanceRecoveryDocument,
  maintenanceRecoveryScript,
} from "./coordinator-bootstrap-maintenance-recovery-page.js";
import {
  assertNativeRecoveryPortAvailable,
  inspectNativeRecoveryListener,
  retainNativeRecoveryProcess,
  inspectNativeRecoveryRouting,
} from "./coordinator-bootstrap-maintenance-recovery-native-ports.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test.skipIf(process.platform !== "darwin")(
  "recovery registration refuses an occupied loopback port without disturbing its listener",
  async () => {
    const server = createServer((_request, response) => response.end("fixture"));
    const listening = once(server, "listening");
    server.listen(0, "127.0.0.1");
    await listening;
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture socket unavailable");
    try {
      expect(() => assertNativeRecoveryPortAvailable(address.port)).toThrow();
      expect(server.listening).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        }),
      );
    }
    expect(() => assertNativeRecoveryPortAvailable(address.port)).not.toThrow();
  },
);

test.each([0, 1023, 65536, 1.5, NaN])("recovery port validation rejects %s", (port) => {
  expect(() => assertNativeRecoveryPortAvailable(port)).toThrow();
});

function nativeFixture() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "recovery-native-port-")));
  roots.push(root);
  const helper = readFileSync(path.resolve("scripts/inspect-coordinator-process.py"));
  const helperPath = path.join(root, "inspector.py");
  writeFileSync(helperPath, helper, { mode: 0o600 });
  const observed = BootstrapProcessIdentitySchema.parse(
    JSON.parse(
      execFileSync(
        "/usr/bin/python3",
        ["-I", "-B", "-c", helper.toString("utf8"), String(process.pid)],
        { env: { PATH: "/usr/bin:/bin" }, encoding: "utf8", timeout: 2000, maxBuffer: 1024 * 1024 },
      ),
    ),
  );
  return {
    root,
    helperPath,
    helperSha256: createHash("sha256").update(helper).digest("hex"),
    process: observed,
    writableMountRoots: [],
  };
}

test.skipIf(process.platform !== "darwin").each(["valid", "birth", "owner", "helper"])(
  "read-only native recovery process custody: %s",
  async (mode) => {
    const f = nativeFixture();
    if (mode === "birth") f.process.startIdentity += "-changed";
    if (mode === "owner") f.process.uid++;
    if (mode === "birth" || mode === "owner") {
      await expect(retainNativeRecoveryProcess(f)).rejects.toThrow();
      return;
    }
    const custody = await retainNativeRecoveryProcess(f);
    custody.assertCurrent();
    if (mode === "helper") {
      writeFileSync(f.helperPath, "changed protected helper");
      expect(custody.assertCurrent).toThrow();
    }
  },
);

test
  .skipIf(process.platform !== "darwin")
  .each([
    "valid",
    "document",
    "script",
    "modified-document",
    "modified-script",
    "media-type",
    "oversized",
    "redirect",
    "hanging",
  ])(
  "read-only native recovery socket and HTTP assets: %s",
  async (mode) => {
    const f = nativeFixture();
    const origin = "https://recovery.example.test:9443";
    const server = createServer((request, response) => {
      if (request.headers.host !== new URL(origin).host) {
        response.writeHead(403).end();
        return;
      }
      if (mode === "hanging") return;
      if (mode === "redirect") {
        response.writeHead(302, { Location: "/other" }).end();
        return;
      }
      const script = request.url === "/recovery.js";
      response.setHeader("Content-Type", script ? "application/javascript" : "text/html");
      if (mode === "media-type" && script) response.setHeader("Content-Type", "application/json");
      if (mode === "oversized") {
        response.end("a".repeat(17 * 1024));
        return;
      }
      if (mode === "document" && !script) {
        response.end("<html>Unusable page</html>");
        return;
      }
      if (mode === "script" && script) {
        response.end("");
        return;
      }
      if (mode === "modified-document" && !script) {
        response.end(
          maintenanceRecoveryDocument.replace("Bookmark this page.", "Unreviewed page."),
        );
        return;
      }
      if (mode === "modified-script" && script) {
        response.end(maintenanceRecoveryScript + "\nfetch('/unreviewed');");
        return;
      }
      response.end(script ? maintenanceRecoveryScript : maintenanceRecoveryDocument);
    });
    const listening = once(server, "listening");
    server.listen(0, "127.0.0.1");
    await listening;
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture socket unavailable");
    try {
      const observation = inspectNativeRecoveryListener({ ...f, origin, listenPort: address.port });
      if (mode !== "valid") {
        await expect(observation).rejects.toThrow();
        return;
      }
      const custody = await observation;
      custody.assertCurrent();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        }),
      );
      expect(custody.assertCurrent).toThrow();
    } finally {
      server.closeAllConnections();
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
  10_000,
);

test
  .skipIf(process.platform !== "darwin")
  .each(["valid", "routing", "machine", "peers", "cli", "writable"])(
  "native routing custody with an isolated CLI fixture: %s",
  async (mode) => {
    const f = nativeFixture();
    const stateFile = path.join(f.root, "fixture.json");
    const serveFile = path.join(f.root, "serve.json");
    const state = {
      BackendState: "Running",
      Self: { DNSName: "machine.tail123.ts.net." },
      Peers: 1,
      serve: { TCP: { "44444": { HTTPS: true } } },
    };
    writeFileSync(stateFile, JSON.stringify(state), { mode: 0o600 });
    writeFileSync(serveFile, JSON.stringify(state.serve), { mode: 0o600 });
    const cli = path.join(f.root, "tailscale-fixture");
    const quote = (file: string) => "'" + file.replaceAll("'", "'\\''") + "'";
    const source = `#!/usr/bin/env bash\n[ "$TAILSCALE_BE_CLI" = 1 ] || exit 1\nif [ "$1" = serve ]; then exec /bin/cat ${quote(serveFile)}; fi\nexec /bin/cat ${quote(stateFile)}\n`;
    writeFileSync(cli, source, { mode: 0o700 });
    const input = {
      tailscale: { path: cli, sha256: createHash("sha256").update(source).digest("hex") },
      writableMountRoots: [],
    };
    if (mode === "writable") {
      chmodSync(cli, 0o722);
      await expect(inspectNativeRecoveryRouting(input)).rejects.toThrow();
      return;
    }
    const custody = await inspectNativeRecoveryRouting(input);
    if (mode === "routing") state.serve.TCP["44444"].HTTPS = false;
    if (mode === "machine") state.Self.DNSName = "another.tail123.ts.net.";
    if (mode === "peers") state.Peers++;
    if (mode === "cli") writeFileSync(cli, source + "\n");
    writeFileSync(stateFile, JSON.stringify(state));
    writeFileSync(serveFile, JSON.stringify(state.serve));
    if (["routing", "machine", "cli"].includes(mode)) expect(custody.assertCurrent).toThrow();
    else custody.assertCurrent();
  },
);
