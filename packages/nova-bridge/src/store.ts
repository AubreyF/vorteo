import { createHash } from "node:crypto";
import { chmodSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";

const OperationSchema = z.object({
  id: z.string(),
  status: z.enum(["running", "succeeded", "failed", "unknown"]),
  result: z.string().nullable(),
  tool: z.string(),
  arguments: z.string(),
  created_at: z.number(),
  updated_at: z.number(),
});
export interface OperationRequest {
  operationId: string;
  tool: string;
  arguments: unknown;
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("Value must be JSON serializable");
  return encoded;
}

/** One process owns the database. Interrupted mutations remain unknown until reconciled. */
export class BridgeStore {
  readonly db: DatabaseSync;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    try {
      chmodSync(file, 0o600);
      this.db.exec(`
      PRAGMA locking_mode=EXCLUSIVE;
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS operations (
        id TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL,
        tool TEXT NOT NULL,
        arguments TEXT NOT NULL,
        status TEXT NOT NULL,
        result TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      UPDATE operations SET status = 'unknown' WHERE status = 'running';
      `);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  claim(request: OperationRequest) {
    const argumentsJson = canonicalJson(request.arguments);
    const fingerprint = createHash("sha256")
      .update(request.tool)
      .update("\n")
      .update(argumentsJson)
      .digest("hex");
    const inserted = this.db
      .prepare(`
      INSERT OR IGNORE INTO operations (id, fingerprint, tool, arguments, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'running', ?, ?)
    `)
      .run(request.operationId, fingerprint, request.tool, argumentsJson, Date.now(), Date.now());
    const row = z
      .object({ fingerprint: z.string() })
      .parse(
        this.db.prepare("SELECT fingerprint FROM operations WHERE id = ?").get(request.operationId),
      );
    if (row.fingerprint !== fingerprint)
      throw new Error("Operation ID already belongs to another request");
    return { claimed: inserted.changes === 1, operation: this.operation(request.operationId) };
  }

  hasOperation(id: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM operations WHERE id = ?").get(id));
  }

  operation(id: string) {
    const row = OperationSchema.parse(
      this.db
        .prepare(
          "SELECT id, status, result, tool, arguments, created_at, updated_at FROM operations WHERE id = ?",
        )
        .get(id),
    );
    const result: unknown = row.result === null ? null : JSON.parse(row.result);
    return {
      id: row.id,
      status: row.status,
      tool: row.tool,
      request: JSON.parse(row.arguments) as unknown,
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
      result,
    };
  }

  relatedOperations(environment: string, serverId: string, threadId: string): string[] {
    return this.db
      .prepare("SELECT id, arguments FROM operations ORDER BY created_at DESC LIMIT 100")
      .all()
      .flatMap((raw) => {
        const row = z.object({ id: z.string(), arguments: z.string() }).parse(raw);
        const request = z
          .object({
            environment: z.string().optional(),
            serverId: z.string().optional(),
            input: z.object({ agentId: z.string().optional() }).passthrough().optional(),
          })
          .passthrough()
          .parse(JSON.parse(row.arguments));
        return request.environment === environment &&
          request.serverId === serverId &&
          request.input?.agentId === threadId
          ? [row.id]
          : [];
      })
      .slice(0, 10);
  }

  finish(id: string, result: unknown, failed = false): void {
    this.db
      .prepare("UPDATE operations SET status = ?, result = ?, updated_at = ? WHERE id = ?")
      .run(failed ? "failed" : "succeeded", canonicalJson(result), Date.now(), id);
  }

  uncertain(id: string): void {
    this.db
      .prepare("UPDATE operations SET status = 'unknown', updated_at = ? WHERE id = ?")
      .run(Date.now(), id);
  }

  close(): void {
    this.db.close();
  }
}
