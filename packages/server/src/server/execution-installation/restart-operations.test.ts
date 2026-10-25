import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  REVIEWED_CONFIGURATION_SETTINGS,
  type ReviewedConfigurationSetting,
} from "@getpaseo/protocol/coordinator-configuration-settings";
import type { InstallationConfig } from "./config.js";
import { createInstallationRestartExecutor, hostLauncherTarget } from "./daemon.js";
import { RESTART_OPERATIONS } from "./restart-operations.js";

/** Supervisor maintenance is configured through Dev registration, not a reviewed setting. */
const UNREGISTERED_OPERATIONS = ["supervisorMaintenance"];

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** One valid value per registered setting that backs a restart operation. The digests
 * check real files, so executables and the Factory plan exist on disk. */
function samples(): Partial<Record<ReviewedConfigurationSetting, unknown>> {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "restart-settings-")));
  roots.push(root);
  const script = path.join(root, "adopt.mjs");
  writeFileSync(script, "// fixture adoption plan\n", { mode: 0o600 });
  return {
    factoryRuntimeAdoption: {
      node: process.execPath,
      script,
      sha256: createHash("sha256").update(readFileSync(script)).digest("hex"),
    },
    engineRestart: {
      docker: process.execPath,
      socket: path.join(root, "docker.sock"),
      containers: {
        dev: "a".repeat(64),
        gatewayTailscale: "b".repeat(64),
        gatewayCaddy: "c".repeat(64),
      },
    },
    hostLauncherUpdate: { candidate: path.join(root, "candidate.plist"), sha256: "c".repeat(64) },
  };
}

function baseConfig(): Record<string, unknown> {
  return {
    stateDir: "/fixture/state",
    public: { environments: [] },
    host: { launchdService: "gui/501/local.vorteo.fixture.host", endpoint: "127.0.0.1:1" },
    container: { endpoint: "127.0.0.1:2" },
    sourceUpdates: { currentReleaseLink: "/fixture/current", releaseRoot: "/fixture/releases" },
  };
}

function withSetting(location: readonly string[], value: unknown): Record<string, unknown> {
  const config = baseConfig();
  const section =
    location.length === 1 ? config : (config[location[0]!] as Record<string, unknown>);
  section[location[location.length - 1]!] = value;
  return config;
}

function planOf(operation: (typeof RESTART_OPERATIONS)[number], config: Record<string, unknown>) {
  return operation.plan(createInstallationRestartExecutor(config as unknown as InstallationConfig));
}

// The restart executor and its plans use POSIX paths; it runs only on the macOS Host and Linux Dev.
test.skipIf(process.platform === "win32")(
  "every reviewed restart operation's plan comes from the registered setting of the same name",
  () => {
    for (const operation of RESTART_OPERATIONS) {
      if (UNREGISTERED_OPERATIONS.includes(operation.capability)) {
        expect(Object.hasOwn(REVIEWED_CONFIGURATION_SETTINGS, operation.capability)).toBe(false);
        continue;
      }
      expect(
        Object.hasOwn(REVIEWED_CONFIGURATION_SETTINGS, operation.capability),
        operation.capability,
      ).toBe(true);
      const name = operation.capability as ReviewedConfigurationSetting;
      const setting = REVIEWED_CONFIGURATION_SETTINGS[name];
      const value = setting.value.parse(samples()[name]);
      const configured = withSetting(setting.path, value);
      if (name === "hostLauncherUpdate") {
        // Its digest also reads the live launch file, so check the plan's input instead:
        // the executor's launcher target is built from exactly this setting.
        const target = hostLauncherTarget(configured as unknown as InstallationConfig);
        const update = value as { candidate: string; sha256: string };
        expect(target?.candidate).toEqual({ path: update.candidate, sha256: update.sha256 });
        expect(hostLauncherTarget(baseConfig() as unknown as InstallationConfig)).toBeUndefined();
        continue;
      }
      // The executor advertises a plan exactly when the setting is present at its registry path.
      expect(planOf(operation, configured), name).toMatch(/^[a-f0-9]{64}$/);
      expect(planOf(operation, baseConfig()), name).toBeUndefined();
    }
  },
);

test("supervisor maintenance is the only restart operation without a registered setting", () => {
  const unregistered = RESTART_OPERATIONS.map((operation) => operation.capability).filter(
    (capability) => !Object.hasOwn(REVIEWED_CONFIGURATION_SETTINGS, capability),
  );
  expect(unregistered).toEqual(UNREGISTERED_OPERATIONS);
});
