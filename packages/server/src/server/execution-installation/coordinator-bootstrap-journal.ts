import {
  closeSync,
  constants,
  fsyncSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  CoordinatorBootstrapRequestSchema,
  type CoordinatorBootstrapRequest,
} from "@getpaseo/protocol/coordinator-bootstrap";
import { writePrivateFileAtomicSync } from "../private-files.js";
import { BootstrapRequestConflict, type BootstrapRequestJournal } from "./coordinator-bootstrap.js";

const RecordsSchema = z.strictObject({
  version: z.literal(1),
  requests: z.array(CoordinatorBootstrapRequestSchema),
});

/** Owns only bootstrap requests, never the coordinator's restart journal. */
export class FileBootstrapRequestJournal implements BootstrapRequestJournal {
  private readonly file: string;
  private readonly lock: string;

  constructor(private readonly directory: string) {
    this.checkDirectory();
    this.file = path.join(directory, "coordinator-bootstrap.json");
    this.lock = path.join(directory, "coordinator-bootstrap.lock");
  }

  private checkDirectory(): void {
    const stat = lstatSync(this.directory);
    if (
      !process.getuid ||
      realpathSync(this.directory) !== this.directory ||
      !stat.isDirectory() ||
      stat.uid !== process.getuid() ||
      (stat.mode & 0o077) !== 0
    )
      throw new BootstrapRequestConflict(
        "Bootstrap storage must be a private owned canonical directory",
      );
  }

  read(): CoordinatorBootstrapRequest[] {
    this.checkDirectory();
    let fd: number;
    try {
      fd = openSync(this.file, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    try {
      const stat = fstatSync(fd);
      if (
        !stat.isFile() ||
        stat.uid !== process.getuid!() ||
        (stat.mode & 0o077) !== 0 ||
        stat.nlink !== 1
      )
        throw new BootstrapRequestConflict("Bootstrap journal is not a private owned file");
      return RecordsSchema.parse(JSON.parse(readFileSync(fd, "utf8"))).requests;
    } finally {
      closeSync(fd);
    }
  }

  replace(expected: CoordinatorBootstrapRequest[], next: CoordinatorBootstrapRequest[]): void {
    this.checkDirectory();
    let lock: number;
    try {
      lock = openSync(
        this.lock,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        throw new BootstrapRequestConflict(
          "Bootstrap storage is busy. Inspect its owner before recovery.",
        );
      throw error;
    }
    try {
      if (JSON.stringify(this.read()) !== JSON.stringify(expected))
        throw new BootstrapRequestConflict("Bootstrap request changed. Refresh its review.");
      writePrivateFileAtomicSync(
        this.file,
        JSON.stringify(RecordsSchema.parse({ version: 1, requests: next })),
      );
      for (const target of [this.file, this.directory]) {
        const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
      }
    } finally {
      const owned = fstatSync(lock);
      closeSync(lock);
      const current = lstatSync(this.lock);
      // Never remove a replacement lock belonging to another writer.
      if (owned.dev === current.dev && owned.ino === current.ino) unlinkSync(this.lock);
    }
  }
}
