import { constants } from "node:fs";
import { lstat, mkdir, open, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import {
  OPERATIONAL_INTERVAL_MS,
  OPERATIONAL_RECORD_BYTES,
  retainedOperationalMinute,
  serializeOperationalRecord,
  type OperationalRecordInput,
} from "./operational-telemetry-record.js";

export const OPERATIONAL_SLOT_COUNT = 48;
export const OPERATIONAL_SLOT_BYTES = 256 * 1024;
const HOUR_MS = 60 * OPERATIONAL_INTERVAL_MS;
const HEADER_BYTES = 128;

export type OperationalAppendResult = "written" | "already_sampled" | "capacity";

export interface OperationalWriter {
  append(input: OperationalRecordInput): Promise<OperationalAppendResult>;
}

export class OperationalStoreError extends Error {
  constructor(
    readonly code: "unsafe_directory" | "unsafe_slot" | "invalid_slot" | "clock_rollback",
  ) {
    super("Private operational telemetry storage is unavailable.");
    this.name = "OperationalStoreError";
  }
}

interface SlotState {
  hour: number;
  lastMinute: number | null;
}

interface OpenSlot {
  file: FileHandle;
  created: boolean;
}

function filesystemCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function header(hour: number): string {
  return JSON.stringify({ format: "vorteo-operational-slot-v1", hour }) + "\n";
}

async function prepareDirectory(directory: string): Promise<void> {
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (!filesystemCode(error, "EEXIST")) throw error;
  }
  const info = await lstat(directory);
  const privateMode = process.platform === "win32" || (info.mode & 0o777) === 0o700;
  const owned = !process.getuid || info.uid === process.getuid();
  if (!info.isDirectory() || info.isSymbolicLink() || !privateMode || !owned)
    throw new OperationalStoreError("unsafe_directory");
}

async function openSlot(path: string): Promise<OpenSlot> {
  const flags = constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  try {
    const file = await open(path, flags | constants.O_CREAT | constants.O_EXCL, 0o600);
    return { file, created: true };
  } catch (error) {
    if (!filesystemCode(error, "EEXIST")) throw error;
    const file = await open(path, flags);
    return { file, created: false };
  }
}

async function inspectSlot(opened: OpenSlot, slot: number): Promise<SlotState | null> {
  const { file, created } = opened;
  const info = await file.stat();
  const privateMode = process.platform === "win32" || (info.mode & 0o777) === 0o600;
  const owned = !process.getuid || info.uid === process.getuid();
  const boundedSize = info.size >= 0 && info.size <= OPERATIONAL_SLOT_BYTES;
  if (!info.isFile() || info.nlink !== 1 || !privateMode || !owned || !boundedSize)
    throw new OperationalStoreError("unsafe_slot");
  if (info.size === 0 && created) return null;
  if (info.size === 0) throw new OperationalStoreError("invalid_slot");

  const prefix = Buffer.alloc(HEADER_BYTES);
  const first = await file.read(prefix, 0, HEADER_BYTES, 0);
  const firstLineEnd = prefix.indexOf(10, 0);
  if (firstLineEnd < 0 || firstLineEnd >= first.bytesRead)
    throw new OperationalStoreError("invalid_slot");
  const firstLine = prefix.subarray(0, firstLineEnd).toString("utf8");
  const match = /^\{"format":"vorteo-operational-slot-v1","hour":(\d+)\}$/.exec(firstLine);
  if (!match) throw new OperationalStoreError("invalid_slot");
  const hour = Number(match[1]);
  if (!Number.isSafeInteger(hour) || hour % OPERATIONAL_SLOT_COUNT !== slot)
    throw new OperationalStoreError("invalid_slot");
  const headerSize = firstLineEnd + 1;
  if (info.size === headerSize) return { hour, lastMinute: null };

  return inspectRetainedRecords(file, info.size, headerSize, hour);
}

async function inspectRetainedRecords(
  file: FileHandle,
  size: number,
  headerSize: number,
  hour: number,
): Promise<SlotState> {
  // The stat bound limits this read to 256 KiB. Checking the whole slot protects
  // unrelated or damaged middle content even when its header and tail look valid.
  const content = Buffer.alloc(size - headerSize);
  let offset = 0;
  while (offset < content.length) {
    const read = await file.read(content, offset, content.length - offset, headerSize + offset);
    if (read.bytesRead === 0) throw new OperationalStoreError("invalid_slot");
    offset += read.bytesRead;
  }
  if (content[content.length - 1] !== 10) throw new OperationalStoreError("invalid_slot");
  const lines = content.toString("utf8").split("\n");
  lines.pop();
  if (lines.length > 60) throw new OperationalStoreError("invalid_slot");
  let lastMinute: number | null = null;
  for (const line of lines) {
    if (Buffer.byteLength(line) + 1 > OPERATIONAL_RECORD_BYTES)
      throw new OperationalStoreError("invalid_slot");
    const minute = retainedOperationalMinute(line);
    if (
      minute === null ||
      Math.floor(minute / 60) !== hour ||
      (lastMinute !== null && minute <= lastMinute)
    )
      throw new OperationalStoreError("invalid_slot");
    lastMinute = minute;
  }
  return { hour, lastMinute };
}

/** Fixed slots bound retention without enumerating or deleting other host files. */
export function createOperationalStore(directory: string): OperationalWriter {
  let writing = false;
  return {
    async append(input) {
      if (writing) return "capacity";
      writing = true;
      let file: FileHandle | undefined;
      try {
        const line = serializeOperationalRecord(input);
        const hour = Math.floor(input.nowMs / HOUR_MS);
        const minute = Math.floor(input.nowMs / OPERATIONAL_INTERVAL_MS);
        const slot = hour % OPERATIONAL_SLOT_COUNT;
        const name = `minute-${String(slot).padStart(2, "0")}.jsonl`;
        await prepareDirectory(directory);
        const opened = await openSlot(join(directory, name));
        file = opened.file;
        const retained = await inspectSlot(opened, slot);
        if (retained && retained.hour > hour) throw new OperationalStoreError("clock_rollback");
        if (
          retained &&
          retained.hour === hour &&
          retained.lastMinute !== null &&
          retained.lastMinute >= minute
        )
          return "already_sampled";
        if (retained === null || retained.hour !== hour) {
          await file.truncate(0);
          await file.writeFile(header(hour), "utf8");
        }
        const info = await file.stat();
        if (info.size + Buffer.byteLength(line) > OPERATIONAL_SLOT_BYTES) return "capacity";
        // Explicit position also works after inspecting a retained file through this handle.
        const bytes = Buffer.from(line);
        let offset = 0;
        while (offset < bytes.length) {
          const result = await file.write(bytes, offset, bytes.length - offset, info.size + offset);
          if (result.bytesWritten === 0) throw new OperationalStoreError("invalid_slot");
          offset += result.bytesWritten;
        }
        return "written";
      } finally {
        try {
          await file?.close();
        } finally {
          writing = false;
        }
      }
    },
  };
}
