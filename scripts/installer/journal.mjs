// The install journal at <root>/state/install.json: the plan being applied, each
// step's status and the non-secret outputs later steps need, so a rerun resumes.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { InstallerError, writeJson } from "./primitives.mjs";

export const JOURNAL_VERSION = 1;

export function readJournal(file) {
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, "utf8"));
}

function nonEmpty(directory) {
  return existsSync(directory) && readdirSync(directory).length > 0;
}

/**
 * Opens the journal for `plan`, creating it on the first run. Refuses to touch an
 * installation it did not start: a journal for another plan, or files in the
 * installation folder without a journal. The `source` folder may already hold the
 * release that the installer fetched.
 */
export function openJournal(plan, now = () => new Date()) {
  const file = plan.paths.journal;
  const existing = readJournal(file);
  if (existing) {
    if (existing.installationId !== plan.installationId)
      throw new InstallerError(
        `${plan.paths.root} already holds installation ${existing.installationId}; it is never overwritten.`,
        "Run status or repair for that installation, or choose another folder with --root.",
      );
    return createJournalHandle(file, existing, now);
  }
  const occupied = ["host", "state", ...(plan.kind === "new" ? ["container"] : [])]
    .map((name) => path.join(plan.paths.root, name))
    .filter(nonEmpty);
  if (occupied.length)
    throw new InstallerError(
      `${occupied.join(" and ")} already exist without an install journal; they are never overwritten.`,
      "Move them aside or choose another installation folder with --root, then plan again.",
    );
  const journal = {
    version: JOURNAL_VERSION,
    installationId: plan.installationId,
    startedAt: now().toISOString(),
    plan,
    steps: {},
    outputs: {},
  };
  const handle = createJournalHandle(file, journal, now);
  handle.save();
  return handle;
}

export function createJournalHandle(file, journal, now = () => new Date()) {
  return {
    file,
    data: journal,
    save() {
      writeJson(file, journal);
    },
    isDone(step) {
      return journal.steps[step]?.status === "done";
    },
    mark(step, status, message) {
      journal.steps[step] = { status, at: now().toISOString(), ...(message ? { message } : {}) };
      this.save();
    },
    /** Records outputs such as the tailnet name or Dev identity. Never secrets. */
    output(values) {
      Object.assign(journal.outputs, values);
      this.save();
    },
    complete() {
      journal.completedAt = now().toISOString();
      this.save();
    },
  };
}
