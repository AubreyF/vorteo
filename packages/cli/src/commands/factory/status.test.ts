import { beforeEach, describe, expect, it, vi } from "vitest";
import { fixtureSnapshot } from "../../../../../plugins/factory/client/fixtures.js";
import { createFactoryCommand } from "./index.js";
import { runStatusCommand } from "./status.js";
import { runSetupCommand } from "./setup.js";
import { runInstallCommand } from "./install.js";

const { connect, invoke, close, info } = vi.hoisted(() => ({
  connect: vi.fn(),
  invoke: vi.fn(),
  close: vi.fn(),
  info: vi.fn(),
}));
vi.mock("../../utils/client.js", () => ({ connectToDaemon: connect }));

const options = { daemonTarget: { kind: "instance" as const, home: "/tmp/factory-cli-test" } };
const command = createFactoryCommand();

beforeEach(() => {
  vi.resetAllMocks();
  connect.mockResolvedValue({ invokePluginRpc: invoke, close, getLastServerInfoMessage: info });
  info.mockReturnValue({ serverId: "fixture-host", features: { plugins: true } });
  invoke.mockResolvedValue(structuredClone(fixtureSnapshot));
  close.mockResolvedValue(undefined);
});

describe("Factory CLI observation", () => {
  it("exposes only supported status, setup and guarded initial install commands", () => {
    expect(command.commands.map((entry) => entry.name())).toEqual(["status", "setup", "install"]);
    expect(command.commands[0]?.helpInformation()).toContain("--host <host>");
  });

  it("uses the shared contract and preserves unknown account measurements", async () => {
    const result = await runStatusCommand("fixture-project", options, command);
    expect(connect).toHaveBeenCalledWith({ target: options.daemonTarget });
    expect(invoke).toHaveBeenCalledWith("factory", "factory.snapshot", {
      projectId: "fixture-project",
    });
    expect(result.data).toEqual(fixtureSnapshot);
    const usage = result.schema.columns.find((column) => column.header === "USAGE");
    if (typeof usage?.field !== "function") throw new Error("Usage renderer unavailable");
    expect(usage.field(result.data)).toBe("Unknown");
    expect(close).toHaveBeenCalledOnce();
  });

  it("rejects old hosts before transmitting and closes the connection", async () => {
    info.mockReturnValue({ serverId: "fixture-host", features: {} });
    await expect(runStatusCommand("fixture-project", options, command)).rejects.toMatchObject({
      code: "DAEMON_UPDATE_REQUIRED",
    });
    expect(invoke).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it.each([{ serverId: "other-host" }, { projectId: "other-project" }])(
    "refuses mismatched observation identity %j",
    async (change) => {
      invoke.mockResolvedValue({ ...fixtureSnapshot, ...change });
      await expect(runStatusCommand("fixture-project", options, command)).rejects.toMatchObject({
        code: "FACTORY_IDENTITY_MISMATCH",
      });
      expect(close).toHaveBeenCalledOnce();
    },
  );

  it("refuses a host change while the observation was pending", async () => {
    info
      .mockReturnValueOnce({ serverId: "fixture-host", features: { plugins: true } })
      .mockReturnValue({ serverId: "changed-host", features: { plugins: true } });
    await expect(runStatusCommand("fixture-project", options, command)).rejects.toMatchObject({
      code: "FACTORY_IDENTITY_MISMATCH",
    });
  });

  it("rejects malformed output instead of substituting a fixture", async () => {
    invoke.mockResolvedValue({ ...fixtureSnapshot, account: { usagePoints: Infinity } });
    await expect(runStatusCommand("fixture-project", options, command)).rejects.toThrow();
    expect(close).toHaveBeenCalledOnce();
  });

  it("preserves transport errors and closes without a retry", async () => {
    const error = new Error("Factory plugin unavailable");
    invoke.mockRejectedValue(error);
    await expect(runStatusCommand("fixture-project", options, command)).rejects.toBe(error);
    expect(invoke).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it("validates the project input before opening a connection", async () => {
    await expect(runStatusCommand("", options, command)).rejects.toThrow();
    expect(connect).not.toHaveBeenCalled();
  });
});

const readySetup = {
  schemaVersion: 1,
  serverId: "fixture-host",
  projectId: "fixture-project",
  installationId: null,
  revision: "native-revision",
  observedAt: "2026-10-08T20:00:00Z",
  state: "ready",
  reason: null,
  operations: { install: true, pause: false, resume: false, stop: false, disable: false },
};
const installOptions = {
  ...options,
  expectedServerId: "fixture-host",
  expectedRevision: "native-revision",
  operationId: "install-attempt",
};
const applied = {
  schemaVersion: 1,
  serverId: "fixture-host",
  projectId: "fixture-project",
  operationId: "install-attempt",
  outcome: "applied",
  installationId: "installation",
  observedAt: "2026-10-08T20:00:01Z",
  setup: {
    ...readySetup,
    state: "installed",
    installationId: "installation",
    operations: { ...readySetup.operations, install: false },
  },
};

describe("Factory CLI setup and native install", () => {
  it("reads setup without any mutation", async () => {
    invoke.mockResolvedValue(readySetup);
    const result = await runSetupCommand("fixture-project", options, command);
    expect(result.data).toEqual(readySetup);
    expect(invoke).toHaveBeenCalledExactlyOnceWith("factory", "factory.setup", {
      projectId: "fixture-project",
    });
    expect(close).toHaveBeenCalledOnce();
  });
  it("sends one captured mutation only after fresh exact setup", async () => {
    invoke.mockResolvedValueOnce(readySetup).mockResolvedValueOnce(applied);
    expect((await runInstallCommand("fixture-project", installOptions, command)).data).toEqual(
      applied,
    );
    expect(invoke.mock.calls).toEqual([
      ["factory", "factory.setup", { projectId: "fixture-project" }],
      [
        "factory",
        "factory.install",
        {
          projectId: "fixture-project",
          expectedServerId: "fixture-host",
          expectedInstallationId: null,
          expectedRevision: "native-revision",
          operationId: "install-attempt",
        },
      ],
    ]);
    expect(close).toHaveBeenCalledOnce();
  });
  it("requires every mutation precondition before opening a connection", async () => {
    await expect(runInstallCommand("fixture-project", options, command)).rejects.toThrow();
    expect(connect).not.toHaveBeenCalled();
  });
  it("rejects a different selected daemon before requesting setup", async () => {
    await expect(
      runInstallCommand(
        "fixture-project",
        { ...installOptions, expectedServerId: "other-host" },
        command,
      ),
    ).rejects.toMatchObject({ code: "FACTORY_IDENTITY_MISMATCH" });
    expect(invoke).not.toHaveBeenCalled();
  });
  it.each([
    { revision: "changed" },
    {
      state: "held",
      reason: "Reconcile custody",
      operations: { ...readySetup.operations, install: false },
    },
    {
      state: "installed",
      installationId: "existing",
      operations: { ...readySetup.operations, install: false },
    },
  ])("refuses changed or non-ready setup before mutation %j", async (change) => {
    invoke.mockResolvedValue({ ...readySetup, ...change });
    await expect(
      runInstallCommand("fixture-project", installOptions, command),
    ).rejects.toMatchObject({ code: "FACTORY_INSTALL_PRECONDITION_CHANGED" });
    expect(invoke).toHaveBeenCalledOnce();
  });
  it.each([{ serverId: "other-host" }, { projectId: "other-project" }])(
    "rejects setup identity drift %j",
    async (change) => {
      invoke.mockResolvedValue({ ...readySetup, ...change });
      await expect(
        runInstallCommand("fixture-project", installOptions, command),
      ).rejects.toMatchObject({ code: "FACTORY_IDENTITY_MISMATCH" });
      expect(invoke).toHaveBeenCalledOnce();
    },
  );
  it.each([
    { ...applied, operationId: "wrong-attempt" },
    { ...applied, serverId: "other-host" },
    { ...applied, setup: { ...applied.setup, installationId: "wrong-installation" } },
    null,
  ])("preserves uncertainty after dispatch for invalid result %j", async (result) => {
    invoke.mockResolvedValueOnce(readySetup).mockResolvedValueOnce(result);
    await expect(
      runInstallCommand("fixture-project", installOptions, command),
    ).rejects.toMatchObject({
      code: "FACTORY_INSTALL_UNCERTAIN",
      details: { operationId: "install-attempt", reconciliationRequired: true },
    });
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledOnce();
  });
  it("does not retry transport loss after dispatch", async () => {
    invoke.mockResolvedValueOnce(readySetup).mockRejectedValueOnce(new Error("Response lost"));
    await expect(
      runInstallCommand("fixture-project", installOptions, command),
    ).rejects.toMatchObject({ code: "FACTORY_INSTALL_UNCERTAIN" });
    expect(invoke).toHaveBeenCalledTimes(2);
  });
  it.each(["refused", "uncertain"])(
    "retains native %s details and returns a command failure",
    async (outcome) => {
      const result = {
        schemaVersion: 1,
        serverId: "fixture-host",
        projectId: "fixture-project",
        operationId: "install-attempt",
        outcome,
        reason: "Native reconciliation held",
        ...(outcome === "refused"
          ? { code: "held" }
          : { installationId: null, reconciliationRequired: true }),
      };
      invoke.mockResolvedValueOnce(readySetup).mockResolvedValueOnce(result);
      await expect(
        runInstallCommand("fixture-project", installOptions, command),
      ).rejects.toMatchObject({
        code: outcome === "refused" ? "FACTORY_INSTALL_REFUSED" : "FACTORY_INSTALL_UNCERTAIN",
        details: result,
      });
      expect(invoke).toHaveBeenCalledTimes(2);
    },
  );
  it("rejects serving identity changes after dispatch without replay", async () => {
    invoke.mockResolvedValueOnce(readySetup).mockImplementationOnce(async () => {
      info.mockReturnValue({ serverId: "changed-host", features: { plugins: true } });
      return applied;
    });
    await expect(
      runInstallCommand("fixture-project", installOptions, command),
    ).rejects.toMatchObject({ code: "FACTORY_INSTALL_UNCERTAIN" });
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});
