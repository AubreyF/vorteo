import { describe, expect, test } from "vitest";
import type {
  BrowserAutomationCommand,
  BrowserAutomationExecuteRequest,
} from "@getpaseo/protocol/browser-automation/rpc-schemas";
import { normalizeDeniedHost } from "./headless-host-process-protocol.js";
import {
  HeadlessBrowserHost,
  type PlaywrightContextLike,
  type PlaywrightPageLike,
  type PlaywrightRouteLike,
  type PlaywrightWebSocketRouteLike,
} from "./headless-host.js";

class FakePage implements PlaywrightPageLike {
  public currentUrl = "about:blank";
  public closed = false;
  public viewport: { width: number; height: number } | null = null;
  public readonly visited: string[] = [];
  private readonly listeners = new Map<string, ((payload: never) => void)[]>();
  public keyboard = { down: async () => {}, up: async () => {} };

  public url(): string {
    return this.currentUrl;
  }
  public async title(): Promise<string> {
    return `Title of ${this.currentUrl}`;
  }
  public isClosed(): boolean {
    return this.closed;
  }
  public async goto(url: string): Promise<unknown> {
    this.visited.push(url);
    this.currentUrl = url;
    return null;
  }
  public async goBack(): Promise<unknown> {
    return null;
  }
  public async goForward(): Promise<unknown> {
    return null;
  }
  public async reload(): Promise<unknown> {
    return null;
  }
  public async setViewportSize(size: { width: number; height: number }): Promise<void> {
    this.viewport = size;
  }
  public async close(): Promise<void> {
    this.closed = true;
    this.emit("close", undefined as never);
  }
  public on(event: string, listener: (payload: never) => void): unknown {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }
  public emit(event: string, payload: never): void {
    for (const listener of this.listeners.get(event) ?? []) listener(payload);
  }
}

class FakeContext implements PlaywrightContextLike {
  public readonly pages: FakePage[] = [];
  public routeMatcher: ((url: URL) => boolean) | null = null;
  public routeHandler: ((route: PlaywrightRouteLike) => unknown) | null = null;
  public webSocketMatcher: ((url: URL) => boolean) | null = null;
  public webSocketHandler: ((route: PlaywrightWebSocketRouteLike) => unknown) | null = null;
  public closed = false;

  public async newPage(): Promise<PlaywrightPageLike> {
    const page = new FakePage();
    this.pages.push(page);
    return page;
  }
  public async newCDPSession() {
    return {
      send: async (method: string) => {
        if (method === "Page.getNavigationHistory") return { currentIndex: 0, entries: [{}] };
        if (method === "Runtime.evaluate") return { result: { value: "complete" } };
        return {};
      },
      detach: async () => {},
    };
  }
  public async route(
    matcher: (url: URL) => boolean,
    handler: (route: PlaywrightRouteLike) => unknown,
  ): Promise<void> {
    this.routeMatcher = matcher;
    this.routeHandler = handler;
  }
  public async routeWebSocket(
    matcher: (url: URL) => boolean,
    handler: (route: PlaywrightWebSocketRouteLike) => unknown,
  ): Promise<void> {
    this.webSocketMatcher = matcher;
    this.webSocketHandler = handler;
  }
  public async close(): Promise<void> {
    this.closed = true;
  }
}

let sequence = 0;
function request(
  command: BrowserAutomationCommand,
  workspaceId: string | null = "wks_a",
): BrowserAutomationExecuteRequest {
  sequence += 1;
  return {
    type: "browser.automation.execute.request",
    requestId: `req-${sequence}`,
    ...(workspaceId ? { workspaceId } : {}),
    command,
  };
}

async function createHost(deniedHosts: string[] = []) {
  const context = new FakeContext();
  const host = new HeadlessBrowserHost(context, { deniedHosts });
  await host.initialize();
  return { context, host };
}

async function openTab(host: HeadlessBrowserHost, workspaceId: string, url?: string) {
  const payload = await host.execute(
    request({ command: "new_tab", args: url ? { url } : {} }, workspaceId),
  );
  if (!payload.ok || payload.result.command !== "new_tab") throw new Error("new_tab failed");
  return payload.result.browserId;
}

describe("normalizeDeniedHost", () => {
  test("accepts origins, URLs and bare hosts", () => {
    expect(normalizeDeniedHost("https://Owner.Example.com")).toBe("owner.example.com");
    expect(normalizeDeniedHost("https://owner.example.com:8443/settings")).toBe(
      "owner.example.com",
    );
    expect(normalizeDeniedHost("owner.example.com")).toBe("owner.example.com");
  });

  test("rejects empty values", () => {
    expect(() => normalizeDeniedHost("  ")).toThrow("cannot be empty");
  });
});

describe("HeadlessBrowserHost", () => {
  test("opens tabs in the requesting workspace with the configured viewport", async () => {
    const { context, host } = await createHost();
    const browserId = await openTab(host, "wks_a", "https://example.com/");

    expect(context.pages[0]?.visited).toEqual(["https://example.com/"]);
    expect(context.pages[0]?.viewport).toEqual({ width: 1280, height: 800 });

    const tabs = await host.execute(request({ command: "list_tabs", args: {} }, "wks_a"));
    expect(tabs).toMatchObject({
      ok: true,
      result: {
        tabs: [{ browserId, workspaceId: "wks_a", title: "Title of https://example.com/" }],
      },
    });
  });

  test("requires a workspace to open a tab", async () => {
    const { host } = await createHost();
    const payload = await host.execute(request({ command: "new_tab", args: {} }, null));
    expect(payload).toMatchObject({ ok: false, error: { code: "browser_unsupported" } });
  });

  test("hides tabs from other workspaces", async () => {
    const { host } = await createHost();
    const browserId = await openTab(host, "wks_a");

    const listed = await host.execute(request({ command: "list_tabs", args: {} }, "wks_b"));
    expect(listed).toMatchObject({ ok: true, result: { tabs: [] } });

    const closed = await host.execute(
      request({ command: "close_tab", args: { browserId } }, "wks_b"),
    );
    expect(closed).toMatchObject({ ok: false, error: { code: "browser_tab_not_found" } });

    const resized = await host.execute(
      request({ command: "resize", args: { browserId, width: 400, height: 300 } }, "wks_b"),
    );
    expect(resized).toMatchObject({ ok: false, error: { code: "browser_tab_not_found" } });
  });

  test("denies new tabs and navigation to denied hosts", async () => {
    const { context, host } = await createHost(["https://owner.example.com"]);

    const opened = await host.execute(
      request({ command: "new_tab", args: { url: "https://owner.example.com/settings" } }),
    );
    expect(opened).toMatchObject({ ok: false, error: { code: "browser_denied" } });
    expect(context.pages).toHaveLength(0);

    const browserId = await openTab(host, "wks_a", "https://example.com/");
    const navigated = await host.execute(
      request({ command: "navigate", args: { browserId, url: "http://owner.example.com:8080/" } }),
    );
    expect(navigated).toMatchObject({ ok: false, error: { code: "browser_denied" } });
    expect(context.pages[0]?.visited).toEqual(["https://example.com/"]);
  });

  test("aborts every request to a denied host at the context", async () => {
    const { context } = await createHost(["owner.example.com"]);

    expect(context.routeMatcher?.(new URL("wss://OWNER.example.com/ws"))).toBe(true);
    expect(context.routeMatcher?.(new URL("https://example.com/"))).toBe(false);

    const aborted: (string | undefined)[] = [];
    await context.routeHandler?.({ abort: async (code) => void aborted.push(code) });
    expect(aborted).toEqual(["blockedbyclient"]);

    expect(context.webSocketMatcher?.(new URL("wss://owner.example.com/ws"))).toBe(true);
    expect(context.webSocketMatcher?.(new URL("wss://example.com/ws"))).toBe(false);
    const closed: (number | undefined)[] = [];
    await context.webSocketHandler?.({ close: async (options) => void closed.push(options?.code) });
    expect(closed).toEqual([1008]);
  });

  test("installs no request guard without denied hosts", async () => {
    const { context } = await createHost();
    expect(context.routeMatcher).toBeNull();
    expect(context.webSocketMatcher).toBeNull();
  });

  test("closes and resizes tabs", async () => {
    const { context, host } = await createHost();
    const browserId = await openTab(host, "wks_a");

    const resized = await host.execute(
      request({ command: "resize", args: { browserId, width: 390, height: 844 } }),
    );
    expect(resized).toMatchObject({ ok: true, result: { width: 390, height: 844 } });
    expect(context.pages[0]?.viewport).toEqual({ width: 390, height: 844 });

    const closed = await host.execute(request({ command: "close_tab", args: { browserId } }));
    expect(closed).toMatchObject({ ok: true, result: { command: "close_tab", browserId } });
    expect(context.pages[0]?.closed).toBe(true);
    expect(host.listTabCount()).toBe(0);
  });

  test("adopts popups into the opener's workspace", async () => {
    const { context, host } = await createHost();
    await openTab(host, "wks_a");
    const popup = new FakePage();
    context.pages[0]?.emit("popup", popup as never);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const listed = await host.execute(request({ command: "list_tabs", args: {} }, "wks_a"));
    expect(listed.ok && listed.result.command === "list_tabs" && listed.result.tabs).toHaveLength(
      2,
    );
  });

  test("forgets tabs closed by the page and refuses work after close", async () => {
    const { context, host } = await createHost();
    await openTab(host, "wks_a");
    await context.pages[0]?.close();
    expect(host.listTabCount()).toBe(0);

    await host.close();
    expect(context.closed).toBe(true);
    const payload = await host.execute(request({ command: "list_tabs", args: {} }));
    expect(payload).toMatchObject({ ok: false, error: { code: "browser_no_host" } });
  });
});
