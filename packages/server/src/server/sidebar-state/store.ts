import { copyFile, readFile } from "node:fs/promises";
import type { Logger } from "pino";
import {
  SidebarStateSnapshotSchema,
  applySidebarStatePatch,
  emptySidebarState,
  SidebarStateSchema,
  type SidebarStateChange,
  type SidebarStateSnapshot,
} from "@getpaseo/protocol/sidebar-state";
import { writeJsonFileAtomic } from "../atomic-file.js";
import { toLogicalProjectKey, type ProjectsFolderConfig } from "../projects-folder.js";
import { rewriteSidebarStateProjectKeys } from "./projects-folder-keys.js";

export interface SidebarStateStoreOptions {
  /** Saved project keys under one of its aliases move to the logical root when the store opens. */
  projectsFolder?: Pick<ProjectsFolderConfig, "root" | "aliases" | "keepPaths">;
  logger?: Pick<Logger, "info" | "warn">;
  now?: () => Date;
}

/** One daemon-owned writer serializes edits from every authenticated client. */
export class SidebarStateStore {
  private pending: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly file: string,
    private readonly options: SidebarStateStoreOptions = {},
  ) {
    // Queued first, so every read and change sees the rewritten keys.
    if (options.projectsFolder?.aliases.length) {
      this.pending = this.moveProjectKeysIntoProjectsFolder().catch((error: unknown) => {
        options.logger?.warn(
          { err: error },
          "Could not move sidebar project keys into the Projects folder",
        );
      });
    }
  }

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

  /**
   * Rewrites saved project keys under a Projects folder alias to the logical root, after
   * copying the file to `*.before-projects-folder-<time>`. Idempotent: once no key uses an
   * alias it changes nothing.
   */
  private async moveProjectKeysIntoProjectsFolder(): Promise<void> {
    const folder = this.options.projectsFolder;
    if (!folder) return;
    const previous = await this.load();
    if (!previous.state) return;
    const rewritten = rewriteSidebarStateProjectKeys(previous.state, (key) =>
      toLogicalProjectKey(folder, key),
    );
    if (!rewritten) return;
    const state = SidebarStateSchema.parse(rewritten);
    const stamp = (this.options.now?.() ?? new Date()).toISOString().replace(/[:.]/gu, "-");
    const backup = `${this.file}.before-projects-folder-${stamp}`;
    await copyFile(this.file, backup);
    await writeJsonFileAtomic(this.file, { revision: previous.revision + 1, state });
    this.options.logger?.info(
      { backup, root: folder.root },
      "Moved sidebar project keys into the Projects folder",
    );
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
