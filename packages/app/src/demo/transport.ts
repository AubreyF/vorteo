import type { DaemonTransport } from "@getpaseo/client/internal/daemon-client";
import { DemoSession } from "./session";

export function createDemoTransport(session: DemoSession): DaemonTransport {
  const messages = new Set<(data: unknown, binary: boolean) => void>();
  const openings = new Set<() => void>();
  const closings = new Set<(event?: unknown) => void>();
  const errors = new Set<(event?: unknown) => void>();
  let closed = false;
  const connection = session.connect((response) => {
    if (!closed) for (const listener of messages) listener(JSON.stringify(response), false);
  });
  queueMicrotask(() => {
    if (!closed) for (const listener of openings) listener();
  });
  return {
    send(data) {
      if (closed) return;
      queueMicrotask(() => {
        if (closed) return;
        try {
          if (typeof data !== "string")
            throw new Error("Demo accepts JSON protocol messages only.");
          for (const response of connection.receive(JSON.parse(data))) {
            for (const listener of messages) listener(JSON.stringify(response), false);
          }
        } catch (error) {
          for (const listener of errors) listener(error);
        }
      });
    },
    close() {
      if (closed) return;
      closed = true;
      connection.close();
      for (const listener of closings) listener();
      messages.clear();
      openings.clear();
      closings.clear();
      errors.clear();
    },
    onMessage(listener) {
      messages.add(listener);
      return () => {
        messages.delete(listener);
      };
    },
    onOpen(listener) {
      openings.add(listener);
      return () => {
        openings.delete(listener);
      };
    },
    onClose(listener) {
      closings.add(listener);
      return () => {
        closings.delete(listener);
      };
    },
    onError(listener) {
      errors.add(listener);
      return () => {
        errors.delete(listener);
      };
    },
  };
}
