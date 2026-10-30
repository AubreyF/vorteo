// POSIX-only: simulates an unreadable journal with file modes. On Windows, chmod only toggles
// the read-only attribute, so the file stays readable and the case cannot be reproduced.
import { mkdtempSync, rmSync } from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { isPlatform } from "../../test-utils/platform.js";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentStorage, parseStoredAgentRecord } from "./agent-storage.js";

// Root ignores file permissions, so an unreadable file cannot be simulated.
const runningAsRoot = process.getuid?.() === 0;

describe.skipIf(isPlatform("win32") || runningAsRoot)("AgentStorage journal POSIX-only", () => {
  let tmpDir: string;
  let storagePath: string;
  const logger = createTestLogger();
  const journalFile = (agentId: string) =>
    path.join(tmpDir, "agent-journals", `${encodeURIComponent(agentId)}.json`);
  const entryText = (item: { text: string }) => item.text;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "agent-storage-posix-"));
    storagePath = path.join(tmpDir, "agents");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("keeps an unreadable journal untouched and refuses appends until it can be read", async () => {
    const storage = new AgentStorage(storagePath, logger);
    const record = parseStoredAgentRecord({
      id: "sidecar-unreadable",
      provider: "codex",
      cwd: "/tmp/project",
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
      config: null,
      persistence: null,
    });
    await storage.upsert(record);
    await storage.appendJournal(record.id, {
      entryId: "11111111-1111-4111-8111-111111111111",
      text: "First",
    });
    const saved = await fs.readFile(journalFile(record.id), "utf8");
    await fs.chmod(journalFile(record.id), 0o000);
    try {
      const reopened = new AgentStorage(storagePath, logger);
      await reopened.upsert((await reopened.get(record.id))!);
      await expect(
        reopened.appendJournal(record.id, {
          entryId: "22222222-2222-4222-8222-222222222222",
          text: "Second",
        }),
      ).rejects.toMatchObject({ code: "unavailable" });
    } finally {
      await fs.chmod(journalFile(record.id), 0o644);
    }
    expect(await fs.readFile(journalFile(record.id), "utf8")).toBe(saved);
    expect(
      (await new AgentStorage(storagePath, logger).get(record.id))?.journal?.map(entryText),
    ).toEqual(["First"]);
  });
});
