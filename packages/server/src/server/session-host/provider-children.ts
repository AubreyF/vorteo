import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const FILE_MODE = 0o600;

/**
 * Provider processes the host spawned in their own process groups. Claude's CLI is a plain child
 * and dies with the host; Codex's app-server is detached and would survive a host that its watchdog
 * or a crash killed, then keep writing the thread a continued agent resumes elsewhere. The host
 * records those pids here and, at its next start, stops any that still run the recorded command.
 */
const ChildRecordSchema = z
  .object({
    pid: z.number().int().positive(),
    /** Words the process command line must all still contain before it is signalled. */
    markers: z.array(z.string().min(1).max(1_000)).min(1).max(4),
    agentId: z.string().max(500).optional(),
    spawnedAt: z.string().max(64),
  })
  .strict();
const ChildrenFileSchema = z.object({
  version: z.literal(1),
  children: z.array(ChildRecordSchema),
});
export type ChildRecord = z.infer<typeof ChildRecordSchema>;

export interface ChildRegistryPorts {
  /** The command line of a live process, or null when it is gone. */
  processCommand(pid: number): Promise<string | null>;
  /** Signals a pid, or a whole process group when pid is negative, as process.kill does. */
  kill(pid: number, signal: NodeJS.Signals): void;
  now(): Date;
}

export interface ProviderChildRegistry {
  /** Remembers a live child so a later host start can stop it if this host dies first. */
  record(record: Omit<ChildRecord, "spawnedAt">): Promise<void>;
  /** Drops a child that exited normally. */
  forget(pid: number): Promise<void>;
  /**
   * Stops every recorded process whose command line still carries all its markers, then forgets
   * all. The process was detached into its own group, so the group is signalled first and the
   * tools it spawned go with it; a process that is not a group leader is signalled alone.
   * Returns what was stopped; processes already gone or reused by something else are only dropped.
   */
  reapOrphans(): Promise<{ stopped: ChildRecord[]; dropped: ChildRecord[] }>;
}

export const PROVIDER_CHILDREN_FILE_NAME = "children.json";

function defaultProcessCommand(pid: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "/bin/ps",
      ["-o", "command=", "-p", String(pid)],
      { timeout: 5_000 },
      (error, stdout) => resolve(error ? null : String(stdout).trim() || null),
    );
  });
}

export function createProviderChildRegistry(
  directory: string,
  ports: Partial<ChildRegistryPorts> = {},
): ProviderChildRegistry {
  const file = path.join(directory, PROVIDER_CHILDREN_FILE_NAME);
  const processCommand = ports.processCommand ?? defaultProcessCommand;
  const kill = ports.kill ?? ((pid, signal) => process.kill(pid, signal));
  const now = ports.now ?? (() => new Date());
  /** Writes for the file run in order, so a forget never resurrects a record. */
  let queue: Promise<void> = Promise.resolve();

  async function read(): Promise<ChildRecord[]> {
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    try {
      return ChildrenFileSchema.parse(JSON.parse(raw)).children;
    } catch {
      // A corrupt file cannot name anything to stop; start over rather than fail the host.
      return [];
    }
  }

  async function write(children: ChildRecord[]): Promise<void> {
    const temporary = path.join(directory, `.${PROVIDER_CHILDREN_FILE_NAME}.${randomUUID()}`);
    try {
      await writeFile(temporary, JSON.stringify({ version: 1, children }), {
        mode: FILE_MODE,
        flag: "wx",
      });
      await rename(temporary, file);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  /** Kills the group when the pid leads one, else the pid alone; false when it is already gone. */
  function signalTree(pid: number): boolean {
    try {
      kill(-pid, "SIGKILL");
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false;
    }
    try {
      kill(pid, "SIGKILL");
      return true;
    } catch {
      return false;
    }
  }

  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = queue.then(task, task);
    // The chain only orders work; a failed task must not block the ones after it.
    queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  return {
    record(record) {
      return enqueue(async () => {
        const children = (await read()).filter((item) => item.pid !== record.pid);
        children.push({ ...record, spawnedAt: now().toISOString() });
        await write(children);
      });
    },
    forget(pid) {
      return enqueue(async () => {
        const children = await read();
        const remaining = children.filter((item) => item.pid !== pid);
        if (remaining.length !== children.length) await write(remaining);
      });
    },
    reapOrphans() {
      return enqueue(async () => {
        const stopped: ChildRecord[] = [];
        const dropped: ChildRecord[] = [];
        for (const child of await read()) {
          const command = await processCommand(child.pid);
          // The markers guard against a reused pid: only the recorded program is ever signalled.
          if (command && child.markers.every((marker) => command.includes(marker))) {
            if (signalTree(child.pid)) {
              stopped.push(child);
              continue;
            }
          }
          dropped.push(child);
        }
        if (stopped.length || dropped.length) await write([]);
        return { stopped, dropped };
      });
    },
  };
}
