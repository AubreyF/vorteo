import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import type { InstallationConfig } from "./config.js";
import {
  assertReleaseSelectionAllowed,
  createSessionHostReleaseGuard,
  ensureSessionHostReleaseGuard,
  releaseSelectionGuardRegistered,
  SessionHostReleaseRefused,
  setReleaseSelectionGuard,
} from "./release-selection-guard.js";
import { SESSION_HOST_ENTRYPOINT } from "./session-host-job.js";

const roots: string[] = [];
afterEach(() => {
  setReleaseSelectionGuard(null);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "release-selection-guard-")));
  roots.push(root);
  const supported = path.join(root, "releases", "with-session-host");
  const unsupported = path.join(root, "releases", "before-session-host");
  mkdirSync(path.dirname(path.join(supported, SESSION_HOST_ENTRYPOINT)), { recursive: true });
  writeFileSync(path.join(supported, SESSION_HOST_ENTRYPOINT), "");
  mkdirSync(unsupported, { recursive: true });
  const link = path.join(root, "current");
  symlinkSync(supported, link);
  const plistPath = path.join(root, "LaunchAgents", "local.vorteo.test.session-host.plist");
  mkdirSync(path.dirname(plistPath));
  return { root, link, plistPath, supported, unsupported };
}

test("an installed session host job refuses a release without the session host", () => {
  const f = fixture();
  const guard = createSessionHostReleaseGuard({
    currentReleaseLink: f.link,
    plistPath: f.plistPath,
  });
  writeFileSync(f.plistPath, "installed");
  expect(() => guard({ link: f.link, candidate: f.unsupported })).toThrow(
    SessionHostReleaseRefused,
  );
  expect(() => guard({ link: f.link, candidate: f.unsupported })).toThrow(
    "Remove the session host job first: release before-session-host has no session host support.",
  );
  expect(() => guard({ link: f.link, candidate: f.supported })).not.toThrow();
});

test("the guard allows every release once the job is removed, and other links always", () => {
  const f = fixture();
  const guard = createSessionHostReleaseGuard({
    currentReleaseLink: f.link,
    plistPath: f.plistPath,
  });
  expect(() => guard({ link: f.link, candidate: f.unsupported })).not.toThrow();
  writeFileSync(f.plistPath, "installed");
  const other = path.join(f.root, "coordinator-current");
  expect(() => guard({ link: other, candidate: f.unsupported })).not.toThrow();
});

test("the same link through a symlinked parent is still guarded", () => {
  const f = fixture();
  const alias = path.join(f.root, "alias");
  symlinkSync(f.root, alias);
  writeFileSync(f.plistPath, "installed");
  const guard = createSessionHostReleaseGuard({
    currentReleaseLink: f.link,
    plistPath: f.plistPath,
  });
  expect(() => guard({ link: path.join(alias, "current"), candidate: f.unsupported })).toThrow(
    SessionHostReleaseRefused,
  );
});

test("selection checks nothing until a guard is registered", () => {
  const f = fixture();
  writeFileSync(f.plistPath, "installed");
  expect(() =>
    assertReleaseSelectionAllowed({ link: f.link, candidate: f.unsupported }),
  ).not.toThrow();
  setReleaseSelectionGuard(
    createSessionHostReleaseGuard({ currentReleaseLink: f.link, plistPath: f.plistPath }),
  );
  expect(() => assertReleaseSelectionAllowed({ link: f.link, candidate: f.unsupported })).toThrow(
    SessionHostReleaseRefused,
  );
});

test("a coordinator that selects Host releases registers the guard itself, keeping any other", () => {
  const f = fixture();
  const config = {
    public: { installationId: "00000000-0000-4000-8000-000000000001" },
  } as InstallationConfig;
  ensureSessionHostReleaseGuard(config);
  expect(releaseSelectionGuardRegistered()).toBe(false);
  const selecting = {
    ...config,
    sourceUpdates: { currentReleaseLink: f.link },
  } as InstallationConfig;
  ensureSessionHostReleaseGuard(selecting);
  expect(releaseSelectionGuardRegistered()).toBe(true);
  // No session host plist exists for this installation, so nothing is refused.
  expect(() =>
    assertReleaseSelectionAllowed({ link: f.link, candidate: f.unsupported }),
  ).not.toThrow();
  const refuseAll = () => {
    throw new SessionHostReleaseRefused("registered");
  };
  setReleaseSelectionGuard(refuseAll);
  ensureSessionHostReleaseGuard(selecting);
  expect(() => assertReleaseSelectionAllowed({ link: f.link, candidate: f.supported })).toThrow(
    "release registered",
  );
});
