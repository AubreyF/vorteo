import { describe, expect, test } from "vitest";
import pino from "pino";
import type { BrowserAutomationExecuteRequest } from "@getpaseo/protocol/browser-automation/rpc-schemas";
import { BrowserToolsBroker } from "./broker.js";
import { startEmbeddedHeadlessHost } from "./embedded-headless-host.js";
import type {
  HeadlessHostProcess,
  HeadlessHostProcessExit,
} from "./engine/headless-host-process-client.js";
import type { HeadlessHostProcessOptions } from "./engine/headless-host-process-protocol.js";

const logger = pino({ level: "silent" });
const ENABLED = { daemon: { browserTools: { headlessHost: { enabled: true } } } };

class FakeHostProcess implements HeadlessHostProcess {
  public readonly requests: BrowserAutomationExecuteRequest[] = [];
  public closed = false;
  public readonly exited: Promise<HeadlessHostProcessExit>;
  private exit: (value: HeadlessHostProcessExit) => void = () => {};

  public constructor() {
    this.exited = new Promise((resolve) => {
      this.exit = resolve;
    });
  }

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
    this.crash();
  }

  public crash(): void {
    this.exit({ code: 1, signal: null });
  }
}

function createSpawner(failures = 0) {
  const spawned: HeadlessHostProcessOptions[] = [];
  const processes: FakeHostProcess[] = [];
  let remainingFailures = failures;
  async function spawn(options: HeadlessHostProcessOptions): Promise<HeadlessHostProcess> {
    spawned.push(options);
    if (remainingFailures > 0) {
      remainingFailures -= 1;
      throw new Error("Chromium is not installed");
    }
    const process = new FakeHostProcess();
    processes.push(process);
    return process;
  }
  return { spawn, spawned, processes };
}

function createClock() {
  let time = 1_000_000;
  return { now: () => time, advance: (ms: number) => void (time += ms) };
}

function listTabs(broker: BrowserToolsBroker) {
  return broker.execute({
    command: { command: "list_tabs", args: {} },
    workspaceId: "wks_a",
    timeoutMs: 1_000,
  });
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("startEmbeddedHeadlessHost", () => {
  test("registers nothing unless enabled", async () => {
    const broker = new BrowserToolsBroker({});
    const spawner = createSpawner();

    startEmbeddedHeadlessHost({ broker, persisted: {}, logger });
    const disabled = startEmbeddedHeadlessHost({
      broker,
      persisted: { daemon: { browserTools: { headlessHost: { enabled: false } } } },
      logger,
      spawn: spawner.spawn,
    });

    expect(broker.getRegisteredClientCount()).toBe(0);
    await disabled.stop();
    expect(spawner.spawned).toHaveLength(0);
  });

  test("starts the browser process on the first request with normalized denied hosts", async () => {
    const broker = new BrowserToolsBroker({});
    const spawner = createSpawner();
    startEmbeddedHeadlessHost({
      broker,
      persisted: {
        daemon: {
          browserTools: {
            headlessHost: { enabled: true, deniedOrigins: ["https://Owner.Example.com/settings"] },
          },
        },
      },
      logger,
      spawn: spawner.spawn,
    });

    expect(broker.getRegisteredClientCount()).toBe(1);
    expect(spawner.spawned).toHaveLength(0);

    await expect(listTabs(broker)).resolves.toMatchObject({ ok: true });
    await expect(listTabs(broker)).resolves.toMatchObject({ ok: true });
    expect(spawner.spawned).toEqual([{ deniedHosts: ["owner.example.com"] }]);
    expect(spawner.processes[0]?.requests).toHaveLength(2);
  });

  test("fails fast during crash backoff and restarts afterwards", async () => {
    const broker = new BrowserToolsBroker({});
    const spawner = createSpawner();
    const clock = createClock();
    startEmbeddedHeadlessHost({
      broker,
      persisted: ENABLED,
      logger,
      spawn: spawner.spawn,
      now: clock.now,
    });
    await listTabs(broker);

    spawner.processes[0]?.crash();
    await settle();
    await expect(listTabs(broker)).resolves.toMatchObject({
      ok: false,
      error: {
        code: "browser_no_host",
        retryable: true,
        message: expect.stringContaining("restarting"),
      },
    });
    expect(spawner.spawned).toHaveLength(1);

    clock.advance(1_000);
    await expect(listTabs(broker)).resolves.toMatchObject({ ok: true });
    expect(spawner.spawned).toHaveLength(2);

    // A second quick crash doubles the backoff.
    spawner.processes[1]?.crash();
    await settle();
    clock.advance(1_000);
    await expect(listTabs(broker)).resolves.toMatchObject({ ok: false });
    clock.advance(1_000);
    await expect(listTabs(broker)).resolves.toMatchObject({ ok: true });
    expect(spawner.spawned).toHaveLength(3);
  });

  test("reports a failed start and retries after the backoff", async () => {
    const broker = new BrowserToolsBroker({});
    const spawner = createSpawner(1);
    const clock = createClock();
    startEmbeddedHeadlessHost({
      broker,
      persisted: ENABLED,
      logger,
      spawn: spawner.spawn,
      now: clock.now,
    });

    await expect(listTabs(broker)).resolves.toMatchObject({
      ok: false,
      error: { code: "browser_no_host", message: "Chromium is not installed" },
    });
    clock.advance(1_000);
    await expect(listTabs(broker)).resolves.toMatchObject({ ok: true });
  });

  test("unregisters and stops the browser process with the daemon", async () => {
    const broker = new BrowserToolsBroker({});
    const spawner = createSpawner();
    const host = startEmbeddedHeadlessHost({
      broker,
      persisted: ENABLED,
      logger,
      spawn: spawner.spawn,
    });
    await listTabs(broker);

    await host.stop();
    expect(broker.getRegisteredClientCount()).toBe(0);
    expect(spawner.processes[0]?.closed).toBe(true);
  });
});
