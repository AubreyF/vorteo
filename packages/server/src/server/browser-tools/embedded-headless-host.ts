import type { Logger } from "pino";
import {
  BROWSER_AUTOMATION_COMMAND_NAMES,
  type BrowserAutomationExecuteRequest,
} from "@getpaseo/protocol/browser-automation/rpc-schemas";
import type { PersistedConfig } from "../persisted-config.js";
import type { BrowserToolsBroker } from "./broker.js";
import {
  HEADLESS_BROWSER_HOST_KIND,
  launchHeadlessBrowserHost,
  type HeadlessBrowserHost,
  type LaunchHeadlessBrowserHostOptions,
} from "./engine/headless-host.js";

export const EMBEDDED_HEADLESS_HOST_ID = "daemon-headless-browser";

export interface EmbeddedHeadlessHostConfig {
  enabled?: boolean;
  deniedOrigins?: string[];
}

export interface EmbeddedHeadlessHostInput {
  broker: Pick<BrowserToolsBroker, "registerClient" | "receiveResponse">;
  persisted: Pick<PersistedConfig, "daemon">;
  logger: Logger;
  launch?: (options: LaunchHeadlessBrowserHostOptions) => Promise<HeadlessBrowserHost>;
}

export interface EmbeddedHeadlessHost {
  stop(): Promise<void>;
}

// Registers a daemon-owned headless Chromium as a browser automation host.
// Chromium starts on the first browser request, not at daemon startup, and
// closes with the daemon. Only the daemon's own agents reach this host.
export function startEmbeddedHeadlessHost(input: EmbeddedHeadlessHostInput): EmbeddedHeadlessHost {
  const { broker, logger } = input;
  const config: EmbeddedHeadlessHostConfig | undefined =
    input.persisted.daemon?.browserTools?.headlessHost;
  if (config?.enabled !== true) return { stop: async () => {} };
  const launch = input.launch ?? launchHeadlessBrowserHost;
  const deniedHosts = config.deniedOrigins ?? [];
  let hostPromise: Promise<HeadlessBrowserHost> | null = null;
  let stopped = false;

  function ensureHost(): Promise<HeadlessBrowserHost> {
    if (!hostPromise) {
      hostPromise = launch({ deniedHosts }).catch((error: unknown) => {
        // Allow a later request to retry, for example after browser setup.
        hostPromise = null;
        throw error;
      });
    }
    return hostPromise;
  }

  async function handle(request: BrowserAutomationExecuteRequest): Promise<void> {
    let payload;
    try {
      payload = await (await ensureHost()).execute(request);
    } catch (error) {
      logger.warn({ err: error }, "Headless browser host could not start");
      payload = {
        requestId: request.requestId,
        ok: false as const,
        error: {
          code: "browser_no_host" as const,
          message: `The daemon's headless browser could not start: ${
            error instanceof Error ? error.message : String(error)
          }`,
          retryable: true,
        },
      };
    }
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
  logger.info({ deniedHosts }, "Registered the daemon's headless browser host");

  return {
    async stop() {
      if (stopped) return;
      stopped = true;
      unregister();
      const host = await hostPromise?.catch(() => null);
      await host?.close();
    },
  };
}
