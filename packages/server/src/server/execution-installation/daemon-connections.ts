import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { ExecutionEnvironmentKind } from "@getpaseo/protocol/execution-installation";

/** The parts of a daemon client the shared connections manage. */
export type SharedDaemonClient = Pick<DaemonClient, "close" | "getConnectionState">;

export interface InstallationDaemonConnections<Client extends SharedDaemonClient> {
  /** Borrow the environment's shared connection. `close()` on the returned
   * client ends only this lease; the connection stays open for other passes. */
  connect(kind: ExecutionEnvironmentKind): Promise<Client>;
  close(): void;
}

interface SharedConnection<Client> {
  client: Promise<Client>;
  leases: number;
  timer?: NodeJS.Timeout;
}

/**
 * Shares one connection per environment between the coordinator's periodic
 * settings and profile passes. Each fresh connection makes the daemon run a
 * full hello and session sync; with passes every five seconds the coordinator
 * opened about 1.4 Host connections a second on 2026-10-22. A dropped
 * connection is replaced on the next use, and an unused one closes after
 * `idleMs`. Restart and update paths keep their own fresh connections, since
 * they must observe a new daemon instance.
 */
export function createInstallationDaemonConnections<Client extends SharedDaemonClient>(
  open: (kind: ExecutionEnvironmentKind) => Promise<Client>,
  { idleMs = 60_000 }: { idleMs?: number } = {},
): InstallationDaemonConnections<Client> {
  const shared = new Map<ExecutionEnvironmentKind, SharedConnection<Client>>();

  function retire(kind: ExecutionEnvironmentKind, entry: SharedConnection<Client>): void {
    clearTimeout(entry.timer);
    if (shared.get(kind) === entry) shared.delete(kind);
    void entry.client.then(
      (client) => client.close(),
      () => undefined,
    );
  }

  function lease(
    kind: ExecutionEnvironmentKind,
    entry: SharedConnection<Client>,
    client: Client,
  ): Client {
    let released = false;
    async function release(): Promise<void> {
      if (released) return;
      released = true;
      entry.leases -= 1;
      if (client.getConnectionState().status !== "connected") {
        retire(kind, entry);
        return;
      }
      if (entry.leases > 0 || shared.get(kind) !== entry) return;
      entry.timer = setTimeout(() => {
        if (entry.leases === 0) retire(kind, entry);
      }, idleMs);
      entry.timer.unref();
    }
    return new Proxy(client, {
      get(target, property) {
        if (property === "close") return release;
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  async function connect(kind: ExecutionEnvironmentKind): Promise<Client> {
    for (;;) {
      let entry = shared.get(kind);
      const fresh = !entry;
      if (!entry) {
        entry = { client: open(kind), leases: 0 };
        shared.set(kind, entry);
      }
      entry.leases += 1;
      clearTimeout(entry.timer);
      let client: Client;
      try {
        client = await entry.client;
      } catch (error) {
        entry.leases -= 1;
        if (shared.get(kind) === entry) shared.delete(kind);
        throw error;
      }
      if (client.getConnectionState().status === "connected") return lease(kind, entry, client);
      entry.leases -= 1;
      retire(kind, entry);
      if (fresh) throw new Error("Installation daemon connection closed before use");
    }
  }

  return {
    connect,
    close() {
      for (const [kind, entry] of shared) retire(kind, entry);
    },
  };
}
