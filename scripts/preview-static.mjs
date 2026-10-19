#!/usr/bin/env node
// A sealed UI export can be reviewed without starting another agent daemon.
import { createServer } from "node:http";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import { manifestName } from "./instance-web-artifact.mjs";

const { values } = parseArgs({ options: { directory: { type: "string" } } });
if (!values.directory) throw new Error("Supply --directory with a sealed preview export");
const root = await realpath(values.directory);
const manifest = JSON.parse(await readFile(path.join(root, manifestName), "utf8"));
if (manifest.deployment) throw new Error("Use a preview-only export");
const origin = new URL(process.env.PASEO_PREVIEW_ORIGIN);
if (origin.protocol !== "https:" || !origin.hostname.endsWith(".ts.net"))
  throw new Error("Managed private HTTPS origin required");
const port = Number(process.env.PASEO_PORT);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PASEO_PORT required");
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
};
const assets = new Map();
for (const [name, hash] of Object.entries(manifest.files)) {
  if (name.split("/").some((part) => part.startsWith(".") || !part) || path.isAbsolute(name))
    throw new Error("Invalid manifest path");
  const file = await realpath(path.join(root, name));
  if (!file.startsWith(root + path.sep)) throw new Error("Preview asset escaped export");
  const data = await readFile(file);
  if (createHash("sha256").update(data).digest("hex") !== hash)
    throw new Error("Preview export changed after sealing");
  assets.set("/" + name, { data, type: types[path.extname(name)] ?? "application/octet-stream" });
}
if (!assets.has("/index.html")) throw new Error("Missing preview entry");
const server = createServer((request, response) => {
  const host = request.headers.host;
  const validHost = host === origin.host || host === `127.0.0.1:${port}`;
  const validOrigin = !request.headers.origin || request.headers.origin === origin.origin;
  if (!validHost || !validOrigin) {
    response.writeHead(403).end();
    return;
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" }).end();
    return;
  }
  const url = new URL(request.url, origin);
  let asset = assets.get(url.pathname);
  if (!asset && !path.extname(url.pathname) && request.headers.accept?.includes("text/html"))
    asset = assets.get("/index.html");
  if (!asset && url.pathname === "/") asset = assets.get("/index.html");
  if (!asset) {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, {
    "Content-Type": asset.type,
    "Content-Length": asset.data.length,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
  response.end(request.method === "HEAD" ? undefined : asset.data);
});
server.listen(port, "127.0.0.1", () =>
  console.log("Sealed theme preview is listening on loopback"),
);
