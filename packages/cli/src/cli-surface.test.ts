import { describe, expect, it } from "vitest";
import { createCli } from "./cli.js";
import { admitOriginWithClient, type OriginCommandClient } from "./commands/daemon/origins.js";
import type { DaemonOriginAdmissionInspectResponse } from "@getpaseo/protocol/messages";

describe("canonical CLI surface", () => {
  it("requires exact host, correlation and both approved lists for origin admission", () => {
    const daemon = createCli().commands.find((command) => command.name() === "daemon");
    const origins = daemon?.commands.find((command) => command.name() === "origins");
    const admit = origins?.commands.find((command) => command.name() === "admit");
    expect(admit?.helpInformation()).toContain("--expected-server-id");
    expect(admit?.helpInformation()).toContain("--request-id");
    expect(admit?.helpInformation()).toContain("--expected-persisted-origins");
    expect(admit?.helpInformation()).toContain("--expected-active-origins");
    expect(admit?.helpInformation()).toContain("--host");
    expect(admit?.helpInformation()).not.toContain("--account");
  });

  it("offers daemon host selection as a global option", () => {
    expect(createCli().helpInformation()).toContain("--host <host>");
  });

  it("shows project, workspace, and heartbeat commands while hiding worktree compatibility", () => {
    const cli = createCli();
    const help = cli.helpInformation();
    expect(help).toContain("project");
    expect(help).toContain("workspace");
    expect(help).toContain("heartbeat");
    expect(help).not.toContain("worktree");
  });

  it("offers identical top-level and daemon config reload commands", () => {
    const cli = createCli();
    const reload = cli.commands.find((command) => command.name() === "reload");
    const daemon = cli.commands.find((command) => command.name() === "daemon");
    const nestedReload = daemon?.commands.find((command) => command.name() === "reload");

    expect(reload?.helpInformation()).toContain("--host <host>");
    expect(reload?.helpInformation()).toContain("--json");
    expect(nestedReload?.helpInformation()).toContain("--host <host>");
    expect(nestedReload?.helpInformation()).toContain("--json");
  });

  it("names explicit workspace creation without exposing older syntax", () => {
    const run = createCli().commands.find((command) => command.name() === "run");
    const help = run?.helpInformation();
    expect(help).toContain("--new-workspace <local|worktree>");
    expect(help).not.toContain("--isolation");
    expect(help).not.toContain("--worktree <name>");
  });

  it("offers the worktree creation options on run", () => {
    const run = createCli().commands.find((command) => command.name() === "run");
    const help = run?.helpInformation();
    expect(help).toContain("--worktree-mode <mode>");
    expect(help).toContain("--worktree-slug <slug>");
    expect(help).toContain("--new-branch <name>");
    expect(help).toContain("--branch <name>");
    expect(help).toContain("--pr-number <n>");
    expect(help).toContain("--forge <forge>");
  });

  it("uses background for execution and reserves detach for ownership", () => {
    const run = createCli().commands.find((command) => command.name() === "run");
    expect(run?.helpInformation()).toContain("--background");
    expect(run?.helpInformation()).not.toContain("--detach");
  });

  it("offers thinking configuration when running, updating, and scheduling agents", () => {
    const cli = createCli();
    const run = cli.commands.find((command) => command.name() === "run");
    const agent = cli.commands.find((command) => command.name() === "agent");
    const update = agent?.commands.find((command) => command.name() === "update");
    const schedule = cli.commands.find((command) => command.name() === "schedule");
    const scheduleCreate = schedule?.commands.find((command) => command.name() === "create");

    expect(run?.helpInformation()).toContain("--thinking <id>");
    expect(update?.helpInformation()).toContain("--thinking <id>");
    expect(scheduleCreate?.helpInformation()).toContain("--thinking <id>");
  });

  it("offers opening an existing agent in the desktop app", () => {
    const agent = createCli().commands.find((command) => command.name() === "agent");
    const open = agent?.commands.find((command) => command.name() === "open");

    expect(open?.helpInformation()).toContain("<agent-id>");
    expect(open?.helpInformation()).toContain("--server <server-id>");
  });

  it("offers the complete local plugin lifecycle", () => {
    const plugin = createCli().commands.find((command) => command.name() === "plugin");

    expect(plugin?.commands.map((command) => command.name())).toEqual([
      "init",
      "ls",
      "status",
      "logs",
      "install",
      "update",
      "reload",
      "enable",
      "disable",
      "remove",
    ]);
    expect(
      plugin?.commands.find((command) => command.name() === "init")?.helpInformation(),
    ).toContain("--id <id>");
    expect(
      plugin?.commands.find((command) => command.name() === "install")?.helpInformation(),
    ).toContain("--id <id>");
  });
});

const originInput = {
  expectedServerId: "srv_cli",
  requestId: "42a6ee89-33e5-4b1a-8b10-d299d49a5e6e",
  origin: "https://preview.example",
  expectedPersistedOrigins: [],
  expectedActiveOrigins: [],
};
function originPort(mode: "applied" | "lost" | "uncertain" | "stale" = "applied") {
  const calls: Parameters<OriginCommandClient["admitOrigin"]>[0][] = [];
  const observation: DaemonOriginAdmissionInspectResponse["payload"] = {
    requestId: "read",
    serverId: "srv_cli",
    observedAt: "2026-10-09T00:00:00Z",
    state: "ready",
    reason: null,
    persistedOrigins: [],
    activeOrigins: [],
  };
  if (mode === "stale") observation.persistedOrigins = ["https://other.example"];
  const port: OriginCommandClient = {
    getLastServerInfoMessage: () => ({
      status: "server_info",
      serverId: "srv_cli",
      hostname: null,
      version: null,
      features: { guardedOriginAdmission: true },
    }),
    inspectOriginAdmission: async () => observation,
    admitOrigin: async (input) => {
      calls.push(structuredClone(input));
      if (mode === "lost") throw new Error("response lost");
      if (mode === "uncertain")
        return {
          requestId: input.requestId ?? "",
          serverId: input.expectedServerId,
          observedAt: "2026-10-09T00:00:00Z",
          state: "uncertain",
          code: "uncertain",
          writeAttempted: true,
          reason: "native reconciliation hold",
        };
      return {
        requestId: input.requestId ?? "",
        serverId: input.expectedServerId,
        observedAt: "2026-10-09T00:00:00Z",
        state: "applied",
        origin: input.origin,
        addedToPersisted: true,
        addedToActive: true,
        persistedOrigins: [input.origin],
        activeOrigins: [input.origin],
      };
    },
  };
  return { port, calls, observation };
}

describe("guarded origin CLI transaction", () => {
  it("dispatches once after the exact fresh preconditions", async () => {
    const { port, calls } = originPort();
    const result = await admitOriginWithClient(port, originInput);
    expect(result.state).toBe("applied");
    expect(calls).toEqual([originInput]);
  });
  it("refuses changed preconditions without dispatch", async () => {
    const { port, calls } = originPort("stale");
    await expect(admitOriginWithClient(port, originInput)).rejects.toMatchObject({
      code: "ORIGIN_PRECONDITION_CHANGED",
    });
    expect(calls).toEqual([]);
  });
  it.each(["lost", "uncertain"] as const)(
    "keeps %s uncertainty and sends no second mutation",
    async (mode) => {
      const { port, calls } = originPort(mode);
      await expect(admitOriginWithClient(port, originInput)).rejects.toMatchObject({
        code: "ORIGIN_ADMISSION_UNCERTAIN",
      });
      expect(calls).toHaveLength(1);
      expect(calls[0].requestId).toBe(originInput.requestId);
    },
  );
  it("captures invocation before deferred inspection and rejects replaced native methods", async () => {
    const { port, calls, observation } = originPort();
    let resolve = (_value: DaemonOriginAdmissionInspectResponse["payload"]) => {};
    port.inspectOriginAdmission = () =>
      new Promise((done) => {
        resolve = done;
      });
    const input = { ...originInput, expectedPersistedOrigins: [], expectedActiveOrigins: [] };
    const result = admitOriginWithClient(port, input);
    input.requestId = "52a6ee89-33e5-4b1a-8b10-d299d49a5e6e";
    port.admitOrigin = async () => {
      throw new Error("replacement must never execute");
    };
    resolve(observation);
    await expect(result).rejects.toMatchObject({ code: "ORIGIN_PRECONDITION_CHANGED" });
    expect(calls).toEqual([]);
  });
});
