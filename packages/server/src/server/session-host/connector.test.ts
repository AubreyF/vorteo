import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, expect, test } from "vitest";
import { createSessionHostConnector, RESTART_MARKER_MAX_AGE_MS } from "./connector.js";
import { sessionHostPaths } from "./host-files.js";

const logger = pino({ level: "silent" });
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

test("a restart marker is believed only while a restart could still be under way", async () => {
  const home = mkdtempSync(join(tmpdir(), "connector-"));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const paths = sessionHostPaths(home);
  mkdirSync(paths.directory, { mode: 0o700 });
  const connector = createSessionHostConnector({ paths, logger });
  cleanups.push(() => connector.close());
  expect(await connector.restarting!()).toBe(false);

  writeFileSync(paths.restartMarkerPath, "{}", { mode: 0o600 });
  expect(await connector.restarting!()).toBe(true);

  // A marker older than any restart takes survived a coordinator that never cleaned it up.
  const stale = (Date.now() - RESTART_MARKER_MAX_AGE_MS - 1_000) / 1_000;
  utimesSync(paths.restartMarkerPath, stale, stale);
  expect(await connector.restarting!()).toBe(false);
});
