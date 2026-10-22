import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  readInstallationConfig,
  hostLaunchdService,
  InstallationConfigSchema,
  claudeHostRefreshEnabled,
} from "./config.js";

const SYSTEMD_SERVICE = {
  kind: "systemd-user",
  uid: 1000,
  unit: "local.vorteo.fixture.host.service",
};

function config(host: Record<string, unknown>) {
  return {
    public: {
      version: 1,
      installationId: "00000000-0000-4000-8000-000000000001",
      origin: "https://example.test",
      environments: [
        { kind: "host", serverId: "host", endpoint: "localhost:1", useTls: false },
        { kind: "container", serverId: "dev", endpoint: "localhost:2", useTls: false },
      ],
    },
    listenPort: 4000,
    webDistDir: "/fixture/web",
    stateDir: "/fixture/state",
    ownerPasswordHash: "$2-fixture",
    hostAgentTokenHash: "a".repeat(64),
    containerAgentTokenHash: "b".repeat(64),
    host: { endpoint: "127.0.0.1:1", password: "host", ...host },
    container: { endpoint: "127.0.0.1:2", password: "container" },
  };
}

describe("Host service descriptor", () => {
  let directory: string;
  let file: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "installation-config-"));
    file = path.join(directory, "config.json");
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  async function read(host: Record<string, unknown>) {
    await writeFile(file, JSON.stringify(config(host)));
    return readInstallationConfig(file);
  }

  test("keeps existing launchd configurations unchanged", async () => {
    const parsed = await read({ launchdService: "gui/501/local.vorteo.fixture.host" });
    expect(parsed.host).toEqual({
      endpoint: "127.0.0.1:1",
      password: "host",
      launchdService: "gui/501/local.vorteo.fixture.host",
    });
  });

  test("requires exactly one service descriptor", async () => {
    await expect(read({})).rejects.toThrow();
    await expect(
      read({
        launchdService: "gui/501/local.vorteo.fixture.host",
        systemdService: SYSTEMD_SERVICE,
      }),
    ).rejects.toThrow();
  });

  test("refuses user units outside the installation namespace", async () => {
    for (const unit of [
      "local.vorteo.fixture.host",
      "local.vorteo.fixture@.service",
      "other.fixture.host.service",
    ])
      await expect(read({ systemdService: { ...SYSTEMD_SERVICE, unit } })).rejects.toThrow();
    await expect(
      read({ systemdService: { ...SYSTEMD_SERVICE, kind: "systemd-system" } }),
    ).rejects.toThrow();
  });

  test.runIf(process.platform !== "darwin")("accepts a systemd user unit off macOS", async () => {
    const parsed = await read({ systemdService: SYSTEMD_SERVICE });
    expect(parsed.host).toMatchObject({ systemdService: SYSTEMD_SERVICE });
  });

  test.runIf(process.platform === "darwin")("accepts only launchd on macOS", async () => {
    await expect(read({ systemdService: SYSTEMD_SERVICE })).rejects.toThrow(
      "macOS Host requires its launchd service",
    );
  });
});

test("launchd consumers preserve the configured service and refuse unwired systemd operations", () => {
  const launchdService = "gui/501/local.vorteo.fixture.host";
  expect(hostLaunchdService(InstallationConfigSchema.parse(config({ launchdService })))).toBe(
    launchdService,
  );
  const systemd = InstallationConfigSchema.parse(config({ systemdService: SYSTEMD_SERVICE }));
  expect(() => hostLaunchdService(systemd)).toThrow(
    "Host operations through systemd are not supported yet",
  );
});

describe("Host-owned Claude refresh", () => {
  test("is on by default and keeps the explicit opt-out", () => {
    const base = InstallationConfigSchema.parse(
      config({ launchdService: "gui/501/local.vorteo.fixture" }),
    );
    expect(claudeHostRefreshEnabled(base)).toBe(true);
    expect(claudeHostRefreshEnabled({ ...base, claudeHostRefresh: true })).toBe(true);
    expect(claudeHostRefreshEnabled({ ...base, claudeHostRefresh: false })).toBe(false);
  });
});
