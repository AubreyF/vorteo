import {
  applySidebarStatePatch,
  mergeSidebarStatePatch,
  type SidebarState,
  type SidebarStatePatch,
  type SidebarStateSnapshot,
  type SidebarStateChange,
} from "@getpaseo/protocol/sidebar-state";

export type SidebarSyncStatus = "loading" | "syncing" | "synced" | "pending";
export interface SidebarSyncPorts {
  pendingKey: string;
  read(): Promise<SidebarStateSnapshot>;
  change(change: SidebarStateChange): Promise<SidebarStateSnapshot>;
  readLocal(): SidebarState;
  applyLocal(state: SidebarState): void;
  loadPending(): Promise<SidebarStatePatch[]>;
  savePending(patches: SidebarStatePatch[]): Promise<void>;
  status(status: SidebarSyncStatus, error?: string): void;
}

// React effects can remount while an earlier AsyncStorage write is still running.
// Enqueue reads too: the next instance must load all pre-stop edits before saving.
const pendingStorage = new Map<string, Promise<void>>();

function withPendingStorage<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = pendingStorage.get(key) ?? Promise.resolve();
  const result = previous.then(operation);
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  pendingStorage.set(key, settled);
  void settled.then(() => {
    if (pendingStorage.get(key) === settled) pendingStorage.delete(key);
    return undefined;
  });
  return result;
}

export class SidebarSync {
  private pending: SidebarStatePatch[] = [];
  private persistence: Promise<void> = Promise.resolve();
  private readonly loaded: Promise<void>;
  private running: Promise<void> | null = null;
  private stopped = false;
  private dirty = false;
  private revision = -1;

  constructor(private readonly ports: SidebarSyncPorts) {
    this.loaded = withPendingStorage(ports.pendingKey, () => ports.loadPending()).then(
      (pending) => {
        this.pending = [...pending, ...this.pending];
        return undefined;
      },
    );
  }

  stop(): void {
    this.stopped = true;
  }

  record(patch: SidebarStatePatch): void {
    if (this.stopped) return;
    this.pending.push(patch);
    this.ports.status("syncing");
    this.persist();
    void this.refresh();
  }

  private persist(): void {
    this.dirty = true;
    // Snapshot after loading the outbox so early clicks cannot discard retained edits.
    // Reserve the shared queue slot synchronously, before a replacement can load.
    // Saves already queued at stop still persist edits recorded by this instance.
    this.persistence = withPendingStorage(this.ports.pendingKey, async () => {
      await this.loaded;
      const patches = [...this.pending];
      await this.ports.savePending(patches);
      if (
        patches.length === this.pending.length &&
        patches.every((patch, index) => patch === this.pending[index])
      )
        this.dirty = false;
    });
  }

  private accept(snapshot: SidebarStateSnapshot): void {
    if (this.stopped || snapshot.state === null || snapshot.revision <= this.revision) return;
    this.revision = snapshot.revision;
    const state = this.pending.reduce(applySidebarStatePatch, snapshot.state);
    this.ports.applyLocal(state);
  }

  refresh(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.running) return this.running;
    this.running = this.synchronize()
      .catch((error: unknown) => {
        if (!this.stopped)
          this.ports.status(
            "pending",
            error instanceof Error ? error.message : "Unable to sync sidebar.",
          );
      })
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }

  private async synchronize(): Promise<void> {
    await this.loaded;
    if (this.stopped) return;
    if (this.dirty) this.persist();
    await this.persistence;
    if (this.stopped) return;
    let snapshot = await this.ports.read();
    if (this.stopped) return;
    if (snapshot.state === null) {
      snapshot = await this.ports.change({ type: "initialize", state: this.ports.readLocal() });
    }
    this.accept(snapshot);
    while (!this.stopped && this.pending.length > 0) {
      this.ports.status("syncing");
      await this.persistence;
      if (this.stopped) return;
      const count = this.pending.length;
      const patch = this.pending.reduce(mergeSidebarStatePatch, {});
      snapshot = await this.ports.change({ type: "patch", patch });
      // The remote write may have succeeded. Keep its patch for replay rather
      // than letting an obsolete instance overwrite its successor's outbox.
      if (this.stopped) return;
      this.pending.splice(0, count);
      this.persist();
      await this.persistence;
      this.accept(snapshot);
    }
    if (!this.stopped) this.ports.status("synced");
  }
}
