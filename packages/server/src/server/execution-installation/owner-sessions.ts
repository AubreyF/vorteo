import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, openSync, fsyncSync, closeSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { writePrivateFileAtomicSync } from "../private-files.js";

export const OwnerSessionsSchema = z.array(
  z.strictObject({ hash: z.string(), expiresAt: z.number() }),
);
export const OWNER_SESSION_MAX_AGE = 7 * 24 * 60 * 60;

/** Persist only token hashes. Expiry is absolute, so polling cannot prolong owner access. */
export class OwnerSessions {
  constructor(
    private readonly file: string,
    private readonly now = Date.now,
  ) {}

  private read() {
    return (
      existsSync(this.file)
        ? OwnerSessionsSchema.parse(JSON.parse(readFileSync(this.file, "utf8")))
        : []
    ).filter((session) => session.expiresAt > this.now());
  }

  private hash(token: string, origin?: string): string {
    // Preserve existing public session hashes and the strict retained record schema.
    const value = origin === undefined ? token : JSON.stringify([origin, token]);
    return createHash("sha256").update(value).digest("hex");
  }

  private write(sessions: z.infer<typeof OwnerSessionsSchema>): void {
    writePrivateFileAtomicSync(this.file, JSON.stringify(sessions));
    // Windows requires a writable handle for FlushFileBuffers and does not
    // support opening directories through this API. POSIX also syncs the rename.
    const targets =
      process.platform === "win32" ? [this.file] : [this.file, path.dirname(this.file)];
    for (const target of targets) {
      const fd = openSync(target, target === this.file ? "r+" : "r");
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
  }

  create(origin?: string): string {
    const token = randomBytes(32).toString("base64url");
    const sessions = this.read();
    sessions.push({
      hash: this.hash(token, origin),
      expiresAt: this.now() + OWNER_SESSION_MAX_AGE * 1000,
    });
    this.write(sessions);
    return token;
  }

  expiresAt(token: string | undefined, origin?: string): string | null {
    if (!token) return null;
    const session = this.read().find((candidate) => candidate.hash === this.hash(token, origin));
    return session ? new Date(session.expiresAt).toISOString() : null;
  }

  revoke(token: string | undefined, origin?: string): void {
    if (!token) return;
    this.write(this.read().filter((session) => session.hash !== this.hash(token, origin)));
  }
}
