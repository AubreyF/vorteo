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

test("local tokens are origin-bound without changing retained public session records", () => {
  const root = mkdtempSync(path.join(tmpdir(), "owner-local-sessions-"));
  try {
    const file = path.join(root, "sessions.json");
    const sessions = new OwnerSessions(file);
    const publicToken = sessions.create();
    const origin = "http://127.0.0.1:6770";
    const localToken = sessions.create(origin);
    expect(sessions.expiresAt(publicToken)).not.toBeNull();
    expect(sessions.expiresAt(publicToken, origin)).toBeNull();
    expect(sessions.expiresAt(localToken)).toBeNull();
    expect(sessions.expiresAt(localToken, "http://localhost:6770")).toBeNull();
    expect(sessions.expiresAt(localToken, "http://127.0.0.1:6771")).toBeNull();
    const reloaded = new OwnerSessions(file);
    expect(reloaded.expiresAt(localToken, origin)).not.toBeNull();
    reloaded.revoke(localToken, origin);
    expect(sessions.expiresAt(localToken, origin)).toBeNull();
    expect(sessions.expiresAt(publicToken)).not.toBeNull();
    expect(JSON.parse(readFileSync(file, "utf8"))).toHaveLength(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
