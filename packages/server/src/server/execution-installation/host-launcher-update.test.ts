import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  hostLauncherPlanDigest,
  runHostLauncherUpdate,
  verifyLauncherCandidate,
  type HostLauncherTarget,
} from "./host-launcher-update.js";
import type { EngineCommand } from "./factory-verify.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const live = {
  Label: "local.vorteo.fixture.host",
  ProgramArguments: [
    "/node",
    "/install/current/packages/server/dist/scripts/supervisor-entrypoint.js",
  ],
  EnvironmentVariables: { HOME: "/Users/fixture", PATH: "/usr/bin" },
  KeepAlive: true,
};

/** Plists are stored as JSON in tests; production parses real plists with plutil. */
function fixture() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "host-launcher-")));
  roots.push(root);
  const releases = path.join(root, "releases");
  const release = path.join(releases, "r1");
  mkdirSync(path.join(release, "packages/server"), { recursive: true });
  writeFileSync(
    path.join(release, "packages/server/package.json"),
    JSON.stringify({ version: "0.11.0-beta.3.vorteo.810" }),
  );
  const link = path.join(root, "current");
  symlinkSync(release, link);
  const plist = path.join(root, "host.plist");
  const liveBytes = JSON.stringify(live);
  writeFileSync(plist, liveBytes, { mode: 0o600 });
  const candidate = path.join(root, "candidate.plist");
  const candidateBytes = JSON.stringify({
    ...live,
    EnvironmentVariables: {
      ...live.EnvironmentVariables,
      PASEO_MANAGED_RELEASE_LINK: link,
      PASEO_MANAGED_RELEASE_ROOT: releases,
    },
  });
  writeFileSync(candidate, candidateBytes, { mode: 0o600 });
  const state = path.join(root, "state");
  mkdirSync(state);
  const target: HostLauncherTarget = {
    domain: "gui/501",
    label: live.Label,
    plist,
    candidate: {
      path: candidate,
      sha256: createHash("sha256").update(candidateBytes).digest("hex"),
    },
    link,
    root: releases,
    stateDir: state,
  };
  const plistJson = (file: string) => JSON.parse(readFileSync(file, "utf8"));
  return { root, target, plistJson, liveBytes, candidateBytes, link, releases };
}

/** Fake launchd: bootstrap starts a new supervisor; ps reports the plist environment it loaded. */
function fakeLaunchd(target: HostLauncherTarget, options: { bootstrapFails?: boolean } = {}) {
  const calls: string[] = [];
  let supervisor = 100;
  let loaded = JSON.parse(readFileSync(target.plist, "utf8"));
  const run: EngineCommand = async (file, args) => {
    calls.push([path.basename(file), ...args.slice(0, 1)].join(" "));
    if (args[0] === "print") return { stdout: `\tstate = running\n\tpid = ${supervisor}\n` };
    if (args[0] === "bootout") return { stdout: "" };
    if (args[0] === "bootstrap") {
      if (options.bootstrapFails) throw new Error("bootstrap failed");
      loaded = JSON.parse(readFileSync(target.plist, "utf8"));
      supervisor += 1;
      return { stdout: "" };
    }
    if (path.basename(file) === "ps") {
      const environment = Object.entries(loaded.EnvironmentVariables as Record<string, string>)
        .map(([key, value]) => `${key}=${value}`)
        .join(" ");
      return { stdout: `node supervisor-entrypoint.js ${environment}\n` };
    }
    throw new Error(`unexpected ${file} ${args.join(" ")}`);
  };
  return { run, calls };
}

function clock() {
  let now = 0;
  return { now: () => now, sleep: async (ms: number) => void (now += ms) };
}

test("the candidate may add only the managed release link and root", () => {
  const f = fixture();
  const env = { ...live.EnvironmentVariables };
  const exact = {
    ...live,
    EnvironmentVariables: {
      ...env,
      PASEO_MANAGED_RELEASE_LINK: f.link,
      PASEO_MANAGED_RELEASE_ROOT: f.releases,
    },
  };
  expect(() => verifyLauncherCandidate(live, exact, f.link, f.releases)).not.toThrow();
  expect(() =>
    verifyLauncherCandidate(live, { ...exact, KeepAlive: false }, f.link, f.releases),
  ).toThrow("changes more than");
  expect(() => verifyLauncherCandidate(live, exact, "/elsewhere", f.releases)).toThrow(
    "changes more than",
  );
  expect(() => verifyLauncherCandidate(exact, exact, f.link, f.releases)).toThrow(
    "already selects managed releases",
  );
});

test("the plan digest binds the candidate and the live launcher", () => {
  const f = fixture();
  const digest = hostLauncherPlanDigest(f.target, f.plistJson);
  expect(digest).toMatch(/^[a-f0-9]{64}$/);
  writeFileSync(f.target.plist, JSON.stringify({ ...live, KeepAlive: false }));
  expect(hostLauncherPlanDigest(f.target, f.plistJson)).toBeUndefined();
  writeFileSync(f.target.plist, f.liveBytes);
  expect(hostLauncherPlanDigest(f.target, f.plistJson)).toBe(digest);
  expect(
    hostLauncherPlanDigest(
      { ...f.target, candidate: { ...f.target.candidate, sha256: "0".repeat(64) } },
      f.plistJson,
    ),
  ).toBeUndefined();
  expect(hostLauncherPlanDigest(undefined)).toBeUndefined();
});

test("the update swaps the launcher, reloads it once and verifies the new Host", async () => {
  const f = fixture();
  const digest = hostLauncherPlanDigest(f.target, f.plistJson)!;
  const launchd = fakeLaunchd(f.target);
  let pid = 10;
  const detail = await runHostLauncherUpdate(
    f.target,
    { jobId: "job", digest },
    {
      run: launchd.run,
      plistJson: f.plistJson,
      probe: async () => ({ pid: pid++, version: "0.11.0-beta.3.vorteo.810" }),
      ...clock(),
    },
  );
  expect(detail).toContain("Host launcher updated");
  expect(readFileSync(f.target.plist, "utf8")).toBe(f.candidateBytes);
  expect(
    readFileSync(path.join(f.target.stateDir, "host-launcher-fallback-job.plist"), "utf8"),
  ).toBe(f.liveBytes);
  expect(launchd.calls.filter((call) => call === "launchctl bootstrap")).toHaveLength(1);
});

test("a Host that comes back on another build restores the previous launcher", async () => {
  const f = fixture();
  const digest = hostLauncherPlanDigest(f.target, f.plistJson)!;
  const launchd = fakeLaunchd(f.target);
  let pid = 10;
  await expect(
    runHostLauncherUpdate(
      f.target,
      { jobId: "job", digest },
      {
        run: launchd.run,
        plistJson: f.plistJson,
        probe: async () => ({ pid: pid++, version: "0.11.0-beta.3.vorteo.809" }),
        ...clock(),
      },
    ),
  ).rejects.toThrow(
    "The Host restarted on 0.11.0-beta.3.vorteo.809, not the selected 0.11.0-beta.3.vorteo.810. Restored and reloaded the previous launcher",
  );
  expect(readFileSync(f.target.plist, "utf8")).toBe(f.liveBytes);
  expect(launchd.calls.filter((call) => call === "launchctl bootstrap")).toHaveLength(2);
});

test("a failed reload is reported with the fallback copy and never retried", async () => {
  const f = fixture();
  const digest = hostLauncherPlanDigest(f.target, f.plistJson)!;
  const launchd = fakeLaunchd(f.target, { bootstrapFails: true });
  await expect(
    runHostLauncherUpdate(
      f.target,
      { jobId: "job", digest },
      {
        run: launchd.run,
        plistJson: f.plistJson,
        probe: async () => ({ pid: 10, version: "0.11.0-beta.3.vorteo.810" }),
        ...clock(),
      },
    ),
  ).rejects.toThrow("reload the Host service by hand");
  expect(readFileSync(f.target.plist, "utf8")).toBe(f.liveBytes);
});

test("a changed plan refuses before touching anything", async () => {
  const f = fixture();
  const launchd = fakeLaunchd(f.target);
  await expect(
    runHostLauncherUpdate(
      f.target,
      { jobId: "job", digest: "0".repeat(64) },
      {
        run: launchd.run,
        plistJson: f.plistJson,
        probe: async () => ({ pid: 10, version: "x" }),
        ...clock(),
      },
    ),
  ).rejects.toThrow("Nothing was changed");
  expect(launchd.calls).toEqual([]);
  expect(readFileSync(f.target.plist, "utf8")).toBe(f.liveBytes);
  expect(existsSync(path.join(f.target.stateDir, "host-launcher-fallback-job.plist"))).toBe(false);
});
