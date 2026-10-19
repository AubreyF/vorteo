import { describe, expect, test } from "vitest";
import pino from "pino";
import type { BrowserAutomationExecuteRequest } from "@getpaseo/protocol/browser-automation/rpc-schemas";
import { BrowserToolsBroker } from "./broker.js";
import { startEmbeddedHeadlessHost } from "./embedded-headless-host.js";
import type {
  HeadlessBrowserHost,
  LaunchHeadlessBrowserHostOptions,
} from "./engine/headless-host.js";

const logger = pino({ level: "silent" });
const ENABLED = { daemon: { browserTools: { headlessHost: { enabled: true } } } };

class FakeHeadlessHost {
  public readonly requests: BrowserAutomationExecuteRequest[] = [];
  public closed = false;

  public async execute(request: BrowserAutomationExecuteRequest) {
    this.requests.push(request);
    return {
      requestId: request.requestId,
      ok: true as const,
      result: { command: "list_tabs" as const, tabs: [] },
    };
  }

  public async close(): Promise<void> {
    this.closed = true;
  }
}

function createLauncher(failures = 0) {
  const launches: LaunchHeadlessBrowserHostOptions[] = [];
  const hosts: FakeHeadlessHost[] = [];
  let remainingFailures = failures;
  async function launch(options: LaunchHeadlessBrowserHostOptions) {
    launches.push(options);
    if (remainingFailures > 0) {
      remainingFailures -= 1;
      throw new Error("Chromium is not installed");
    }
    const host = new FakeHeadlessHost();
    hosts.push(host);
    return host as unknown as HeadlessBrowserHost;
  }
  return { launch, launches, hosts };
}

function listTabs(broker: BrowserToolsBroker) {
  return broker.execute({
    command: { command: "list_tabs", args: {} },
    workspaceId: "wks_a",
    timeoutMs: 1_000,
  });
}

describe("startEmbeddedHeadlessHost", () => {
  test("registers nothing unless enabled", async () => {
    const broker = new BrowserToolsBroker({});
    const launcher = createLauncher();

    startEmbeddedHeadlessHost({ broker, persisted: {}, logger });
    const disabled = startEmbeddedHeadlessHost({
      broker,
      persisted: { daemon: { browserTools: { headlessHost: { enabled: false } } } },
      logger,
      launch: launcher.launch,
    });

    expect(broker.getRegisteredClientCount()).toBe(0);
    await disabled.stop();
    expect(launcher.launches).toHaveLength(0);
  });

  test("launches Chromium on the first request with the denied origins", async () => {
    const broker = new BrowserToolsBroker({});
    const launcher = createLauncher();
    startEmbeddedHeadlessHost({
      broker,
      persisted: {
        daemon: {
          browserTools: {
            headlessHost: { enabled: true, deniedOrigins: ["https://owner.example.com"] },
          },
        },
      },
      logger,
      launch: launcher.launch,
    });

    expect(broker.getRegisteredClientCount()).toBe(1);
    expect(launcher.launches).toHaveLength(0);

    await expect(listTabs(broker)).resolves.toMatchObject({ ok: true });
    await expect(listTabs(broker)).resolves.toMatchObject({ ok: true });
    expect(launcher.launches).toEqual([{ deniedHosts: ["https://owner.example.com"] }]);
    expect(launcher.hosts[0]?.requests).toHaveLength(2);
  });

  test("reports a failed launch and retries on the next request", async () => {
    const broker = new BrowserToolsBroker({});
    const launcher = createLauncher(1);
    startEmbeddedHeadlessHost({
      broker,
      persisted: ENABLED,
      logger,
      launch: launcher.launch,
    });

    await expect(listTabs(broker)).resolves.toMatchObject({
      ok: false,
      error: { code: "browser_no_host", retryable: true },
    });
    await expect(listTabs(broker)).resolves.toMatchObject({ ok: true });
    expect(launcher.launches).toHaveLength(2);
  });

  test("unregisters and closes Chromium when stopped", async () => {
    const broker = new BrowserToolsBroker({});
    const launcher = createLauncher();
    const host = startEmbeddedHeadlessHost({
      broker,
      persisted: ENABLED,
      logger,
      launch: launcher.launch,
    });
    await listTabs(broker);

    await host.stop();
    expect(broker.getRegisteredClientCount()).toBe(0);
    expect(launcher.hosts[0]?.closed).toBe(true);
  });
});
