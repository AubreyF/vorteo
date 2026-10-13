import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ handle: vi.fn() }));
vi.mock("electron", () => ({ ipcMain: { handle: mocks.handle } }));

import {
  handleDesktopCommand,
  isTrustedDesktopInvocation,
  registerTrustedDesktopWindow,
} from "./desktop-ipc.js";

beforeEach(() => mocks.handle.mockClear());

describe("desktop command sender boundary", () => {
  it("accepts only the registered application main frame", () => {
    const frame = { url: "paseo://app/settings" };
    const sender = { mainFrame: frame };
    registerTrustedDesktopWindow(sender, "paseo://app/");
    expect(isTrustedDesktopInvocation({ sender, senderFrame: frame })).toBe(true);
    expect(isTrustedDesktopInvocation({ sender, senderFrame: { ...frame } })).toBe(false);
    expect(isTrustedDesktopInvocation({ sender, senderFrame: null })).toBe(false);
    expect(isTrustedDesktopInvocation({ sender: { mainFrame: frame }, senderFrame: frame })).toBe(
      false,
    );
  });

  it("rejects a registered renderer after leaving its trusted origin", () => {
    const frame = { url: "http://localhost:8081/" };
    const sender = { mainFrame: frame };
    registerTrustedDesktopWindow(sender, frame.url);
    expect(isTrustedDesktopInvocation({ sender, senderFrame: frame })).toBe(true);
    frame.url = "https://example.com/";
    expect(isTrustedDesktopInvocation({ sender, senderFrame: frame })).toBe(false);
  });

  it("rejects unauthorized invocations before calling the command", () => {
    const handler = vi.fn(() => "result");
    handleDesktopCommand("test:command", handler);
    const invoke = mocks.handle.mock.calls[0][1];
    const frame = { url: "paseo://app/" };
    const sender = { mainFrame: frame };
    expect(() => invoke({ sender, senderFrame: frame }, "value")).toThrow(
      "Desktop commands require the trusted application window.",
    );
    expect(handler).not.toHaveBeenCalled();
    registerTrustedDesktopWindow(sender, frame.url);
    expect(invoke({ sender, senderFrame: frame }, "value")).toBe("result");
    expect(handler).toHaveBeenCalledExactlyOnceWith({ sender, senderFrame: frame }, "value");
  });
});
