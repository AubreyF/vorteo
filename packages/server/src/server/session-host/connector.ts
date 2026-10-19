import type { Logger } from "pino";
import {
  connectSessionHost,
  SessionHostClientError,
  type ConnectSessionHostOptions,
  type SessionHostClient,
} from "./client.js";
import { readSessionHostToken, type SessionHostPaths } from "./host-files.js";

export interface SessionHostConnector {
  /** The live connection, connecting first when needed. Null when no usable host answers. */
  connect(): Promise<SessionHostClient | null>;
  /** The live connection, without connecting. */
  current(): SessionHostClient | null;
  close(): void;
}

export interface SessionHostConnectorOptions {
  paths: SessionHostPaths;
  logger: Logger;
  /** Reported to the host audit log. */
  release?: string;
  /** After a failed attempt, callers get null without a new attempt for this long. */
  retryAfterMs?: number;
  connectTimeoutMs?: number;
  now?: () => number;
  /** Test seam. */
  connect?: (options: ConnectSessionHostOptions) => Promise<SessionHostClient>;
}

/**
 * Owns the worker's single connection to the session host. The token is read again for every
 * attempt, because each host start rotates it. A worker never waits long on an absent host:
 * failures return null so the caller can run the session locally.
 */
export function createSessionHostConnector(
  options: SessionHostConnectorOptions,
): SessionHostConnector {
  const connect = options.connect ?? connectSessionHost;
  const now = options.now ?? Date.now;
  const retryAfterMs = options.retryAfterMs ?? 5_000;
  let client: SessionHostClient | null = null;
  let attempt: Promise<SessionHostClient | null> | null = null;
  let lastFailureAt: number | null = null;
  let closed = false;

  async function open(): Promise<SessionHostClient | null> {
    try {
      const token = await readSessionHostToken(options.paths);
      const connected = await connect({
        socketPath: options.paths.socketPath,
        token,
        release: options.release,
        connectTimeoutMs: options.connectTimeoutMs,
      });
      if (closed) {
        connected.close();
        return null;
      }
      client = connected;
      lastFailureAt = null;
      options.logger.info({ hostId: connected.host.id }, "Connected to the session host");
      connected.onClose((error) => {
        if (client === connected) client = null;
        if (!closed) options.logger.warn({ code: error.code }, "Session host connection ended");
      });
      return connected;
    } catch (error) {
      lastFailureAt = now();
      options.logger.warn(
        {
          code:
            error instanceof SessionHostClientError
              ? error.code
              : ((error as NodeJS.ErrnoException).code ?? "unknown"),
        },
        "Session host is unavailable; sessions run in the worker",
      );
      return null;
    }
  }

  return {
    async connect() {
      if (closed) return null;
      if (client?.closed) client = null;
      if (client) return client;
      if (attempt) return attempt;
      if (lastFailureAt !== null && now() - lastFailureAt < retryAfterMs) return null;
      attempt = open().finally(() => {
        attempt = null;
      });
      return attempt;
    },
    current: () => client,
    close() {
      closed = true;
      client?.close();
      client = null;
    },
  };
}
