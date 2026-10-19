import type {
  BrowserAutomationExecuteRequest,
  BrowserAutomationExecuteResponse,
} from "@getpaseo/protocol/browser-automation/rpc-schemas";

// Messages between a headless browser host process and the process that
// spawned it. This module must stay free of Playwright imports: the daemon and
// CLI import it, and the Host startup module contract must not reach Playwright.

export const HEADLESS_BROWSER_HOST_KIND = "headless chromium";

export interface HeadlessHostProcessOptions {
  // Hostnames whose pages and requests the browser must refuse.
  deniedHosts: string[];
  viewport?: { width: number; height: number };
  headed?: boolean;
}

export interface HeadlessHostParentMessage {
  type: "execute";
  request: BrowserAutomationExecuteRequest;
}

export type HeadlessHostChildMessage =
  | { type: "ready" }
  | { type: "response"; payload: BrowserAutomationExecuteResponse["payload"] }
  | { type: "fatal"; message: string };

export function normalizeDeniedHost(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("A denied host cannot be empty.");
  const candidate = trimmed.includes("://") ? trimmed : `https://${trimmed}`;
  let hostname: string;
  try {
    hostname = new URL(candidate).hostname;
  } catch {
    throw new Error(`Invalid denied host: ${value}`);
  }
  if (!hostname) throw new Error(`Invalid denied host: ${value}`);
  return hostname.toLowerCase();
}

export function encodeHeadlessHostProcessOptions(options: HeadlessHostProcessOptions): string {
  return JSON.stringify(options);
}

export function decodeHeadlessHostProcessOptions(
  value: string | undefined,
): HeadlessHostProcessOptions {
  if (!value) throw new Error("Missing headless browser host options.");
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== "object" || parsed === null) throw new Error("Invalid host options.");
  const { deniedHosts, viewport, headed } = parsed as Record<string, unknown>;
  if (!Array.isArray(deniedHosts) || !deniedHosts.every((host) => typeof host === "string")) {
    throw new Error("Invalid denied hosts.");
  }
  const options: HeadlessHostProcessOptions = { deniedHosts: deniedHosts.map(normalizeDeniedHost) };
  if (viewport !== undefined) {
    const { width, height } = (viewport ?? {}) as Record<string, unknown>;
    if (
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      (width as number) <= 0 ||
      (height as number) <= 0
    ) {
      throw new Error("Invalid viewport.");
    }
    options.viewport = { width: width as number, height: height as number };
  }
  if (headed === true) options.headed = true;
  return options;
}
