import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { FileBootstrapRequestJournal } from "./coordinator-bootstrap-journal.js";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const step of cleanup.splice(0).toReversed()) step();
});

function journalDirectory(): string {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "bootstrap-lock-")));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

/** Another process holds the journal flock for `holdMs`, as the coordinator
 * loop or a Host status read would. Resolves once the lock is held. */
async function holdLock(directory: string, holdMs: number): Promise<ChildProcess> {
  const holder = spawn(
    "/usr/bin/python3",
    [
      "-I",
      "-c",
      [
        "import fcntl, os, sys, time",
        "fd = os.open(sys.argv[1], os.O_RDWR)",
        "fcntl.flock(fd, fcntl.LOCK_EX)",
        "print('locked', flush=True)",
        "time.sleep(float(sys.argv[2]))",
      ].join("\n"),
      path.join(directory, "coordinator-bootstrap.lock"),
      String(holdMs / 1000),
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  cleanup.push(() => holder.kill());
  await new Promise<void>((resolve, reject) => {
    holder.once("error", reject);
    holder.stdout!.once("data", () => resolve());
  });
  return holder;
}

test("a writer waits for another process to release the journal lock", async () => {
  const directory = journalDirectory();
  const journal = new FileBootstrapRequestJournal(directory, { lockWaitMs: 5000 });
  journal.writeLifecycle([]);
  await holdLock(directory, 400);
  const started = Date.now();
  journal.writeLifecycle([]);
  expect(Date.now() - started).toBeGreaterThanOrEqual(200);
  expect(journal.readLifecycle()).toEqual([]);
});

test("a writer refuses once the wait budget is spent", async () => {
  const directory = journalDirectory();
  const journal = new FileBootstrapRequestJournal(directory, { lockWaitMs: 300 });
  journal.writeLifecycle([]);
  await holdLock(directory, 10_000);
  const started = Date.now();
  expect(() => journal.writeLifecycle([])).toThrow("storage is busy");
  expect(Date.now() - started).toBeGreaterThanOrEqual(300);
});

test("nested use within one process refuses without waiting", () => {
  const directory = journalDirectory();
  const journal = new FileBootstrapRequestJournal(directory, { lockWaitMs: 5000 });
  journal.writeLifecycle([]);
  const started = Date.now();
  journal.withRecoveryTransaction(() => {
    expect(() => new FileBootstrapRequestJournal(directory).writeLifecycle([])).toThrow(
      "storage is busy",
    );
  });
  expect(Date.now() - started).toBeLessThan(2000);
});
