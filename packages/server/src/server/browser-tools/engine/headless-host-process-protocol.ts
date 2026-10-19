import {
  BrowserAutomationExecuteRequestSchema,
  BrowserAutomationExecuteResponseSchema,
  type BrowserAutomationExecuteRequest,
  type BrowserAutomationExecuteResponse,
} from "@getpaseo/protocol/browser-automation/rpc-schemas";
import { z } from "zod";
import { parseAllowedHost } from "./headless-host-network-policy.js";

// Messages between a headless browser host process and the process that
// spawned it. This module must stay free of Playwright imports: the daemon and
// CLI import it, and the Host startup module contract must not reach Playwright.

export const HEADLESS_BROWSER_HOST_KIND = "headless chromium";

export interface HeadlessHostProcessOptions {
  // Hostnames whose pages and requests the browser must refuse.
  deniedHosts: string[];
  // "host" or "host:port" entries that may be reached even though they are private.
  allowedHosts?: string[];
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

// Each side validates every message it receives and drops anything else, so a
// misbehaving or compromised process cannot crash the other with bad shapes.
const ChildMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready") }).strict(),
  z.object({ type: z.literal("fatal"), message: z.string().max(4_000) }).strict(),
  z
    .object({
      type: z.literal("response"),
      payload: BrowserAutomationExecuteResponseSchema.shape.payload,
    })
    .strict(),
]);

const ParentMessageSchema = z
  .object({ type: z.literal("execute"), request: BrowserAutomationExecuteRequestSchema })
  .strict();

export function parseHeadlessHostChildMessage(value: unknown): HeadlessHostChildMessage | null {
  const parsed = ChildMessageSchema.safeParse(value);
  return parsed.success ? (parsed.data as HeadlessHostChildMessage) : null;
}

export function parseHeadlessHostParentMessage(value: unknown): HeadlessHostParentMessage | null {
  const parsed = ParentMessageSchema.safeParse(value);
  return parsed.success ? (parsed.data as HeadlessHostParentMessage) : null;
}

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
  const { deniedHosts, allowedHosts, viewport, headed } = parsed as Record<string, unknown>;
  if (!Array.isArray(deniedHosts) || !deniedHosts.every((host) => typeof host === "string")) {
    throw new Error("Invalid denied hosts.");
  }
  const options: HeadlessHostProcessOptions = { deniedHosts: deniedHosts.map(normalizeDeniedHost) };
  if (allowedHosts !== undefined) {
    if (!Array.isArray(allowedHosts) || !allowedHosts.every((host) => typeof host === "string")) {
      throw new Error("Invalid allowed hosts.");
    }
    for (const host of allowedHosts) parseAllowedHost(host);
    options.allowedHosts = allowedHosts;
  }
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
