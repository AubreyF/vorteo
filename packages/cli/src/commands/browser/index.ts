import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { Command } from "commander";
import { BROWSER_AUTOMATION_COMMAND_NAMES } from "@getpaseo/protocol/browser-automation/rpc-schemas";
import { spawnHeadlessHostProcess } from "@getpaseo/server/browser-automation/headless-host-process-client";
import {
  HEADLESS_BROWSER_HOST_KIND,
  normalizeDeniedHost,
} from "@getpaseo/server/browser-automation/headless-host-process-protocol";
import { HeadlessHostSupervisor } from "@getpaseo/server/browser-automation/headless-host-supervisor";
import { parseAllowedHost } from "@getpaseo/server/browser-automation/headless-host-network-policy";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { connectToDaemon } from "../../utils/client.js";
import {
  addLocalDaemonOptions,
  collectMultiple,
  withGlobalOptions,
} from "../../utils/command-options.js";
import type { DaemonTarget } from "../../utils/daemon-target.js";

const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

interface BrowserHostOptions {
  denyOrigin: string[];
  allowHost: string[];
  headed?: boolean;
  viewport?: string;
  daemonTarget: DaemonTarget;
}

export function parseViewport(
  value: string | undefined,
): { width: number; height: number } | undefined {
  if (value === undefined) return undefined;
  const match = /^(\d+)x(\d+)$/.exec(value.trim());
  const width = match ? Number(match[1]) : 0;
  const height = match ? Number(match[2]) : 0;
  if (width <= 0 || height <= 0)
    throw new Error(`Invalid viewport "${value}". Use WIDTHxHEIGHT, such as 1280x800.`);
  return { width, height };
}

export function createBrowserCommand(): Command {
  const browser = new Command("browser").description("Browser automation hosts");
  addLocalDaemonOptions(
    browser
      .command("host")
      .description(
        "Run a disposable headless Chromium that agents on the local daemon can drive with browser tools",
      )
      .option(
        "--deny-origin <url-or-host>",
        "Never load this host on any scheme or port, such as the protected installation interface (repeatable)",
        collectMultiple,
        [],
      )
      .option(
        "--allow-host <host[:port]>",
        "Permit a private destination, such as a local preview server; private networks are blocked otherwise (repeatable)",
        collectMultiple,
        [],
      )
      .option("--viewport <WIDTHxHEIGHT>", "Initial tab viewport (default: 1280x800)")
      .option("--headed", "Show the browser window instead of running headless"),
  ).action(withGlobalOptions(runBrowserHostCommand));
  return browser;
}

async function runBrowserHostCommand(options: BrowserHostOptions): Promise<void> {
  const deniedHosts = options.denyOrigin.map(normalizeDeniedHost);
  const viewport = parseViewport(options.viewport);
  for (const host of options.allowHost) parseAllowedHost(host);
  // Chromium runs in its own process so Playwright never loads in the CLI.
  const host = new HeadlessHostSupervisor({
    options: {
      deniedHosts,
      ...(options.allowHost.length > 0 ? { allowedHosts: options.allowHost } : {}),
      ...(viewport ? { viewport } : {}),
      ...(options.headed ? { headed: true } : {}),
    },
    spawn: (processOptions) =>
      spawnHeadlessHostProcess({
        options: processOptions,
        onStderr: (text) => process.stderr.write(text),
      }),
    onExit: ({ retryInMs }) =>
      log(`Browser process exited; it restarts on the next request after ${retryInMs / 1000}s.`),
  });
  // Report a missing Playwright or Chromium before registering with the daemon.
  await host.start();

  const shutdown = new AbortController();
  const stop = () => shutdown.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  log(
    `Started ${HEADLESS_BROWSER_HOST_KIND}` +
      (deniedHosts.length > 0 ? `; denied hosts: ${deniedHosts.join(", ")}` : "; no denied hosts"),
  );

  let backoff = RECONNECT_MIN_MS;
  try {
    while (!shutdown.signal.aborted) {
      let client: DaemonClient | null = null;
      try {
        client = await connectToDaemon({ target: options.daemonTarget });
        backoff = RECONNECT_MIN_MS;
        await serveUntilDisconnected({ client, host, signal: shutdown.signal });
        if (!shutdown.signal.aborted) log("Daemon connection closed. Reconnecting.");
      } catch (error) {
        log(`Cannot reach the daemon: ${describeError(error)}`);
      } finally {
        await client?.close().catch(() => {});
      }
      await waitOrAbort(backoff, shutdown.signal);
      backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
    }
  } finally {
    await host.stop();
    log("Stopped.");
  }
}

// Resolve after ms, or when the signal aborts. A null ms waits only for the signal.
async function waitOrAbort(ms: number | null, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  if (ms === null) {
    await once(signal, "abort");
    return;
  }
  await delay(ms, undefined, { signal }).catch(() => {});
}

interface ServeBrowserHostInput {
  client: Pick<
    DaemonClient,
    "registerBrowserHost" | "sendBrowserAutomationExecuteResponse" | "subscribeConnectionStatus"
  >;
  host: Pick<HeadlessHostSupervisor, "execute">;
  signal: AbortSignal;
}

// Serve browser automation requests until the connection drops or shutdown is requested.
export async function serveUntilDisconnected(input: ServeBrowserHostInput): Promise<void> {
  const { client, host, signal } = input;
  const observation = client.registerBrowserHost({
    hostKind: HEADLESS_BROWSER_HOST_KIND,
    supportedCommands: [...BROWSER_AUTOMATION_COMMAND_NAMES],
  });
  const unsubscribe = observation.subscribe({
    snapshot: () => log("Registered with the daemon. Agents can now use browser tools."),
    update: (message) => {
      if (message.type !== "browser.automation.execute.request") return;
      void host.execute(message).then((payload) =>
        client.sendBrowserAutomationExecuteResponse({
          type: "browser.automation.execute.response",
          payload,
        }),
      );
    },
  });
  const disconnected = new AbortController();
  const unsubscribeStatus = client.subscribeConnectionStatus((state) => {
    if (state.status === "disconnected" || state.status === "disposed") disconnected.abort();
  });
  try {
    await waitOrAbort(null, AbortSignal.any([signal, disconnected.signal]));
  } finally {
    unsubscribeStatus();
    unsubscribe();
    await observation.release().catch(() => {});
  }
}

// Connection failures can be plain objects with a message, not Error instances.
function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

function log(message: string): void {
  process.stderr.write(`[browser host] ${message}\n`);
}
