import { randomUUID } from "node:crypto";

import type {
  BrowserAutomationConsoleLogEntry,
  BrowserAutomationDialogEvent,
  BrowserAutomationErrorCode,
  BrowserAutomationExecuteRequest,
} from "@getpaseo/protocol/browser-automation/rpc-schemas";
import {
  dialogAcceptValue,
  handledDialogEvent,
  MAX_DIALOGS_PER_COMMAND,
} from "./dialog-handling.js";
import {
  BrowserTabClosedError,
  executeAutomationCommand,
  type AutomationCommandPayload,
  type BrowserRegistry,
  type TabContents,
  type TabImage,
} from "./service.js";
import { normalizeDeniedHost } from "./headless-host-process-protocol.js";
import { BrowserSnapshotEngine } from "./snapshot-engine.js";
import type { IsolatedKeyboardInputEvent } from "./trusted-input.js";

// A browser automation host backed by a disposable Chromium instance.
//
// It exists for installations where no desktop app can host automation, such
// as the native host behind the protected installation interface. The browser
// never shares storage with an owner interface: each launch uses a fresh,
// in-memory context, downloads are refused, service workers are blocked, and
// requests to denied hosts are aborted for every page, frame and popup.

const DEFAULT_VIEWPORT = { width: 1280, height: 800 };
const NAVIGATION_TIMEOUT_MS = 15_000;
const MAX_CONSOLE_MESSAGES_PER_TAB = 200;

// Structural subsets of the Playwright API used here. Playwright is an
// optional peer dependency, loaded only when a headless host is launched.
interface PlaywrightCdpSession {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  detach(): Promise<void>;
}

interface PlaywrightConsoleMessage {
  type(): string;
  text(): string;
  location(): { url?: string; lineNumber?: number };
}

interface PlaywrightDialog {
  type(): string;
  message(): string;
  defaultValue(): string;
  accept(promptText?: string): Promise<void>;
  dismiss(): Promise<void>;
}

export interface PlaywrightPageLike {
  url(): string;
  title(): Promise<string>;
  isClosed(): boolean;
  goto(
    url: string,
    options?: { waitUntil?: "load" | "domcontentloaded"; timeout?: number },
  ): Promise<unknown>;
  goBack(options?: { timeout?: number }): Promise<unknown>;
  goForward(options?: { timeout?: number }): Promise<unknown>;
  reload(options?: { timeout?: number }): Promise<unknown>;
  setViewportSize(size: { width: number; height: number }): Promise<void>;
  close(): Promise<void>;
  keyboard: { down(key: string): Promise<void>; up(key: string): Promise<void> };
  on(event: string, listener: (payload: never) => void): unknown;
}

export interface PlaywrightRouteLike {
  abort(errorCode?: string): Promise<void>;
}

export interface PlaywrightWebSocketRouteLike {
  close(options?: { code?: number; reason?: string }): Promise<void>;
}

export interface PlaywrightContextLike {
  newPage(): Promise<PlaywrightPageLike>;
  newCDPSession(page: PlaywrightPageLike): Promise<PlaywrightCdpSession>;
  route(
    matcher: (url: URL) => boolean,
    handler: (route: PlaywrightRouteLike) => unknown,
  ): Promise<void>;
  // HTTP routing does not see WebSockets, so they need their own guard.
  routeWebSocket(
    matcher: (url: URL) => boolean,
    handler: (route: PlaywrightWebSocketRouteLike) => unknown,
  ): Promise<void>;
  close(): Promise<void>;
}

export interface HeadlessBrowserHostOptions {
  // Hostnames or URLs whose host must never load in this browser, on any
  // scheme or port. Use it for owner-authority origins such as the protected
  // installation interface.
  deniedHosts?: readonly string[];
  viewport?: { width: number; height: number };
}

export interface LaunchHeadlessBrowserHostOptions extends HeadlessBrowserHostOptions {
  headed?: boolean;
  executablePath?: string;
}

function urlHostname(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

function fail(
  requestId: string,
  code: BrowserAutomationErrorCode,
  message: string,
  retryable = false,
): AutomationCommandPayload {
  return { requestId, ok: false, error: { code, message, retryable } };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Electron key codes, as produced by dispatchTrustedKey, back to Playwright key names.
const PLAYWRIGHT_KEY_ALIASES: Record<string, string> = {
  Down: "ArrowDown",
  Left: "ArrowLeft",
  Right: "ArrowRight",
  Up: "ArrowUp",
};

function readPngSize(png: Uint8Array): { width: number; height: number } {
  if (png.length < 24) return { width: 0, height: 0 };
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

class PlaywrightTabContents implements TabContents {
  private title = "";
  private historyIndex = 0;
  private historyLength = 1;
  private loading = false;
  private inputChain: Promise<void> = Promise.resolve();
  private readonly consoleMessages: BrowserAutomationConsoleLogEntry[] = [];
  private dialogCollector: BrowserAutomationDialogEvent[] | null = null;

  public constructor(
    public readonly id: number,
    private readonly page: PlaywrightPageLike,
    private readonly cdp: PlaywrightCdpSession,
  ) {
    page.on("console", (message: PlaywrightConsoleMessage) => {
      const location = message.location();
      this.consoleMessages.push({
        level: message.type(),
        message: message.text(),
        ...(location.url ? { source: location.url } : {}),
        ...(typeof location.lineNumber === "number" ? { line: location.lineNumber } : {}),
        timestamp: Date.now(),
      });
      if (this.consoleMessages.length > MAX_CONSOLE_MESSAGES_PER_TAB) this.consoleMessages.shift();
    });
    page.on("dialog", (dialog: PlaywrightDialog) => {
      const event = handledDialogEvent({
        type: dialog.type(),
        message: dialog.message(),
        defaultPrompt: dialog.defaultValue(),
      });
      if (this.dialogCollector && this.dialogCollector.length < MAX_DIALOGS_PER_COMMAND) {
        this.dialogCollector.push(event);
      }
      void (dialogAcceptValue(event.type) ? dialog.accept() : dialog.dismiss()).catch(() => {});
    });
    page.on("framenavigated", () => {
      this.loading = true;
    });
    page.on("load", () => {
      this.loading = false;
    });
  }

  // Playwright exposes title and history asynchronously, while the engine
  // reads them synchronously. Refresh them before each command.
  public async refresh(): Promise<void> {
    if (this.page.isClosed()) return;
    try {
      this.title = await this.page.title();
      const history = (await this.cdp.send("Page.getNavigationHistory")) as {
        currentIndex?: number;
        entries?: unknown[];
      };
      this.historyIndex = history.currentIndex ?? 0;
      this.historyLength = history.entries?.length ?? 1;
      const readyState = await this.evaluate("document.readyState");
      this.loading = readyState !== "complete";
    } catch {
      // A navigating or closing page can reject these reads; keep the last state.
    }
  }

  public getURL(): string {
    return this.page.url();
  }

  public getTitle(): string {
    return this.title;
  }

  public canGoBack(): boolean {
    return this.historyIndex > 0;
  }

  public canGoForward(): boolean {
    return this.historyIndex < this.historyLength - 1;
  }

  public isLoading(): boolean {
    return this.loading;
  }

  public isDestroyed(): boolean {
    return this.page.isClosed();
  }

  public async executeJavaScript(code: string): Promise<unknown> {
    await this.inputChain;
    return this.evaluate(code);
  }

  private async evaluate(code: string): Promise<unknown> {
    if (this.page.isClosed()) throw new BrowserTabClosedError();
    // Match Electron's executeJavaScript: main world, awaited promises, JSON values.
    const response = (await this.cdp.send("Runtime.evaluate", {
      expression: code,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    })) as {
      result?: { value?: unknown };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    };
    if (response.exceptionDetails) {
      throw new Error(
        response.exceptionDetails.exception?.description ??
          response.exceptionDetails.text ??
          "Script evaluation failed",
      );
    }
    return response.result?.value;
  }

  public async loadURL(url: string): Promise<void> {
    await this.page.goto(url, { waitUntil: "load", timeout: NAVIGATION_TIMEOUT_MS });
  }

  public goBack(): void {
    void this.page.goBack({ timeout: NAVIGATION_TIMEOUT_MS }).catch(() => {});
  }

  public goForward(): void {
    void this.page.goForward({ timeout: NAVIGATION_TIMEOUT_MS }).catch(() => {});
  }

  public reload(): void {
    void this.page.reload({ timeout: NAVIGATION_TIMEOUT_MS }).catch(() => {});
  }

  public async captureFrame(signal: AbortSignal): Promise<TabImage> {
    signal.throwIfAborted();
    if (this.page.isClosed()) throw new BrowserTabClosedError();
    const screenshot = (await this.cdp.send("Page.captureScreenshot", { format: "png" })) as {
      data?: string;
    };
    if (!screenshot.data) throw new Error("No frame was captured");
    const png = new Uint8Array(Buffer.from(screenshot.data, "base64"));
    const size = readPngSize(png);
    return { toPNG: () => png, getSize: () => size };
  }

  public invalidate(): void {
    // Headless Chromium paints on demand for captureScreenshot.
  }

  public withFrameProduction<T>(capture: () => Promise<T>): Promise<T> {
    return capture();
  }

  public sendInputEvent(event: IsolatedKeyboardInputEvent): void {
    // Playwright's keydown already inserts printable text, so skip the separate
    // character event that Electron needs.
    if (event.type === "char") return;
    const key = PLAYWRIGHT_KEY_ALIASES[event.keyCode] ?? event.keyCode;
    const keyboard = this.page.keyboard;
    this.inputChain = this.inputChain
      .then(() => (event.type === "keyDown" ? keyboard.down(key) : keyboard.up(key)))
      .catch(() => {});
  }

  public getConsoleMessages(): BrowserAutomationConsoleLogEntry[] {
    return [...this.consoleMessages];
  }

  public async captureDialogs<T>(
    task: () => Promise<T>,
  ): Promise<{ result: T; dialogs: BrowserAutomationDialogEvent[] }> {
    const dialogs: BrowserAutomationDialogEvent[] = [];
    this.dialogCollector = dialogs;
    try {
      return { result: await task(), dialogs };
    } finally {
      if (this.dialogCollector === dialogs) this.dialogCollector = null;
    }
  }

  public async sendDebugCommand(
    command: string,
    params?: Record<string, unknown>,
  ): Promise<unknown> {
    await this.inputChain;
    if (this.page.isClosed()) throw new BrowserTabClosedError();
    return this.cdp.send(command, params ?? {});
  }
}

interface HeadlessTab {
  browserId: string;
  workspaceId: string;
  page: PlaywrightPageLike;
  contents: PlaywrightTabContents;
}

export class HeadlessBrowserHost {
  private readonly tabs = new Map<string, HeadlessTab>();
  private readonly activeByWorkspace = new Map<string, string>();
  private readonly deniedHosts: ReadonlySet<string>;
  private readonly viewport: { width: number; height: number };
  private readonly snapshotEngine = new BrowserSnapshotEngine();
  private readonly registry: BrowserRegistry;
  private nextContentsId = 1;
  private closed = false;

  public constructor(
    private readonly context: PlaywrightContextLike,
    options: HeadlessBrowserHostOptions = {},
    private readonly onClose?: () => Promise<void>,
  ) {
    this.deniedHosts = new Set((options.deniedHosts ?? []).map(normalizeDeniedHost));
    this.viewport = options.viewport ?? DEFAULT_VIEWPORT;
    this.registry = {
      listRegisteredBrowserIds: () => [...this.tabs.keys()],
      listRegisteredBrowserIdsForWorkspace: (workspaceId) =>
        [...this.tabs.values()]
          .filter((tab) => tab.workspaceId === workspaceId)
          .map((tab) => tab.browserId),
      getTabContents: (browserId) => this.tabs.get(browserId)?.contents ?? null,
      getBrowserWorkspaceId: (browserId) => this.tabs.get(browserId)?.workspaceId ?? null,
      getWorkspaceActiveBrowserId: (workspaceId) => this.activeByWorkspace.get(workspaceId) ?? null,
    };
  }

  // Install the request guard before any page exists, so no page, frame,
  // redirect or popup can reach a denied host.
  public async initialize(): Promise<void> {
    if (this.deniedHosts.size === 0) return;
    const denied = (url: URL) => this.deniedHosts.has(url.hostname.toLowerCase());
    await this.context.route(denied, (route) => route.abort("blockedbyclient"));
    // Without connectToServer, a routed WebSocket never reaches the server.
    await this.context.routeWebSocket(denied, (route) =>
      route.close({ code: 1008, reason: "Blocked by browser host policy" }),
    );
  }

  public isDeniedUrl(url: string): boolean {
    const hostname = urlHostname(url);
    return hostname !== null && this.deniedHosts.has(hostname);
  }

  public async execute(
    request: BrowserAutomationExecuteRequest,
  ): Promise<AutomationCommandPayload> {
    const { requestId, command } = request;
    if (this.closed)
      return fail(requestId, "browser_no_host", "The headless browser has closed.", true);
    try {
      switch (command.command) {
        case "new_tab":
          return await this.openTab(request, command.args.url);
        case "close_tab":
          return await this.closeTab(request, command.args.browserId);
        case "resize":
          return await this.resizeTab(request, command.args);
        case "navigate":
          if (this.isDeniedUrl(command.args.url))
            return this.deniedFailure(requestId, command.args.url);
          break;
        default:
          break;
      }
      await this.refreshForCommand(request);
      return await executeAutomationCommand(request, this.registry, {
        snapshotEngine: this.snapshotEngine,
      });
    } catch (error) {
      if (error instanceof BrowserTabClosedError) {
        return fail(requestId, "browser_tab_closed", error.message);
      }
      return fail(requestId, "browser_unknown_error", errorMessage(error));
    }
  }

  public listTabCount(): number {
    return this.tabs.size;
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.tabs.clear();
    this.activeByWorkspace.clear();
    await this.context.close().catch(() => {});
    await this.onClose?.();
  }

  private deniedFailure(requestId: string, url: string): AutomationCommandPayload {
    return fail(
      requestId,
      "browser_denied",
      `This browser host is not allowed to open ${urlHostname(url) ?? url}.`,
    );
  }

  private findWorkspaceTab(
    request: BrowserAutomationExecuteRequest,
    browserId: string,
  ): HeadlessTab | null {
    const tab = this.tabs.get(browserId);
    if (!tab) return null;
    if (request.workspaceId && tab.workspaceId !== request.workspaceId) return null;
    return tab;
  }

  private async refreshForCommand(request: BrowserAutomationExecuteRequest): Promise<void> {
    const args = request.command.args as { browserId?: string };
    const targets = args.browserId
      ? [this.findWorkspaceTab(request, args.browserId)]
      : [...this.tabs.values()].filter(
          (tab) => !request.workspaceId || tab.workspaceId === request.workspaceId,
        );
    await Promise.all(targets.map((tab) => tab?.contents.refresh()));
    const target = args.browserId ? targets[0] : null;
    if (target) this.activeByWorkspace.set(target.workspaceId, target.browserId);
  }

  private async openTab(
    request: BrowserAutomationExecuteRequest,
    url: string | undefined,
  ): Promise<AutomationCommandPayload> {
    const { requestId, workspaceId } = request;
    if (!workspaceId) {
      return fail(
        requestId,
        "browser_unsupported",
        "Cannot create a browser tab without a workspace context.",
      );
    }
    if (url && this.isDeniedUrl(url)) return this.deniedFailure(requestId, url);
    const page = await this.context.newPage();
    const tab = await this.registerPage(page, workspaceId);
    if (url) {
      // Like the desktop host, a tab whose first load fails still exists; a
      // snapshot or screenshot shows the browser's error page.
      await page.goto(url, { waitUntil: "load", timeout: NAVIGATION_TIMEOUT_MS }).catch(() => {});
    }
    return {
      requestId,
      ok: true,
      result: { command: "new_tab", browserId: tab.browserId, workspaceId, url: url ?? page.url() },
    };
  }

  private async registerPage(page: PlaywrightPageLike, workspaceId: string): Promise<HeadlessTab> {
    await page.setViewportSize(this.viewport);
    const cdp = await this.context.newCDPSession(page);
    const browserId = randomUUID();
    const tab: HeadlessTab = {
      browserId,
      workspaceId,
      page,
      contents: new PlaywrightTabContents(this.nextContentsId++, page, cdp),
    };
    this.tabs.set(browserId, tab);
    this.activeByWorkspace.set(workspaceId, browserId);
    page.on("close", () => this.forgetTab(browserId));
    // Popups stay addressable in the workspace that opened them.
    page.on("popup", (popup: PlaywrightPageLike) => {
      if (this.closed) return;
      void this.registerPage(popup, workspaceId).catch(() => {});
    });
    return tab;
  }

  private forgetTab(browserId: string): void {
    const tab = this.tabs.get(browserId);
    if (!tab) return;
    this.tabs.delete(browserId);
    this.snapshotEngine.clearBrowser(browserId);
    if (this.activeByWorkspace.get(tab.workspaceId) === browserId) {
      const next = [...this.tabs.values()].findLast((t) => t.workspaceId === tab.workspaceId);
      if (next) this.activeByWorkspace.set(tab.workspaceId, next.browserId);
      else this.activeByWorkspace.delete(tab.workspaceId);
    }
  }

  private async closeTab(
    request: BrowserAutomationExecuteRequest,
    browserId: string,
  ): Promise<AutomationCommandPayload> {
    const tab = this.findWorkspaceTab(request, browserId);
    if (!tab)
      return fail(
        request.requestId,
        "browser_tab_not_found",
        `No browser tab found for ID: ${browserId}`,
      );
    this.forgetTab(browserId);
    await tab.page.close().catch(() => {});
    return { requestId: request.requestId, ok: true, result: { command: "close_tab", browserId } };
  }

  private async resizeTab(
    request: BrowserAutomationExecuteRequest,
    args: { browserId: string; width: number; height: number },
  ): Promise<AutomationCommandPayload> {
    const tab = this.findWorkspaceTab(request, args.browserId);
    if (!tab) {
      return fail(
        request.requestId,
        "browser_tab_not_found",
        `No browser tab found for ID: ${args.browserId}`,
      );
    }
    await tab.page.setViewportSize({ width: args.width, height: args.height });
    return {
      requestId: request.requestId,
      ok: true,
      result: {
        command: "resize",
        browserId: args.browserId,
        width: args.width,
        height: args.height,
      },
    };
  }
}

interface PlaywrightModule {
  chromium: {
    launch(options: { headless: boolean; executablePath?: string }): Promise<{
      newContext(options: Record<string, unknown>): Promise<PlaywrightContextLike>;
      close(): Promise<void>;
    }>;
  };
}

async function importPlaywright(): Promise<PlaywrightModule> {
  try {
    return (await import("playwright-core")) as unknown as PlaywrightModule;
  } catch (error) {
    throw new Error(
      "The headless browser host needs the optional playwright-core package and a Chromium build. " +
        "Install them with `npm run browser:setup` in the Vorteo checkout.",
      { cause: error },
    );
  }
}

export async function launchHeadlessBrowserHost(
  options: LaunchHeadlessBrowserHostOptions = {},
): Promise<HeadlessBrowserHost> {
  const playwright = await importPlaywright();
  const browser = await playwright.chromium.launch({
    headless: !options.headed,
    ...(options.executablePath ? { executablePath: options.executablePath } : {}),
  });
  try {
    // newContext without a user data directory is an ephemeral, in-memory
    // profile. Nothing persists between launches.
    const context = await browser.newContext({
      viewport: options.viewport ?? DEFAULT_VIEWPORT,
      deviceScaleFactor: 1,
      acceptDownloads: false,
      serviceWorkers: "block",
      permissions: [],
    });
    const host = new HeadlessBrowserHost(context, options, () => browser.close());
    await host.initialize();
    return host;
  } catch (error) {
    await browser.close().catch(() => {});
    throw error;
  }
}
