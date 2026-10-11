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
  read(): Promise<SidebarStateSnapshot>;
  change(change: SidebarStateChange): Promise<SidebarStateSnapshot>;
  readLocal(): SidebarState;
  applyLocal(state: SidebarState): void;
  loadPending(): Promise<SidebarStatePatch[]>;
  savePending(patches: SidebarStatePatch[]): Promise<void>;
  status(status: SidebarSyncStatus, error?: string): void;
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
    this.loaded = ports.loadPending().then((pending) => {
      this.pending = [...pending, ...this.pending];
      return undefined;
    });
  }

  stop(): void {
    this.stopped = true;
  }

  record(patch: SidebarStatePatch): void {
    this.pending.push(patch);
    this.ports.status("syncing");
    this.persist();
    void this.refresh();
  }

  private persist(): void {
    this.dirty = true;
    // Snapshot after loading the outbox so early clicks cannot discard retained edits.
    this.persistence = this.persistence
      .catch(() => undefined)
      .then(async () => {
        await this.loaded;
        const patches = [...this.pending];
        await this.ports.savePending(patches);
        if (
          patches.length === this.pending.length &&
          patches.every((patch, index) => patch === this.pending[index])
        )
          this.dirty = false;
        return undefined;
      });
  }

  private accept(snapshot: SidebarStateSnapshot): void {
    if (this.stopped || snapshot.state === null || snapshot.revision <= this.revision) return;
    this.revision = snapshot.revision;
    const state = this.pending.reduce(applySidebarStatePatch, snapshot.state);
    this.ports.applyLocal(state);
  }

  refresh(): Promise<void> {
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
      const count = this.pending.length;
      const patch = this.pending.reduce(mergeSidebarStatePatch, {});
      snapshot = await this.ports.change({ type: "patch", patch });
      this.pending.splice(0, count);
      this.persist();
      await this.persistence;
      this.accept(snapshot);
    }
    if (!this.stopped) this.ports.status("synced");
  }
}
