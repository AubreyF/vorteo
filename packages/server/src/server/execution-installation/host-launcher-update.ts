import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { defaultRun, type EngineCommand } from "./factory-verify.js";

const LINK = "PASEO_MANAGED_RELEASE_LINK";
const ROOT = "PASEO_MANAGED_RELEASE_ROOT";
const VERIFY_DEADLINE_MS = 180_000;

/** Everything the one-time Host launcher update touches, from protected configuration. */
export interface HostLauncherTarget {
  /** launchd domain and label, for example `gui/501` and `local.vorteo.<id>.host`. */
  domain: string;
  label: string;
  /** The live plist launchd loads. */
  plist: string;
  candidate: { path: string; sha256: string };
  /** Managed release selection, from the configured source updates. */
  link: string;
  root: string;
  stateDir: string;
}

export interface HostLauncherDependencies {
  run?: EngineCommand;
  /** Parse a plist into JSON; production uses plutil. */
  plistJson?: (file: string) => unknown;
  /** The Host daemon's worker PID and version, over the pinned-identity connection. */
  probe: () => Promise<{ pid: number; version: string }>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

function defaultPlistJson(file: string): unknown {
  return JSON.parse(
    execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", "--", file], {
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    }).toString("utf8"),
  );
}

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * The candidate must equal the live launcher plus exactly the managed release link
 * and root, matching the configured source updates. Nothing else may change.
 */
export function verifyLauncherCandidate(
  live: unknown,
  candidate: unknown,
  link: string,
  root: string,
): void {
  const record = (value: unknown) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  const current = record(live);
  const next = record(candidate);
  if (!current || !next) throw new Error("Host launcher must be a dictionary");
  const environment = record(current.EnvironmentVariables) ?? {};
  if (LINK in environment || ROOT in environment)
    throw new Error("The Host launcher already selects managed releases");
  const expected = {
    ...current,
    EnvironmentVariables: { ...environment, [LINK]: link, [ROOT]: root },
  };
  if (!isDeepStrictEqual(next, expected))
    throw new Error(
      "The candidate Host launcher changes more than the managed release link and root",
    );
}

function readProtectedCandidate(candidate: HostLauncherTarget["candidate"]): Buffer {
  const file = lstatSync(candidate.path);
  if (
    !file.isFile() ||
    file.uid !== process.getuid?.() ||
    (file.mode & 0o022) !== 0 ||
    realpathSync(candidate.path) !== candidate.path
  )
    throw new Error("The candidate Host launcher must be an owner-controlled physical file");
  const bytes = readFileSync(candidate.path);
  if (sha256(bytes) !== candidate.sha256) throw new Error("The candidate Host launcher changed");
  return bytes;
}

/** Read-only. Returns the exact live and candidate bytes and the digest owners approve. */
export function inspectHostLauncherPlan(
  target: HostLauncherTarget,
  plistJson: (file: string) => unknown = defaultPlistJson,
): { digest: string; live: Buffer; candidate: Buffer } {
  const candidate = readProtectedCandidate(target.candidate);
  const live = readFileSync(target.plist);
  verifyLauncherCandidate(
    plistJson(target.plist),
    plistJson(target.candidate.path),
    target.link,
    target.root,
  );
  // Binding the live bytes too means any later change to the plist voids an approval.
  const digest = sha256(
    JSON.stringify({
      candidate: target.candidate.sha256,
      live: sha256(live),
      link: target.link,
      root: target.root,
    }),
  );
  return { digest, live, candidate };
}

/** The digest, or undefined when the plan is missing, changed or already applied. */
export function hostLauncherPlanDigest(
  target: HostLauncherTarget | undefined,
  plistJson?: (file: string) => unknown,
): string | undefined {
  if (!target) return undefined;
  try {
    return inspectHostLauncherPlan(target, plistJson).digest;
  } catch {
    return undefined;
  }
}

/** Write through a synced temporary file in the same directory, then rename over. */
function writeAtomic(file: string, bytes: Buffer, exclusive = false): void {
  const temporary = exclusive ? file : `${file}.vorteo-${process.pid}-${Date.now()}`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (!exclusive) renameSync(temporary, file);
}

function launchdPid(printed: string): number | null {
  const match = /^\s*pid = (\d+)$/m.exec(printed);
  return match ? Number(match[1]) : null;
}

function selectedReleaseVersion(link: string): string {
  const release = realpathSync(link);
  const manifest = JSON.parse(
    readFileSync(path.join(release, "packages/server/package.json"), "utf8"),
  ) as { version?: unknown };
  if (typeof manifest.version !== "string") throw new Error("Selected release has no version");
  return manifest.version;
}

/**
 * Swap in the reviewed launcher and reload the Host service once. On any failure after
 * the swap, put the previous launcher back and reload it. Never retried.
 */
export async function runHostLauncherUpdate(
  target: HostLauncherTarget,
  approved: { jobId: string; digest: string },
  dependencies: HostLauncherDependencies,
): Promise<string> {
  const run = dependencies.run ?? defaultRun;
  const sleep = dependencies.sleep ?? ((ms: number) => delay(ms));
  const now = dependencies.now ?? Date.now;
  const plan = inspectHostLauncherPlan(target, dependencies.plistJson);
  if (plan.digest !== approved.digest)
    throw new Error("The Host launcher plan changed after approval. Nothing was changed.");
  const service = `${target.domain}/${target.label}`;
  const before = await dependencies.probe();
  const previousSupervisor = launchdPid(
    (await run("/bin/launchctl", ["print", service], 15_000)).stdout,
  );
  const expectedVersion = selectedReleaseVersion(target.link);
  const fallback = path.join(target.stateDir, `host-launcher-fallback-${approved.jobId}.plist`);
  writeAtomic(fallback, plan.live, true);
  writeAtomic(target.plist, plan.candidate);
  const reload = async () => {
    await run("/bin/launchctl", ["bootout", service], 30_000).catch(() => undefined);
    let lastError: unknown;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        await run("/bin/launchctl", ["bootstrap", target.domain, target.plist], 30_000);
        return;
      } catch (error) {
        // bootout can return before launchd releases the label.
        lastError = error;
        await sleep(1000);
      }
    }
    throw lastError instanceof Error ? lastError : new Error("launchctl bootstrap failed");
  };
  try {
    await reload();
    const detail = await verifyReloaded(target, {
      run,
      sleep,
      now,
      probe: dependencies.probe,
      before,
      previousSupervisor,
      expectedVersion,
    });
    return detail;
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Host launcher update failed";
    writeAtomic(target.plist, plan.live);
    try {
      await reload();
    } catch (restoreError) {
      throw new Error(
        `${reason}. Restored the previous launcher file, but launchd did not reload it; reload the Host service by hand. The fallback copy is ${fallback}.`,
        { cause: restoreError },
      );
    }
    throw new Error(
      `${reason}. Restored and reloaded the previous launcher; nothing will be retried.`,
      { cause: error },
    );
  }
}

async function verifyReloaded(
  target: HostLauncherTarget,
  input: {
    run: EngineCommand;
    sleep: (ms: number) => Promise<void>;
    now: () => number;
    probe: HostLauncherDependencies["probe"];
    before: { pid: number; version: string };
    previousSupervisor: number | null;
    expectedVersion: string;
  },
): Promise<string> {
  const service = `${target.domain}/${target.label}`;
  const deadline = input.now() + VERIFY_DEADLINE_MS;
  let unmet = "the Host daemon answers";
  while (input.now() < deadline) {
    await input.sleep(2000);
    let daemon: { pid: number; version: string };
    try {
      daemon = await input.probe();
    } catch {
      unmet = "the Host daemon answers";
      continue;
    }
    if (daemon.pid === input.before.pid) {
      unmet = "a new Host worker starts";
      continue;
    }
    const supervisor = launchdPid(
      (await input.run("/bin/launchctl", ["print", service], 15_000)).stdout,
    );
    if (supervisor === null || supervisor === input.previousSupervisor) {
      unmet = "a new Host supervisor starts";
      continue;
    }
    if (daemon.version !== input.expectedVersion)
      throw new Error(
        `The Host restarted on ${daemon.version}, not the selected ${input.expectedVersion}`,
      );
    const environment = (
      await input.run("/bin/ps", ["-E", "-ww", "-o", "command=", "-p", String(supervisor)], 15_000)
    ).stdout.split(/\s+/);
    if (
      !environment.includes(`${LINK}=${target.link}`) ||
      !environment.includes(`${ROOT}=${target.root}`)
    )
      throw new Error("The new Host supervisor does not carry the managed release settings");
    return `Host launcher updated: supervisor ${supervisor}, worker ${daemon.pid} on ${daemon.version} with managed release selection.`;
  }
  throw new Error(`The Host did not come back in time: waiting for ${unmet}`);
}
