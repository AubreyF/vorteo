import { expect, test } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { OwnerSessions, OWNER_SESSION_MAX_AGE } from "./owner-sessions.js";

test("sessions survive service reload, expire absolutely, and revoke durably", () => {
  const root = mkdtempSync(path.join(tmpdir(), "owner-sessions-"));
  try {
    const file = path.join(root, "sessions.json");
    let now = 1000;
    const sessions = new OwnerSessions(file, () => now);
    const token = sessions.create();
    expect(readFileSync(file, "utf8")).not.toContain(token);
    const reloaded = new OwnerSessions(file, () => now);
    expect(reloaded.expiresAt(token)).toBeTruthy();
    expect(reloaded.expiresAt("forged-token")).toBeNull();
    reloaded.revoke(token);
    expect(sessions.expiresAt(token)).toBeNull();
    const another = sessions.create();
    now += OWNER_SESSION_MAX_AGE * 1000;
    expect(reloaded.expiresAt(another)).toBeNull();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.runIf(process.platform !== "win32")(
  "owner session hashes are stored privately on POSIX",
  () => {
    const root = mkdtempSync(path.join(tmpdir(), "owner-session-mode-"));
    try {
      const file = path.join(root, "sessions.json");
      new OwnerSessions(file).create();
      expect(statSync(file).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
