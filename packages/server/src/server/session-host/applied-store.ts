import { randomUUID } from "node:crypto";
import { readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { preparePrivateDirectory, type SessionHostPaths } from "./host-files.js";

const FILE_MODE = 0o600;

const AppliedRecordSchema = z
  .object({
    /** The host run whose seqs these are; another host's seqs mean nothing. */
    hostId: z.string().min(1).max(200),
    lastAppliedSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
export type AppliedRecord = z.infer<typeof AppliedRecordSchema>;

/**
 * For each hosted agent, the last event this worker applied. A later worker rebuilds the timeline
 * from events up to it and applies only later events live, so nothing is shown twice. Each record
 * is written before the host is told the events were applied.
 */
export interface AppliedSeqStore {
  write(agentId: string, record: AppliedRecord): Promise<void>;
  read(agentId: string): Promise<AppliedRecord | null>;
  remove(agentId: string): Promise<void>;
  list(): Promise<Map<string, AppliedRecord>>;
}

/** Agent ids become file names, so they are encoded rather than trusted as paths. */
function fileName(agentId: string): string {
  return `${Buffer.from(agentId, "utf8").toString("base64url")}.json`;
}

function agentIdFromFile(file: string): string | null {
  if (!file.endsWith(".json") || file.startsWith(".")) return null;
  return Buffer.from(file.slice(0, -".json".length), "base64url").toString("utf8");
}

export function createAppliedSeqStore(paths: SessionHostPaths): AppliedSeqStore {
  const directory = path.join(paths.directory, "applied");
  /** Writes for one agent run in order, so an older seq never replaces a newer one. */
  const queues = new Map<string, Promise<void>>();
  let prepared: Promise<void> | null = null;

  function prepare(): Promise<void> {
    prepared ??= preparePrivateDirectory(paths.directory)
      .then(() => preparePrivateDirectory(directory))
      .catch((error: unknown) => {
        prepared = null;
        throw error;
      });
    return prepared;
  }

  function enqueue(agentId: string, task: () => Promise<void>): Promise<void> {
    const next = (queues.get(agentId) ?? Promise.resolve()).catch(() => {}).then(task);
    queues.set(agentId, next);
    return next.finally(() => {
      if (queues.get(agentId) === next) queues.delete(agentId);
    });
  }

  async function read(agentId: string): Promise<AppliedRecord | null> {
    let raw: string;
    try {
      raw = await readFile(path.join(directory, fileName(agentId)), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    try {
      const parsed = AppliedRecordSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  return {
    write(agentId, record) {
      return enqueue(agentId, async () => {
        await prepare();
        const target = path.join(directory, fileName(agentId));
        const temporary = path.join(directory, `.${process.pid}.${randomUUID()}.tmp`);
        try {
          await writeFile(temporary, JSON.stringify(AppliedRecordSchema.parse(record)), {
            mode: FILE_MODE,
            flag: "wx",
          });
          await rename(temporary, target);
        } finally {
          await rm(temporary, { force: true });
        }
      });
    },
    read,
    remove(agentId) {
      return enqueue(agentId, () => rm(path.join(directory, fileName(agentId)), { force: true }));
    },
    async list() {
      const records = new Map<string, AppliedRecord>();
      let files: string[];
      try {
        files = await readdir(directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return records;
        throw error;
      }
      for (const file of files) {
        const agentId = agentIdFromFile(file);
        if (!agentId) continue;
        const record = await read(agentId);
        if (record) records.set(agentId, record);
      }
      return records;
    },
  };
}
