import { beforeEach, describe, expect, it, vi } from "vitest";
import { fixtureSnapshot } from "../../../../../plugins/factory/client/fixtures.js";
import { createFactoryCommand } from "./index.js";
import { runStatusCommand } from "./status.js";

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
  it("exposes only the implemented read-only status command", () => {
    expect(command.commands.map((entry) => entry.name())).toEqual(["status"]);
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
