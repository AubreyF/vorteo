import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { RestartJob } from "@getpaseo/protocol/execution-installation";
import { createTestLogger } from "../../test-utils/test-logger.js";
import type { InstallationConfig } from "./config.js";
import {
  adoptionRequired,
  createReleaseUpgradeRuntime,
  legacyHostCommit,
  upgradeBlocker,
} from "./release-upgrade-runtime.js";
import type { InstallationRestarts } from "./restarts.js";

const INSTALLED = "1".repeat(40);
const SUPERVISOR = "packages/server/dist/scripts/supervisor-entrypoint.js";
const COORDINATOR = "packages/server/dist/server/server/execution-installation/main.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "release-upgrade-runtime-"));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function touch(file: string, content = "") {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

/**
 * The configuration scripts/install-execution-host.mjs wrote, beside its installation.json,
 * with a release folder named by its commit. Its installer engine records each run.
 */
function legacyInstallation(): { config: InstallationConfig; configFile: string; release: string } {
  const release = path.join(root, "releases", INSTALLED);
  touch(path.join(release, SUPERVISOR));
  touch(path.join(release, COORDINATOR));
  touch(
    path.join(release, "scripts/installer/main.mjs"),
    'import { appendFileSync } from "node:fs";\nappendFileSync(process.env.ENGINE_LOG ?? "/dev/null", JSON.stringify(process.argv.slice(2)) + "\\n");\n',
  );
  touch(path.join(root, "installation.json"), "{}");
  const configFile = path.join(root, "coordinator.json");
  const config = {
    public: {
      version: 1,
      installationId: "791360b7-0000-4000-8000-000000000001",
      origin: "https://box.example.ts.net:44444",
      environments: [
        { kind: "host", serverId: "srv_host", endpoint: "box.example.ts.net:44445", useTls: true },
      ],
    },
    listenPort: 6770,
    webDistDir: path.join(release, "packages/server/dist/server/web-ui"),
    stateDir: path.join(root, "state", "coordinator"),
    ownerPasswordHash: "$2b$10$owner",
    hostAgentTokenHash: "c".repeat(64),
    containerAgentTokenHash: "d".repeat(64),
    host: {
      endpoint: "127.0.0.1:6771",
      password: "host-password",
      launchdService: "gui/501/local.vorteo.791360b7-0000-4000-8000-000000000001.host",
      startupValidation: {
        node: process.execPath,
        entrypoint: path.join(release, SUPERVISOR),
        home: path.join(root, "state", "host"),
      },
    },
  } as InstallationConfig;
  touch(configFile, JSON.stringify(config));
  return { config, configFile, release };
}

function hostUpdate(id: string, status: RestartJob["status"]): RestartJob {
  return {
    id,
    target: "host",
    status,
    reason: "Builds source update",
    update: {
      sourceCommit: "2".repeat(40),
      baseCommit: INSTALLED,
      sha256: "e".repeat(64),
      bytes: 1,
    },
  } as RestartJob;
}

function runtime(jobs: RestartJob[], legacy = legacyInstallation()) {
  return createReleaseUpgradeRuntime({
    config: legacy.config,
    configFile: legacy.configFile,
    restarts: { list: () => jobs } as unknown as InstallationRestarts,
    hostUpdates: null,
    logger: createTestLogger(),
    entrypoint: path.join(legacy.release, COORDINATOR),
  });
}

test("an installation from before the installer offers upgrades, which adopt it first", () => {
  const { config, configFile } = legacyInstallation();
  expect(adoptionRequired(config, configFile)).toBe(true);
  expect(upgradeBlocker(config)).toContain("one-command installer");
  expect(upgradeBlocker(config, true)).toBeNull();
  expect(legacyHostCommit(config)).toBe(INSTALLED);
  const status = runtime([]).upgradeStatus();
  expect(status).toMatchObject({ available: true, current: { sourceCommit: INSTALLED } });
  expect(status.detail).toContain("predates the one-command installer");
});

test("a configuration without the old installer's record is not adopted", () => {
  const { config } = legacyInstallation();
  expect(adoptionRequired(config, path.join(root, "elsewhere", "coordinator.json"))).toBe(false);
});

test("a Host source update seen to succeed starts adoption once, detached", async () => {
  const log = path.join(root, "engine.log");
  process.env.ENGINE_LOG = log;
  try {
    const jobs = [hostUpdate("00000000-0000-4000-8000-000000000001", "succeeded")];
    const legacy = legacyInstallation();
    const upgrades = runtime(jobs, legacy);
    // Updates that finished before this coordinator started never trigger it.
    upgrades.adoptAfterSourceUpdate();
    expect(existsSync(path.join(legacy.config.stateDir, "adoption", "launch.json"))).toBe(false);
    jobs.push(hostUpdate("00000000-0000-4000-8000-000000000002", "succeeded"));
    upgrades.adoptAfterSourceUpdate();
    upgrades.adoptAfterSourceUpdate();
    const launch = JSON.parse(
      readFileSync(path.join(legacy.config.stateDir, "adoption", "launch.json"), "utf8"),
    );
    expect(launch.jobId).toBe("00000000-0000-4000-8000-000000000002");
    await expect.poll(() => existsSync(log), { timeout: 10_000 }).toBe(true);
    await expect
      .poll(() => readFileSync(log, "utf8").trim().split("\n").length, { timeout: 2000 })
      .toBe(1);
    expect(JSON.parse(readFileSync(log, "utf8"))).toEqual([
      "adopt",
      "--root",
      root,
      "--outcome",
      path.join(legacy.config.stateDir, "adoption", "adoption.json"),
    ]);
  } finally {
    delete process.env.ENGINE_LOG;
  }
});
