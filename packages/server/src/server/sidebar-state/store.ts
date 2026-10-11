import { readFile } from "node:fs/promises";
import {
  SidebarStateSnapshotSchema,
  applySidebarStatePatch,
  emptySidebarState,
  type SidebarStateChange,
  type SidebarStateSnapshot,
} from "@getpaseo/protocol/sidebar-state";
import { writeJsonFileAtomic } from "../atomic-file.js";

/** One daemon-owned writer serializes edits from every authenticated client. */
export class SidebarStateStore {
  private pending: Promise<unknown> = Promise.resolve();
  constructor(private readonly file: string) {}

  async read(): Promise<SidebarStateSnapshot> {
    await this.pending;
    return this.load();
  }

  private async load(): Promise<SidebarStateSnapshot> {
    try {
      return SidebarStateSnapshotSchema.parse(JSON.parse(await readFile(this.file, "utf8")));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return { revision: 0, state: null };
      throw error;
    }
  }

  change(change: SidebarStateChange): Promise<SidebarStateSnapshot> {
    const operation = this.pending.then(async () => {
      const previous = await this.load();
      if (change.type === "initialize" && previous.state !== null) return previous;
      const patch = change.type === "initialize" ? change.state : change.patch;
      const state = applySidebarStatePatch(previous.state ?? emptySidebarState(), patch);
      if (JSON.stringify(state) === JSON.stringify(previous.state)) return previous;
      const next = { revision: previous.revision + 1, state };
      await writeJsonFileAtomic(this.file, next);
      return next;
    });
    this.pending = operation.catch(() => undefined);
    return operation;
  }
}
