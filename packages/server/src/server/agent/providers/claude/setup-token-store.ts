import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { ClaudeSetupTokenError } from "./setup-token-output.js";

export const ClaudeSetupTokenSchema = z.strictObject({
  version: z.literal(1),
  accessToken: z
    .string()
    .max(32768)
    .regex(/^sk-ant-oat01-[A-Za-z0-9_-]{20,}$/),
  createdAt: z.number().int().positive(),
});
export type ClaudeSetupToken = z.infer<typeof ClaudeSetupTokenSchema>;

const FILE = "claude-setup-token.json";
interface StoreOptions {
  /** A dedicated directory beneath the daemon-owned account home, never a native CLI store. */
  directory: string;
  files?: Pick<typeof fs, "mkdir" | "lstat" | "open" | "rename" | "unlink">;
}

/** Callers serialize replacement and coordinate generation/tombstone policy outside this store. */
export class ClaudeSetupTokenStore {
  private readonly files: NonNullable<StoreOptions["files"]>;
  constructor(private readonly options: StoreOptions) {
    this.files = options.files ?? fs;
  }

  async write(input: unknown, signal?: AbortSignal): Promise<void> {
    const parsed = ClaudeSetupTokenSchema.safeParse(input);
    if (!parsed.success) throw new ClaudeSetupTokenError();
    let staged: string | null = null;
    try {
      await this.ensureDirectory();
      await this.read(); // Refuse to overwrite a linked, foreign, or malformed artifact.
      staged = join(this.options.directory, `.${FILE}.${randomUUID()}`);
      const file = await this.files.open(staged, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify(parsed.data), "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
      signal?.throwIfAborted();
      await this.files.rename(staged, join(this.options.directory, FILE));
      staged = null;
      await this.syncDirectory();
    } catch {
      throw new ClaudeSetupTokenError();
    } finally {
      if (staged) await this.files.unlink(staged).catch(() => {});
    }
  }

  async read(): Promise<ClaudeSetupToken | null> {
    try {
      await this.checkDirectory();
      const file = await this.files.open(
        join(this.options.directory, FILE),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const stat = await file.stat();
        const own = process.getuid === undefined || stat.uid === process.getuid();
        const privateMode = process.platform === "win32" || (stat.mode & 0o777) === 0o600;
        if (!stat.isFile() || stat.nlink !== 1 || !own || !privateMode || stat.size > 65536)
          throw new ClaudeSetupTokenError();
        return ClaudeSetupTokenSchema.parse(JSON.parse(await file.readFile("utf8")));
      } finally {
        await file.close();
      }
    } catch (error) {
      if (isMissing(error)) return null;
      throw new ClaudeSetupTokenError();
    }
  }

  async remove(): Promise<void> {
    try {
      if (await this.read()) {
        await this.files.unlink(join(this.options.directory, FILE));
        await this.syncDirectory();
      }
    } catch {
      throw new ClaudeSetupTokenError();
    }
  }

  private async syncDirectory(): Promise<void> {
    if (process.platform === "win32") return;
    const directory = await this.files.open(
      this.options.directory,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }

  private async ensureDirectory(): Promise<void> {
    try {
      await this.files.mkdir(this.options.directory, { mode: 0o700 });
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
    await this.checkDirectory();
  }

  private async checkDirectory(): Promise<void> {
    const stat = await this.files.lstat(this.options.directory);
    const own = process.getuid === undefined || stat.uid === process.getuid();
    const privateMode = process.platform === "win32" || (stat.mode & 0o777) === 0o700;
    if (!stat.isDirectory() || !own || !privateMode) throw new ClaudeSetupTokenError();
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
