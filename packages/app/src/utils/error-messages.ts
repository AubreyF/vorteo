import { DaemonConnectionError } from "@getpaseo/client/internal/daemon-client";
import { i18n } from "@/i18n/i18next";

// Client transport failures carry these messages. They describe the connection, not the
// action, and mean nothing to the owner, so they are never shown verbatim.
const CONNECTION_ERROR_PATTERNS = [
  /^Transport (?:closed|not connected|error)\b/,
  /^Liveness check timed out\b/,
  /^Connection (?:lost|verification failed|changed|timed out)\b/,
  /^Timed? ?out waiting for (?:message|connection)\b/,
  /^Timeout waiting for message\b/,
  /^Ping timed out\b/,
  /^Daemon client (?:closed|is disconnected|is disposed)\b/,
  /^Reconnect to an active thread\b/,
];

// Daemon RPC errors append wire diagnostics after the host's message.
const RPC_DIAGNOSTIC_SUFFIX = /\s+requestType=\S+(?:\s+code=\S+)?$|\s+code=\S+$/;

function rawMessage(error: unknown): string {
  if (error instanceof Error) {
    const userMessage = (error as { userMessage?: unknown }).userMessage;
    return typeof userMessage === "string" && userMessage.trim() ? userMessage : error.message;
  }
  return String(error);
}

/** True when the error describes a lost or unavailable host connection. */
export function isConnectionError(error: unknown): boolean {
  if (error instanceof DaemonConnectionError) return true;
  const message = rawMessage(error)
    .replace(/^Error:\s*/, "")
    .trim();
  return CONNECTION_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

/** The message to show the owner: connection failures read plainly and wire diagnostics are dropped. */
export function toErrorMessage(error: unknown): string {
  if (isConnectionError(error)) return i18n.t("common.errors.hostConnectionLost");
  return rawMessage(error).replace(RPC_DIAGNOSTIC_SUFFIX, "").trim();
}
