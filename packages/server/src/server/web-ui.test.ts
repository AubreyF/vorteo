import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import express from "express";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import pino from "pino";
import { brotliCompressSync, brotliDecompressSync, gzipSync, gunzipSync } from "node:zlib";

import { createWebUiMiddleware } from "./web-ui.js";

const logger = pino({ level: "silent" });

interface ResponseSnapshot {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  rawBody: Buffer;
}

async function readResponseBody(res: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  res.on("data", (chunk: Buffer) => {
    chunks.push(chunk);
  });
  await once(res, "end");
  return Buffer.concat(chunks);
}

async function request(
  app: express.Application,
  method: string,
  requestPath: string,
  headers: Record<string, string> = {},
): Promise<ResponseSnapshot> {
  const server = http.createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Server did not bind to a TCP port");
  }

  try {
    const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: address.port,
          path: requestPath,
          method,
          headers: { host: `localhost:${address.port}`, ...headers },
        },
        resolve,
      );
      req.on("error", reject);
      req.end();
    });

    const body = await readResponseBody(res);
    return {
      status: res.statusCode ?? 0,
      headers: res.headers,
      body: body.toString("utf8"),
      rawBody: body,
    };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function createApp(options: {
  enabled: boolean;
  distDir: string | null;
  publicDir?: string;
  vary?: string;
}): express.Application {
  const app = express();
  if (options.vary) {
    app.use((_req, res, next) => {
      res.setHeader("Vary", options.vary!);
      next();
    });
  }
  app.use(
    createWebUiMiddleware({
      enabled: options.enabled,
      distDir: options.distDir,
      label: "test-label",
      logger,
    }),
  );
  app.get("/api/health", (_req, res) => res.json({ ok: true }));
  app.get("/mcp/agents", (_req, res) => res.json({ mcp: true }));
  if (options.publicDir) {
    app.use("/public", express.static(options.publicDir));
  }
  return app;
}

describe("daemon web UI route module", () => {
  let tempRoot: string;
  let distDir: string;
  let publicDir: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "paseo-web-ui-"));
    distDir = path.join(tempRoot, "dist");
    publicDir = path.join(tempRoot, "public");
    await mkdir(path.join(distDir, "_expo", "static", "js", "web"), { recursive: true });
    await mkdir(publicDir, { recursive: true });

    await writeFile(
      path.join(distDir, "index.html"),
      "<!DOCTYPE html><html><head></head><body>app</body></html>",
    );
    await writeFile(
      path.join(distDir, "_expo", "static", "js", "web", "index-abc123def4567890.js"),
      "console.log('uncompressed');",
    );
    await writeFile(
      path.join(distDir, "_expo", "static", "js", "web", "index-abc123def4567890.js.br"),
      brotliCompressSync("console.log('uncompressed');"),
    );
    await writeFile(
      path.join(distDir, "_expo", "static", "js", "web", "index-abc123def4567890.js.gz"),
      gzipSync("console.log('uncompressed');"),
    );
    // Sealed HTML sidecars do not contain this request's public connection hint.
    await writeFile(path.join(distDir, "index.html.br"), brotliCompressSync("stale sealed HTML"));
    await writeFile(path.join(distDir, "index.html.gz"), gzipSync("stale sealed HTML"));
    await writeFile(path.join(distDir, "styles.css"), "body { color: red; }");
    await writeFile(path.join(publicDir, "asset.txt"), "public asset");
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  test.each(["br", "gzip"])(
    "serves final injected HTML with negotiated %s bytes and no-store caching",
    async (encoding) => {
      const app = createApp({ enabled: true, distDir, publicDir });
      const res = await request(app, "GET", "/", { "accept-encoding": encoding });
      const decoded =
        encoding === "br" ? brotliDecompressSync(res.rawBody) : gunzipSync(res.rawBody);
      expect(res.status).toBe(200);
      expect(res.headers["content-encoding"]).toBe(encoding);
      expect(res.headers.vary).toBe("Accept-Encoding");
      expect(res.headers["content-type"]).toBe("text/html; charset=utf-8");
      expect(Number(res.headers["content-length"])).toBe(res.rawBody.length);
      expect(res.headers["cache-control"]).toBe(
        "no-store, no-cache, must-revalidate, proxy-revalidate",
      );
      expect(decoded.toString()).toContain('"listen":"localhost:');
      expect(decoded.toString()).toContain("window.__PASEO_INITIAL_DAEMON_CONNECTION__");
      expect(decoded.toString()).toContain("<body>app</body>");
    },
  );

  test("HEAD reports the negotiated HTML encoding and length without a body", async () => {
    const app = createApp({ enabled: true, distDir, publicDir });
    const res = await request(app, "HEAD", "/", { "accept-encoding": "br" });
    expect(res.status).toBe(200);
    expect(res.headers["content-encoding"]).toBe("br");
    expect(res.headers.vary).toBe("Accept-Encoding");
    expect(Number(res.headers["content-length"])).toBeGreaterThan(0);
    expect(res.rawBody.length).toBe(0);
  });

  test("static negotiation respects q=0 and retains immutable caching", async () => {
    const app = createApp({ enabled: true, distDir, publicDir });
    const res = await request(app, "GET", "/_expo/static/js/web/index-abc123def4567890.js", {
      "accept-encoding": "br;q=0, gzip;q=1",
    });
    expect(res.status).toBe(200);
    expect(res.headers["content-encoding"]).toBe("gzip");
    expect(res.headers.vary).toBe("Accept-Encoding");
    expect(res.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(gunzipSync(res.rawBody).toString()).toBe("console.log('uncompressed');");
  });

  test("identity HTML varies by encoding and refuses an excluded identity fallback", async () => {
    const app = createApp({ enabled: true, distDir, publicDir });
    const identity = await request(app, "GET", "/");
    expect(identity.headers["content-encoding"]).toBeUndefined();
    expect(identity.headers.vary).toBe("Accept-Encoding");
    const refused = await request(app, "GET", "/", { "accept-encoding": "*;q=0" });
    expect(refused.status).toBe(406);
    expect(refused.headers["content-encoding"]).toBeUndefined();
    expect(refused.rawBody.length).toBe(0);
  });

  test.each(["br", "gzip", "identity"])(
    "HEAD matches the %s GET representation headers without a body",
    async (encoding) => {
      const app = createApp({ enabled: true, distDir });
      // Keep injected bytes identical despite the request helper's ephemeral ports.
      const headers = { host: "fixture.invalid", "accept-encoding": encoding };
      const get = await request(app, "GET", "/", headers);
      const head = await request(app, "HEAD", "/", headers);
      expect(get.status).toBe(200);
      expect(head.status).toBe(get.status);
      const expectedEncoding = encoding === "identity" ? undefined : encoding;
      expect(get.headers["content-encoding"]).toBe(expectedEncoding);
      expect(head.headers["content-encoding"]).toBe(get.headers["content-encoding"]);
      expect(head.headers["content-length"]).toBe(String(get.rawBody.length));
      expect(head.headers["content-length"]).toBe(get.headers["content-length"]);
      expect(head.headers["content-type"]).toBe(get.headers["content-type"]);
      expect(head.headers["cache-control"]).toBe(get.headers["cache-control"]);
      expect(head.headers.vary).toBe(get.headers.vary);
      expect(head.rawBody.length).toBe(0);
    },
  );

  test.each(["GET", "HEAD"])(
    "%s refuses excluded HTML representations without a body",
    async (method) => {
      const app = createApp({ enabled: true, distDir });
      const res = await request(app, method, "/", {
        "accept-encoding": "identity;q=0, br;q=0, gzip;q=0",
      });
      expect(res.status).toBe(406);
      expect(res.headers["content-encoding"]).toBeUndefined();
      expect(res.headers["content-length"]).toBe("0");
      expect(res.headers.vary).toBe("Accept-Encoding");
      expect(res.rawBody.length).toBe(0);
    },
  );

  test.each(["Origin", "*"])(
    "preserves existing Vary %s for all HTML negotiation outcomes",
    async (vary) => {
      const app = createApp({ enabled: true, distDir, vary });
      for (const encoding of ["identity", "gzip", "*;q=0"]) {
        const res = await request(app, "GET", "/", { "accept-encoding": encoding });
        const expectedVary = vary === "*" ? "*" : "Origin, Accept-Encoding";
        expect(res.headers.vary).toBe(expectedVary);
        expect(res.status).toBe(encoding === "*;q=0" ? 406 : 200);
      }
    },
  );

  test("falls back to an available gzip sidecar when preferred Brotli is absent", async () => {
    const payload = "console.log('gzip-only');";
    await writeFile(path.join(distDir, "gzip-only.js"), payload);
    await writeFile(path.join(distDir, "gzip-only.js.gz"), gzipSync(payload));
    const app = createApp({ enabled: true, distDir });
    const res = await request(app, "GET", "/gzip-only.js", {
      "accept-encoding": "br, gzip;q=0.5, identity;q=0",
    });
    expect(res.status).toBe(200);
    expect(res.headers["content-encoding"]).toBe("gzip");
    expect(gunzipSync(res.rawBody).toString()).toBe(payload);
    expect(res.headers.vary).toBe("Accept-Encoding");
    expect(res.headers["cache-control"]).toBe("no-cache");
  });

  test.each(["GET", "HEAD"])(
    "%s refuses static identity when no acceptable sidecar exists",
    async (method) => {
      const app = createApp({ enabled: true, distDir });
      const res = await request(app, method, "/styles.css", {
        "accept-encoding": "br, gzip, identity;q=0",
      });
      expect(res.status).toBe(406);
      expect(res.headers["content-encoding"]).toBeUndefined();
      expect(res.headers.vary).toBe("Accept-Encoding");
      expect(res.rawBody.length).toBe(0);
    },
  );

  test.each([
    ["br;q=0.3, gzip;q=0.8, identity;q=0.1", "gzip"],
    ["br;q=0.8, gzip;q=0.3, identity;q=0.1", "br"],
    ["br;q=0.3, gzip;q=0.8, identity;q=1", "identity"],
  ])(
    "selects the highest-quality available static representation for %s",
    async (acceptEncoding, encoding) => {
      const app = createApp({ enabled: true, distDir });
      const res = await request(app, "GET", "/_expo/static/js/web/index-abc123def4567890.js", {
        "accept-encoding": acceptEncoding,
      });
      expect(res.status).toBe(200);
      const expectedEncoding = encoding === "identity" ? undefined : encoding;
      expect(res.headers["content-encoding"]).toBe(expectedEncoding);
      let decoded = res.rawBody;
      if (encoding === "br") decoded = brotliDecompressSync(decoded);
      if (encoding === "gzip") decoded = gunzipSync(decoded);
      expect(decoded.toString()).toBe("console.log('uncompressed');");
      expect(res.headers.vary).toBe("Accept-Encoding");
      expect(res.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    },
  );

  test("returns 404 when web UI is disabled", async () => {
    const app = createApp({ enabled: false, distDir, publicDir });

    const res = await request(app, "GET", "/");

    expect(res.status).toBe(404);
    expect(res.body).toBe("");
  });

  test("returns 404 when dist directory is missing", async () => {
    const app = createApp({ enabled: true, distDir: path.join(tempRoot, "missing"), publicDir });

    const res = await request(app, "GET", "/");

    expect(res.status).toBe(404);
  });

  test("serves index.html with injected initial connection hint", async () => {
    const app = createApp({ enabled: true, distDir, publicDir });

    const res = await request(app, "GET", "/");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(res.body).toContain("window.__PASEO_INITIAL_DAEMON_CONNECTION__");
    expect(res.body).toContain('"listen":"localhost:');
    expect(res.body).toContain('"useTls":false');
    expect(res.body).toContain('"label":"test-label"');
  });

  test("injects hint before closing head tag", async () => {
    const app = createApp({ enabled: true, distDir, publicDir });

    const res = await request(app, "GET", "/index.html");

    expect(res.body).toMatch(/window\.__PASEO_INITIAL_DAEMON_CONNECTION__.*<\/head>/);
  });

  test("escapes the injected host hint for inline script safety", async () => {
    const app = createApp({ enabled: true, distDir, publicDir });

    const res = await request(app, "GET", "/", {
      host: "evil.test</script><script>alert(1)</script>",
    });

    expect(res.status).toBe(200);
    expect(res.body).toContain("evil.test\\u003C/script\\u003E");
    expect(res.body).not.toContain("evil.test</script>");
  });

  test("falls back to index.html for SPA deep links", async () => {
    const app = createApp({ enabled: true, distDir, publicDir });

    const res = await request(app, "GET", "/h/some-server-id/agent/123");

    expect(res.status).toBe(200);
    expect(res.body).toContain("window.__PASEO_INITIAL_DAEMON_CONNECTION__");
    expect(res.body).toContain("app");
  });

  test("serves static assets", async () => {
    const app = createApp({ enabled: true, distDir, publicDir });

    const res = await request(app, "GET", "/styles.css");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("text/css; charset=utf-8");
    expect(res.body).toBe("body { color: red; }");
  });

  test("selects brotli precompressed asset when accepted", async () => {
    const app = createApp({ enabled: true, distDir, publicDir });

    const res = await request(app, "GET", "/_expo/static/js/web/index-abc123def4567890.js", {
      "accept-encoding": "br, gzip",
    });

    expect(res.status).toBe(200);
    expect(res.headers["content-encoding"]).toBe("br");
    expect(res.headers["vary"]).toBe("Accept-Encoding");
    expect(brotliDecompressSync(res.rawBody).toString()).toBe("console.log('uncompressed');");
  });

  test("selects gzip precompressed asset when brotli is not accepted", async () => {
    const app = createApp({ enabled: true, distDir, publicDir });

    const res = await request(app, "GET", "/_expo/static/js/web/index-abc123def4567890.js", {
      "accept-encoding": "gzip",
    });

    expect(res.status).toBe(200);
    expect(res.headers["content-encoding"]).toBe("gzip");
    expect(gunzipSync(res.rawBody).toString()).toBe("console.log('uncompressed');");
  });

  test("falls back to uncompressed asset when no encoding is accepted", async () => {
    const app = createApp({ enabled: true, distDir, publicDir });

    const res = await request(app, "GET", "/_expo/static/js/web/index-abc123def4567890.js");

    expect(res.status).toBe(200);
    expect(res.headers["content-encoding"]).toBeUndefined();
    expect(res.body).toBe("console.log('uncompressed');");
  });

  test("does not catch /api/* paths", async () => {
    const app = createApp({ enabled: true, distDir, publicDir });

    const res = await request(app, "GET", "/api/health");

    expect(res.status).toBe(200);
    expect(res.body).toBe('{"ok":true}');
  });

  test("does not catch /mcp/* paths", async () => {
    const app = createApp({ enabled: true, distDir, publicDir });

    const res = await request(app, "GET", "/mcp/agents");

    expect(res.status).toBe(200);
    expect(res.body).toBe('{"mcp":true}');
  });

  test("does not catch /public/* paths", async () => {
    const app = createApp({ enabled: true, distDir, publicDir });

    const res = await request(app, "GET", "/public/asset.txt");

    expect(res.status).toBe(200);
    expect(res.body).toBe("public asset");
  });

  test("sets no-cache headers for index.html", async () => {
    const app = createApp({ enabled: true, distDir, publicDir });

    const res = await request(app, "GET", "/");

    expect(res.headers["cache-control"]).toBe(
      "no-store, no-cache, must-revalidate, proxy-revalidate",
    );
  });

  test("sets immutable caching for hashed assets", async () => {
    const app = createApp({ enabled: true, distDir, publicDir });

    const res = await request(app, "GET", "/_expo/static/js/web/index-abc123def4567890.js");

    expect(res.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
  });

  test("sets no-cache for unhashed static assets", async () => {
    const app = createApp({ enabled: true, distDir, publicDir });

    const res = await request(app, "GET", "/styles.css");

    expect(res.headers["cache-control"]).toBe("no-cache");
  });

  test("only handles GET and HEAD requests", async () => {
    const app = createApp({ enabled: true, distDir, publicDir });
    app.post("/", (_req, res) => res.json({ posted: true }));

    const res = await request(app, "POST", "/");

    expect(res.status).toBe(200);
    expect(res.body).toBe('{"posted":true}');
  });

  test("responds to HEAD without a body", async () => {
    const app = createApp({ enabled: true, distDir, publicDir });

    const res = await request(app, "HEAD", "/");

    expect(res.status).toBe(200);
    expect(res.body).toBe("");
  });
});
