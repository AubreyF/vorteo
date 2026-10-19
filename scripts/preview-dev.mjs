#!/usr/bin/env node
// Run the real web app with Fast Refresh inside the managed private preview.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const origin = new URL(process.env.PASEO_PREVIEW_ORIGIN);
if (
  origin.protocol !== "https:" ||
  !origin.hostname.endsWith(".ts.net") ||
  origin.origin !== process.env.PASEO_PREVIEW_ORIGIN
)
  throw new Error("Managed private HTTPS origin required");
const port = Number(process.env.PASEO_PORT);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PASEO_PORT required");
const require = createRequire(import.meta.url);
const cli = require.resolve("@expo/cli");
const server = new URL("../src/start/server/metro/runServer-fork.js", `file://${cli}`);
if (!readFileSync(server, "utf8").includes("PASEO_LIVE_PREVIEW_ORIGIN"))
  throw new Error("Apply repository dependency patches before starting a live preview");

// No configured owner daemon, installation descriptor, or dotenv credentials in demo previews.
for (const key of Object.keys(process.env)) {
  if (key.startsWith("EXPO_PUBLIC_")) delete process.env[key];
}
process.env.EXPO_PUBLIC_DEMO_PREVIEW = "1";
process.env.EXPO_NO_DOTENV = "1";
process.env.EXPO_NO_TELEMETRY = "1";
process.env.EXPO_OFFLINE = "1";
// Managed services must not block on macOS browser automation or open owner tabs.
process.env.BROWSER = "none";
process.env.PASEO_LIVE_PREVIEW_ORIGIN = origin.origin;
process.env.EXPO_PACKAGER_PROXY_URL = origin.origin;
process.chdir(fileURLToPath(new URL("../packages/app", import.meta.url)));
process.argv = [process.execPath, cli, "start", "--web", "--localhost", "--port", String(port)];
require(cli);
