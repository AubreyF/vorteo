import type { Logger } from "pino";
import {
  BROWSER_AUTOMATION_COMMAND_NAMES,
  type BrowserAutomationExecuteRequest,
} from "@getpaseo/protocol/browser-automation/rpc-schemas";
import type { PersistedConfig } from "../persisted-config.js";
import type { BrowserToolsBroker } from "./broker.js";
import {
  spawnHeadlessHostProcess,
  type HeadlessHostProcess,
} from "./engine/headless-host-process-client.js";
import { parseAllowedHost } from "./engine/headless-host-network-policy.js";
import {
  HEADLESS_BROWSER_HOST_KIND,
  normalizeDeniedHost,
  type HeadlessHostProcessOptions,
} from "./engine/headless-host-process-protocol.js";
import { HeadlessHostSupervisor } from "./engine/headless-host-supervisor.js";

export const EMBEDDED_HEADLESS_HOST_ID = "daemon-headless-browser";

export interface EmbeddedHeadlessHostConfig {
  enabled?: boolean;
  deniedOrigins?: string[];
  allowedHosts?: string[];
}

export interface EmbeddedHeadlessHostInput {
  broker: Pick<BrowserToolsBroker, "registerClient" | "receiveResponse">;
  persisted: Pick<PersistedConfig, "daemon">;
  logger: Logger;
  spawn?: (options: HeadlessHostProcessOptions) => Promise<HeadlessHostProcess>;
  now?: () => number;
}

export interface EmbeddedHeadlessHost {
  stop(): Promise<void>;
}

// Registers a daemon-supervised headless Chromium as a browser automation
// host. Chromium runs in a separate process that starts on the first browser
// request, restarts after a crash with backoff, and stops with the daemon.
// Only the daemon's own agents reach it through the broker.
export function startEmbeddedHeadlessHost(input: EmbeddedHeadlessHostInput): EmbeddedHeadlessHost {
  const { broker, logger } = input;
  const config: EmbeddedHeadlessHostConfig | undefined =
    input.persisted.daemon?.browserTools?.headlessHost;
  if (config?.enabled !== true) return { stop: async () => {} };
  let options: HeadlessHostProcessOptions;
  try {
    const allowedHosts = config.allowedHosts ?? [];
    for (const host of allowedHosts) parseAllowedHost(host);
    options = {
      deniedHosts: (config.deniedOrigins ?? []).map(normalizeDeniedHost),
      ...(allowedHosts.length > 0 ? { allowedHosts } : {}),
    };
  } catch (error) {
    // Fail closed: an unreadable policy must not start an unrestricted browser.
    logger.error({ err: error }, "Headless browser host configuration is invalid; not starting");
    return { stop: async () => {} };
  }
  const supervisor = new HeadlessHostSupervisor({
    options,
    spawn:
      input.spawn ??
      ((processOptions) =>
        spawnHeadlessHostProcess({
          options: processOptions,
          onStderr: (text) => logger.debug({ text }, "Headless browser host output"),
          onInvalidMessage: () => logger.warn("Dropped an invalid message from the browser host"),
        })),
    onExit: (detail) => logger.warn(detail, "Headless browser host process exited"),
    ...(input.now ? { now: input.now } : {}),
  });
  let stopped = false;

  async function handle(request: BrowserAutomationExecuteRequest): Promise<void> {
    const payload = await supervisor.execute(request);
    broker.receiveResponse({ type: "browser.automation.execute.response", payload }, [
      EMBEDDED_HEADLESS_HOST_ID,
    ]);
  }

  const unregister = broker.registerClient({
    id: EMBEDDED_HEADLESS_HOST_ID,
    hostKind: HEADLESS_BROWSER_HOST_KIND,
    supportedCommands: [...BROWSER_AUTOMATION_COMMAND_NAMES],
    sendBrowserAutomationRequest: (request) => {
      if (!stopped) void handle(request);
    },
  });
  logger.info(
    { deniedHosts: options.deniedHosts },
    "Registered the daemon's headless browser host",
  );

  return {
    async stop() {
      if (stopped) return;
      stopped = true;
      unregister();
      await supervisor.stop();
    },
  };
}
