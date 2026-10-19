import { describe, expect, test } from "vitest";
import type { BrowserAutomationExecuteRequest } from "@getpaseo/protocol/browser-automation/rpc-schemas";
import type { HeadlessBrowserHost, LaunchHeadlessBrowserHostOptions } from "./headless-host.js";
import { headlessHostChildEnvironment } from "./headless-host-process-client.js";
import {
  decodeHeadlessHostProcessOptions,
  encodeHeadlessHostProcessOptions,
  parseHeadlessHostChildMessage,
  parseHeadlessHostParentMessage,
  type HeadlessHostChildMessage,
  type HeadlessHostParentMessage,
} from "./headless-host-process-protocol.js";
import { runHeadlessHostProcess } from "./headless-host-process-runner.js";

class FakeChannel {
  public readonly sent: HeadlessHostChildMessage[] = [];
  private messageListener: (message: HeadlessHostParentMessage) => void = () => {};
  private disconnectListener: () => void = () => {};

  public send(message: HeadlessHostChildMessage): void {
    this.sent.push(message);
  }
  public onMessage(listener: (message: HeadlessHostParentMessage) => void): void {
    this.messageListener = listener;
  }
  public onDisconnect(listener: () => void): void {
    this.disconnectListener = listener;
  }
  public deliver(message: HeadlessHostParentMessage): void {
    this.messageListener(message);
  }
  public disconnect(): void {
    this.disconnectListener();
  }
}

function fakeHost() {
  const state = { closed: false, executed: [] as BrowserAutomationExecuteRequest[] };
  const host = {
    async execute(request: BrowserAutomationExecuteRequest) {
      state.executed.push(request);
      return {
        requestId: request.requestId,
        ok: true as const,
        result: { command: "list_tabs" as const, tabs: [] },
      };
    },
    async close() {
      state.closed = true;
    },
  };
  return { host: host as unknown as HeadlessBrowserHost, state };
}

const request: BrowserAutomationExecuteRequest = {
  type: "browser.automation.execute.request",
  requestId: "req-1",
  workspaceId: "wks_a",
  command: { command: "list_tabs", args: {} },
};

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("runHeadlessHostProcess", () => {
  test("launches with the given options, reports ready and answers requests", async () => {
    const channel = new FakeChannel();
    const { host, state } = fakeHost();
    const launched: LaunchHeadlessBrowserHostOptions[] = [];
    await runHeadlessHostProcess({
      channel,
      options: { deniedHosts: ["owner.example.com"], viewport: { width: 390, height: 844 } },
      launch: async (options) => {
        launched.push(options);
        return host;
      },
    });

    expect(launched).toEqual([
      { deniedHosts: ["owner.example.com"], viewport: { width: 390, height: 844 } },
    ]);
    expect(channel.sent).toEqual([{ type: "ready" }]);

    channel.deliver({ type: "execute", request });
    await settle();
    expect(state.executed).toEqual([request]);
    expect(channel.sent.at(-1)).toMatchObject({
      type: "response",
      payload: { requestId: "req-1", ok: true },
    });
  });

  test("reports a launch failure as fatal", async () => {
    const channel = new FakeChannel();
    const run = await runHeadlessHostProcess({
      channel,
      options: { deniedHosts: [] },
      launch: async () => {
        throw new Error("Chromium is not installed");
      },
    });

    expect(channel.sent).toEqual([{ type: "fatal", message: "Chromium is not installed" }]);
    await expect(run.done).resolves.toBe(false);
  });

  test("closes the browser when the parent disconnects", async () => {
    const channel = new FakeChannel();
    const { host, state } = fakeHost();
    const run = await runHeadlessHostProcess({
      channel,
      options: { deniedHosts: [] },
      launch: async () => host,
    });

    channel.disconnect();
    await expect(run.done).resolves.toBe(true);
    expect(state.closed).toBe(true);

    channel.deliver({ type: "execute", request });
    await settle();
    expect(state.executed).toEqual([]);
  });
});

describe("headless host process options", () => {
  test("round-trip with normalized denied hosts", () => {
    const encoded = encodeHeadlessHostProcessOptions({
      deniedHosts: ["https://Owner.Example.com/settings"],
      viewport: { width: 1280, height: 800 },
      headed: true,
    });
    expect(decodeHeadlessHostProcessOptions(encoded)).toEqual({
      deniedHosts: ["owner.example.com"],
      viewport: { width: 1280, height: 800 },
      headed: true,
    });
  });

  test("reject missing or malformed options", () => {
    expect(() => decodeHeadlessHostProcessOptions(undefined)).toThrow("Missing");
    expect(() => decodeHeadlessHostProcessOptions('{"deniedHosts":"x"}')).toThrow("denied hosts");
    expect(() =>
      decodeHeadlessHostProcessOptions('{"deniedHosts":[],"viewport":{"width":0,"height":5}}'),
    ).toThrow("viewport");
  });
});

describe("headless host IPC validation", () => {
  test("accepts well-formed child messages", () => {
    expect(parseHeadlessHostChildMessage({ type: "ready" })).toEqual({ type: "ready" });
    expect(
      parseHeadlessHostChildMessage({
        type: "response",
        payload: { requestId: "req-1", ok: true, result: { command: "list_tabs", tabs: [] } },
      }),
    ).toMatchObject({ type: "response", payload: { requestId: "req-1" } });
  });

  test.each([
    ["a response without a payload", { type: "response" }],
    ["a payload without a request ID", { type: "response", payload: { ok: true } }],
    ["an unknown type", { type: "shutdown" }],
    ["extra fields", { type: "ready", command: "rm" }],
    ["an oversized fatal message", { type: "fatal", message: "x".repeat(5_000) }],
    ["a non-object", "ready"],
    ["null", null],
  ])("drops %s from the child", (_label, message) => {
    expect(parseHeadlessHostChildMessage(message)).toBeNull();
  });

  test("validates parent requests", () => {
    expect(parseHeadlessHostParentMessage({ type: "execute", request })).toMatchObject({
      type: "execute",
      request: { requestId: "req-1" },
    });
    expect(parseHeadlessHostParentMessage({ type: "execute" })).toBeNull();
    expect(
      parseHeadlessHostParentMessage({
        type: "execute",
        request: { ...request, command: { command: "rm" } },
      }),
    ).toBeNull();
  });
});

describe("headlessHostChildEnvironment", () => {
  test("passes only the variables the browser host needs", () => {
    expect(
      headlessHostChildEnvironment({
        PATH: "/usr/bin",
        HOME: "/Users/owner",
        TMPDIR: "/tmp/x",
        SSH_AUTH_SOCK: "/private/agent.sock",
        ANTHROPIC_API_KEY: "secret",
        PASEO_HOME: "/state",
      }),
    ).toEqual({ PATH: "/usr/bin", HOME: "/Users/owner", TMPDIR: "/tmp/x" });
  });
});
