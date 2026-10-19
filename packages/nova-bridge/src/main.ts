import { mkdirSync, statSync } from "node:fs";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadManagedRelease, ReleaseManifestError } from "./release-manifest.js";
import { readConfig } from "./config.js";
import { BridgeStore } from "./store.js";
import { BridgeTools } from "./tools.js";
import { BridgeEvents } from "./events.js";
import { deliverWebhook } from "./webhook.js";
import { createBridgeServer } from "./server.js";

async function main(): Promise<void> {
  const file = process.argv[2];
  if (!file) throw new Error("Usage: node dist/main.js /absolute/path/to/bridge.json");
  const manifestFile = process.argv[3];
  const artifactFile = fileURLToPath(import.meta.url);
  // An unbundled entrypoint cannot bind the code loaded from its sibling modules.
  if (manifestFile && path.basename(artifactFile) !== "bridge.mjs")
    throw new ReleaseManifestError("Managed startup requires the standalone bridge.mjs bundle");
  const loaded = manifestFile
    ? loadManagedRelease({
        manifestFile,
        configFile: file,
        artifactFile,
      })
    : null;
  const config = loaded ? loaded.config : readConfig(file);
  mkdirSync(config.stateDirectory, { recursive: true, mode: 0o700 });
  if ((statSync(config.stateDirectory).mode & 0o077) !== 0)
    throw new Error("Bridge state directory must be private (0700)");
  const store = new BridgeStore(path.join(config.stateDirectory, "bridge.sqlite"));
  const tools = new BridgeTools(config, store);
  const events = new BridgeEvents(store, deliverWebhook);
  const server = createBridgeServer({
    token: config.token,
    tools,
    events,
    release: loaded?.identity,
  });
  let delivery: Promise<void> | null = null;
  let discovery: Promise<void> | null = null;
  const discoveryInterval = setInterval(() => {
    if (discovery) return;
    discovery = tools
      .discover()
      .catch(() => {
        process.stderr.write("Tool discovery failed; retained catalog remains available.\n");
      })
      .finally(() => {
        discovery = null;
      });
  }, 60_000);
  const interval = setInterval(() => {
    if (delivery) return;
    delivery = events
      .flush()
      .catch(() => {
        process.stderr.write("Event delivery failed; retained for retry.\n");
      })
      .finally(() => {
        delivery = null;
      });
  }, 1000);
  try {
    await tools.discover();
    server.listen(config.port, "127.0.0.1");
    await once(server, "listening");
    const observers = tools.observe(events);
    process.stdout.write(`Vorteo bridge listening on loopback port ${config.port}\n`);
    await new Promise<void>((resolve) => {
      const shutdown = () => {
        server.beginDrain();
        clearInterval(interval);
        clearInterval(discoveryInterval);
        resolve();
      };
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
    });
    await Promise.all(observers.map((observer) => observer.close()));
  } finally {
    server.beginDrain();
    clearInterval(interval);
    clearInterval(discoveryInterval);
    server.closeAllConnections();
    server.close();
    await server.drain();
    await delivery;
    await discovery;
    await tools.close();
    store.close();
  }
}

void main().catch(() => {
  process.stderr.write(
    "Vorteo bridge startup or shutdown failed. Check private configuration, listener, lock, and daemon availability.\n",
  );
  process.exitCode = 1;
});
