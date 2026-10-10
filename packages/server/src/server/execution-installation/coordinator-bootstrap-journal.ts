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
  linkSync,
  readSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
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

const PendingSchema = z.strictObject({
  version: z.literal(1),
  requests: z.array(CoordinatorBootstrapRequestSchema),
  // Retain the entire pre-promotion claim. This survives either side of the
  // main-file rename and authenticates stale sidecar copies after later progress.
  promotions: z.array(CoordinatorBootstrapRequestSchema),
});

/** Owns only bootstrap requests, never the coordinator's restart journal. */
export class FileBootstrapRequestJournal implements BootstrapRequestJournal {
  private readonly file: string;
  private readonly lock: string;
  private readonly pendingFile: string;

  constructor(private readonly directory: string) {
    this.checkDirectory();
    this.file = path.join(directory, "coordinator-bootstrap.json");
    this.lock = path.join(directory, "coordinator-bootstrap.lock");
    this.pendingFile = path.join(directory, "coordinator-bootstrap-pending.json");
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

  private readFile(file: string): unknown {
    this.checkDirectory();
    let fd: number;
    try {
      fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
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
      return JSON.parse(readFileSync(fd, "utf8"));
    } finally {
      closeSync(fd);
    }
  }

  private snapshots() {
    const main = RecordsSchema.parse(this.readFile(this.file) ?? { version: 1, requests: [] });
    const pending = PendingSchema.parse(
      this.readFile(this.pendingFile) ?? { version: 1, requests: [], promotions: [] },
    );
    for (const records of [main.requests, pending.requests, pending.promotions]) {
      if (new Set(records.map((record) => record.id)).size !== records.length)
        throw new BootstrapRequestConflict("Duplicate bootstrap storage identity");
    }
    for (const intent of pending.promotions) {
      const source = pending.requests.find((record) => record.id === intent.id);
      const promoted = main.requests.find((record) => record.id === intent.id);
      if (!intent.execution || intent.execution.stage !== "claimed" || intent.status !== "approved")
        throw new BootstrapRequestConflict("Invalid bootstrap promotion intent");
      if (source && !isDeepStrictEqual(source, intent))
        throw new BootstrapRequestConflict("Bootstrap promotion source changed");
      if (!source && !promoted)
        throw new BootstrapRequestConflict("Bootstrap promotion evidence is missing");
      if (promoted) this.verifyPromotion(intent, promoted);
    }
    for (const source of pending.requests) {
      if (
        main.requests.some((record) => record.id === source.id) &&
        !pending.promotions.some((record) => record.id === source.id)
      )
        throw new BootstrapRequestConflict("Unverified duplicate bootstrap promotion");
    }
    return { main, pending };
  }

  private verifyPromotion(
    source: CoordinatorBootstrapRequest,
    current: CoordinatorBootstrapRequest,
  ) {
    if (!current.execution || current.execution.generation !== source.execution?.generation)
      throw new BootstrapRequestConflict("Bootstrap promotion generation changed");
    // Only execution progress and its revision may differ. In particular, this
    // preserves decisionAt, reason, plan digest, recovered ancestry and every plan field.
    const normalized = { ...current, revision: source.revision, execution: source.execution };
    if (
      !isDeepStrictEqual(normalized, source) ||
      (current.execution.stage === "claimed" && !isDeepStrictEqual(current, source))
    )
      throw new BootstrapRequestConflict("Bootstrap promotion record changed");
  }

  read(): CoordinatorBootstrapRequest[] {
    const { main, pending } = this.snapshots();
    const mainIds = new Set(main.requests.map((record) => record.id));
    return [...main.requests, ...pending.requests.filter((record) => !mainIds.has(record.id))];
  }

  /** Startup authority comes only from the promoted main journal. */
  readPromoted(): CoordinatorBootstrapRequest[] {
    return this.snapshots().main.requests;
  }

  private write(file: string, value: unknown): void {
    writePrivateFileAtomicSync(file, JSON.stringify(value));
    for (const target of [file, this.directory]) {
      const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
  }

  promote(request: CoordinatorBootstrapRequest): void {
    this.withLock(() => {
      const { main, pending } = this.snapshots();
      const retained = main.requests.find((record) => record.id === request.id);
      const intent = pending.promotions.find((record) => record.id === request.id);
      if (retained) {
        if (!intent) throw new BootstrapRequestConflict("Bootstrap promotion intent is missing");
        this.verifyPromotion(intent, retained);
        if (!isDeepStrictEqual(retained, request))
          throw new BootstrapRequestConflict("Bootstrap promotion ownership changed");
        // Reconcile an uncertain previous fsync before allowing lifecycle effects.
        this.write(this.file, main);
        return;
      }
      const source = pending.requests.find((record) => record.id === request.id);
      if (
        !source ||
        !isDeepStrictEqual(source, request) ||
        source.status !== "approved" ||
        source.execution?.stage !== "claimed" ||
        source.plan.automaticRecovery !== "restore-compatible" ||
        !source.plan.compatibleRecovery
      )
        throw new BootstrapRequestConflict("Exact protected bootstrap claim required");
      if (!intent)
        this.write(this.pendingFile, {
          ...pending,
          promotions: [...pending.promotions, source],
        });
      // No lifecycle effect is permitted until this replacement and directory fsync return.
      this.write(this.file, { ...main, requests: [...main.requests, source] });
    });
  }

  replace(expected: CoordinatorBootstrapRequest[], next: CoordinatorBootstrapRequest[]): void {
    this.withLock(() => {
      if (!isDeepStrictEqual(this.read(), expected))
        throw new BootstrapRequestConflict("Bootstrap request changed. Refresh its review.");
      const { main, pending } = this.snapshots();
      const parsed = RecordsSchema.parse({ version: 1, requests: next });
      const mainIds = new Set(main.requests.map((record) => record.id));
      for (const intent of pending.promotions) {
        if (!mainIds.has(intent.id))
          throw new BootstrapRequestConflict("Bootstrap promotion requires reconciliation");
      }
      const nextMain = parsed.requests.filter(
        (record) =>
          mainIds.has(record.id) || record.plan.automaticRecovery !== "restore-compatible",
      );
      const nextPending = parsed.requests.filter(
        (record) =>
          !mainIds.has(record.id) && record.plan.automaticRecovery === "restore-compatible",
      );
      for (const intent of pending.promotions) {
        const retained = nextMain.find((record) => record.id === intent.id);
        if (!retained)
          throw new BootstrapRequestConflict("Promoted bootstrap history cannot be removed");
        this.verifyPromotion(intent, retained);
      }
      const mainChanged = !isDeepStrictEqual(main.requests, nextMain);
      const pendingChanged = !isDeepStrictEqual(pending.requests, nextPending);
      // One request mutation has one authority file. Stale duplicate cleanup is
      // unnecessary; retained promotion evidence makes main authoritative forever.
      if (mainChanged) {
        const retainedPending = pending.requests.filter((record) => !mainIds.has(record.id));
        if (!isDeepStrictEqual(retainedPending, nextPending))
          throw new BootstrapRequestConflict("Bootstrap mutation crosses journal authority");
        this.write(this.file, { version: 1, requests: nextMain });
      } else if (pendingChanged) {
        this.write(this.pendingFile, { ...pending, requests: nextPending });
      }
    });
  }

  private withLock(operation: () => void): void {
    this.checkDirectory();
    const lock = this.openLock();
    try {
      this.acquireLock(lock);
      const owned = fstatSync(lock);
      const current = lstatSync(this.lock);
      if (
        !owned.isFile() ||
        owned.uid !== process.getuid!() ||
        (owned.mode & 0o077) !== 0 ||
        owned.dev !== current.dev ||
        owned.ino !== current.ino ||
        owned.size > 512
      )
        throw new BootstrapRequestConflict("Bootstrap journal lock identity changed");
      const bytes = Buffer.alloc(owned.size);
      readSync(lock, bytes, 0, bytes.length, 0);
      let marker: { version: 1; temporary: string };
      try {
        marker = z
          .strictObject({
            version: z.literal(1),
            temporary: z.string().regex(/^\.coordinator-bootstrap-lock-[a-f0-9-]{36}$/),
          })
          .parse(JSON.parse(bytes.toString("utf8")));
      } catch {
        // Legacy O_EXCL writers use the same path. Never remove their lock or
        // assume they participate in flock. They refuse this permanent inode.
        throw new BootstrapRequestConflict(
          "Bootstrap storage is busy: legacy journal lock requires owner reconciliation",
        );
      }
      const temporary = path.join(this.directory, marker.temporary);
      try {
        const retained = lstatSync(temporary);
        if (retained.dev !== owned.dev || retained.ino !== owned.ino)
          throw new BootstrapRequestConflict("Bootstrap lock publication identity changed");
        unlinkSync(temporary);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
      if (fstatSync(lock).nlink !== 1)
        throw new BootstrapRequestConflict("Bootstrap lock has unexpected links");
      const directory = openSync(this.directory, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
      operation();
    } finally {
      // flock belongs to this inherited open file description. Closing the
      // parent's descriptor, including process death, releases it automatically.
      closeSync(lock);
    }
  }

  private acquireLock(descriptor: number): void {
    try {
      // Python is already a native bootstrap dependency. Passing descriptor 3
      // shares its open file description, so the parent retains flock after the
      // helper exits. No service operation or credential enters this helper.
      execFileSync(
        "/usr/bin/python3",
        ["-I", "-B", "-c", "import fcntl; fcntl.flock(3, fcntl.LOCK_EX | fcntl.LOCK_NB)"],
        { stdio: ["ignore", "ignore", "pipe", descriptor], timeout: 5000 },
      );
    } catch {
      throw new BootstrapRequestConflict(
        "Bootstrap storage is busy. Refresh after its writer settles.",
      );
    }
  }

  private openLock(): number {
    try {
      return openSync(this.lock, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    // Publish a fully initialized, already locked inode without replacing any
    // legacy lock. If killed between link and unlink, the next owner removes
    // only the exact extra link named in the protected marker.
    const basename = `.coordinator-bootstrap-lock-${randomUUID()}`;
    const temporary = path.join(this.directory, basename);
    const descriptor = openSync(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
      0o600,
    );
    let published = false;
    try {
      writeFileSync(descriptor, JSON.stringify({ version: 1, temporary: basename }));
      fsyncSync(descriptor);
      this.acquireLock(descriptor);
      try {
        linkSync(temporary, this.lock);
        published = true;
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      }
      if (published) return descriptor;
    } finally {
      if (!published) {
        closeSync(descriptor);
        unlinkSync(temporary);
      }
    }
    return openSync(this.lock, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  }
}
