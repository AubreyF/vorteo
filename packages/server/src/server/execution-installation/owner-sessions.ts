import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, openSync, fsyncSync, closeSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { writePrivateFileAtomicSync } from "../private-files.js";

const SessionsSchema = z.array(z.strictObject({ hash: z.string(), expiresAt: z.number() }));
export const OWNER_SESSION_MAX_AGE = 7 * 24 * 60 * 60;

/** Persist only token hashes. Expiry is absolute, so polling cannot prolong owner access. */
export class OwnerSessions {
  constructor(
    private readonly file: string,
    private readonly now = Date.now,
  ) {}

  private read() {
    return (
      existsSync(this.file) ? SessionsSchema.parse(JSON.parse(readFileSync(this.file, "utf8"))) : []
    ).filter((session) => session.expiresAt > this.now());
  }

  private hash(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }

  private write(sessions: z.infer<typeof SessionsSchema>): void {
    writePrivateFileAtomicSync(this.file, JSON.stringify(sessions));
    for (const target of [this.file, path.dirname(this.file)]) {
      const fd = openSync(target, "r");
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
  }

  create(): string {
    const token = randomBytes(32).toString("base64url");
    const sessions = this.read();
    sessions.push({ hash: this.hash(token), expiresAt: this.now() + OWNER_SESSION_MAX_AGE * 1000 });
    this.write(sessions);
    return token;
  }

  expiresAt(token: string | undefined): string | null {
    if (!token) return null;
    const session = this.read().find((candidate) => candidate.hash === this.hash(token));
    return session ? new Date(session.expiresAt).toISOString() : null;
  }

  revoke(token: string | undefined): void {
    if (!token) return;
    this.write(this.read().filter((session) => session.hash !== this.hash(token)));
  }
}
