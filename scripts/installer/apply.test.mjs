import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { applyPlan, installationStatus, repair, uninstall } from "./apply.mjs";
import { fakeContext } from "./fakes.mjs";
import { AGENT_SCRIPT, INSTALLATION_SKILL } from "./host-installation.mjs";
import { createPlan } from "./plan.mjs";

const DEV_ID = "srv_dev123";
const REPOSITORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** A machine where every external command succeeds the way a real install would. */
function machine({ platform = "darwin", healthy = true, extraRules = [] } = {}) {
  const state = { healthy, installs: 0 };
  let context;
  const rules = [
    ...extraRules,
    ["docker ps", ""],
    ["docker image inspect", new Error("No such image")],
    [
      "docker build",
      (args) => {
        writeFileSync(args[args.indexOf("--iidfile") + 1], "sha256:dev\n");
      },
    ],
    [
      (command, args) => command === "bash" && args[0].endsWith("docker/gate/build.sh"),
      "sha256:gate",
    ],
    [
      (command, args) => command === "bash" && args[0].endsWith("docker/multiplex/install.sh"),
      (args) => {
        state.installs += 1;
        mkdirSync(args[1], { recursive: true });
        writeFileSync(path.join(args[1], ".container-installation"), "1\n");
        writeFileSync(
          path.join(args[1], ".env"),
          "PASEO_INSTANCE=paseo-0123456789ab\nPASEO_PASSWORD=dev-password\n",
        );
      },
    ],
    [(command, args) => command === "docker" && args[0] === "exec" && args.includes("-e"), DEV_ID],
    [
      (command, args) => command === "docker" && args[0] === "exec" && args.includes("-p"),
      "/home/paseo",
    ],
    [
      "tar -xf",
      (args) => {
        const release = args[3];
        for (const file of [INSTALLATION_SKILL, AGENT_SCRIPT]) {
          mkdirSync(path.dirname(path.join(release, file)), { recursive: true });
          writeFileSync(
            path.join(release, file),
            "Open INSTALLATION_SETTINGS_URL with INSTALLATION_CLIENT_COMMAND\n",
          );
        }
      },
    ],
    [
      "launchctl print",
      (args) =>
        state.registered && !args[1].includes("session-host")
          ? ""
          : new Error("Could not find service"),
    ],
    ["systemctl --user show", () => (state.registered ? "loaded" : "not-found")],
    ["loginctl show-user", "no"],
  ];
  context = fakeContext({
    platform,
    rules,
    fetch: async () => {
      if (!state.healthy) throw new Error("connection refused");
      return { ok: true, json: async () => ({ installationId: context.plan.installationId }) };
    },
    readyTimeoutMs: 30,
    serverModules: {
      hashDaemonPassword: (password) => `$2b$10$${password}`,
      getOrCreateServerId: () => "srv_host",
      connectInstallationDaemon: async (config) => ({
        getDaemonStatus: async () => ({ pid: 1 }),
        getDaemonConfig: async () => ({
          config: { cors: { allowedOrigins: [config.public.origin] } },
        }),
        close: async () => {},
      }),
    },
  });
  // The source checkout holds the real deployment scripts that adoption copies.
  const source = path.join(context.root, "source");
  mkdirSync(path.join(source, ".git"), { recursive: true });
  cpSync(path.join(REPOSITORY, "docker/multiplex"), path.join(source, "docker/multiplex"), {
    recursive: true,
  });
  return { context, state };
}

async function planFor(context, overrides = {}) {
  const { plan } = await createPlan(
    {
      devContainer: true,
      name: "Studio",
      projectsFolder: path.join(context.home, "dev"),
      remote: { mode: "tailscale" },
      sourceDirectory: path.join(context.root, "source"),
      ...overrides,
    },
    context,
  );
  context.plan = plan;
  context.run.calls.length = 0;
  return plan;
}

async function apply(plan, context) {
  const lines = [];
  const ok = await applyPlan(plan, context, (line) => lines.push(JSON.parse(JSON.stringify(line))));
  return { ok, lines };
}

describe("apply", () => {
  test("creates a complete installation with Dev behind the gate", async () => {
    const { context, state } = machine();
    const plan = await planFor(context);
    const { ok, lines } = await apply(plan, context);
    expect(lines.find((line) => line.status === "fail")).toBeUndefined();
    expect(ok).toBe(true);
    for (const line of lines.slice(0, -1)) {
      expect(Object.keys(line).toSorted()).toEqual(
        expect.arrayContaining(["message", "status", "step"]),
      );
      expect(["start", "done", "skip", "fail"]).toContain(line.status);
    }
    expect(lines.filter((line) => line.status === "done").map((line) => line.step)).toEqual(
      plan.steps,
    );
    expect(lines.at(-1)).toEqual({
      result: {
        origin: "https://box.example.ts.net:44444",
        localOrigin: "http://localhost:6770",
        passwordFile: plan.paths.ownerPassword,
        name: "Studio",
      },
    });
    expect(statSync(plan.paths.root).mode & 0o777).toBe(0o700);
    expect(statSync(plan.paths.ownerPassword).mode & 0o777).toBe(0o600);
    expect(
      readFileSync(path.join(plan.paths.coordinatorState, "installation-name.json"), "utf8"),
    ).toBe('{"name":"Studio"}');

    const install = context.run.calls.find((call) =>
      call.args[0]?.endsWith("docker/multiplex/install.sh"),
    );
    expect(install.args.slice(1)).toEqual([plan.paths.container, "sha256:dev"]);
    expect(install.options.env).toMatchObject({
      PASEO_NETWORK_MODE: "gate",
      PASEO_INSTALLATION_PENDING: "1",
      PASEO_GATE_IMAGE: "sha256:gate",
      PASEO_PUBLIC_HOSTNAME: "box.example.ts.net",
      PASEO_GATE_RELAY_PORT: "6768",
      PASEO_GATE_SUBNET: "172.31.250.0/24",
      PASEO_GATE_ROUTES: "box.example.ts.net:44444",
      PASEO_CORS_ORIGINS:
        "https://box.example.ts.net:44444,http://localhost:6770,http://127.0.0.1:6770",
    });
    expect(state.installs).toBe(1);

    const config = JSON.parse(readFileSync(plan.paths.coordinatorConfig, "utf8"));
    expect(config.public.environments).toEqual([
      { kind: "container", serverId: DEV_ID, endpoint: "box.example.ts.net:44446", useTls: true },
      { kind: "host", serverId: "srv_host", endpoint: "box.example.ts.net:44445", useTls: true },
    ]);
    expect(config.container).toEqual({ endpoint: "127.0.0.1:6768", password: "dev-password" });
    expect(config.host.launchdService).toBe(`gui/501/${plan.services.host}`);
    expect(config.access).toEqual({ remote: "tailscale" });
    expect(config.deployment).toEqual({
      installRoot: plan.paths.root,
      sourceDirectory: plan.paths.source,
      hostHome: plan.paths.hostHome,
      hostReleaseLink: plan.paths.hostReleaseLink,
      coordinator: {
        releaseLink: plan.paths.coordinatorReleaseLink,
        service: { launchdService: `gui/501/${plan.services.coordinator}` },
      },
      containerDirectory: plan.paths.container,
      containerHome: path.join(plan.paths.container, "data", "home"),
    });
    // Services and the interface run through links that upgrades repoint.
    expect(realpathSync(plan.paths.hostReleaseLink)).toBe(realpathSync(plan.paths.release));
    expect(config.webDistDir.startsWith(plan.paths.coordinatorReleaseLink)).toBe(true);

    const plist = readFileSync(
      path.join(context.home, "Library/LaunchAgents", `${plan.services.host}.plist`),
      "utf8",
    );
    expect(plist).toContain("<key>ExitTimeOut</key><integer>30</integer>");
    const commands = context.run.commands();
    expect(commands).toContain(
      `launchctl bootstrap gui/501 ${path.join(context.home, "Library/LaunchAgents", `${plan.services.coordinator}.plist`)}`,
    );
    expect(commands).toContain("tailscale serve --bg --https=44444 http://127.0.0.1:6770");
    expect(commands).toContain("tailscale serve --bg --https=44446 http://127.0.0.1:6768");
    // Guest credentials reach Dev; the Host's never do.
    const copied = context.run.calls.filter(
      (call) => call.command === "docker" && call.options.input !== undefined,
    );
    expect(copied.map((call) => path.basename(call.args.at(-1)))).toEqual(
      expect.arrayContaining(["client.json", "installation-agent.mjs"]),
    );
    const client = copied.find((call) => call.args.at(-1).endsWith("/client.json"));
    expect(JSON.parse(client.options.input.toString()).kind).toBe("container-agent");
    expect(
      copied.some((call) => call.options.input.toString().includes('"kind": "host-agent"')),
    ).toBe(false);

    const journal = JSON.parse(readFileSync(plan.paths.journal, "utf8"));
    expect(journal.completedAt).toBeDefined();
    expect(JSON.stringify(journal)).not.toContain("dev-password");
  });

  test("a failed step resumes after the last completed one", async () => {
    const { context, state } = machine({ healthy: false });
    const plan = await planFor(context);
    const first = await apply(plan, context);
    expect(first.ok).toBe(false);
    expect(first.lines.at(-1)).toMatchObject({
      step: "ready",
      status: "fail",
      fix: expect.any(String),
    });
    const journal = JSON.parse(readFileSync(plan.paths.journal, "utf8"));
    expect(journal.steps.ready.status).toBe("fail");
    expect(journal.steps.services.status).toBe("done");

    state.healthy = true;
    state.registered = true;
    context.run.calls.length = 0;
    const second = await apply(plan, context);
    expect(second.ok).toBe(true);
    const before = plan.steps.slice(0, plan.steps.indexOf("ready"));
    expect(second.lines.filter((line) => line.status === "skip").map((line) => line.step)).toEqual(
      before,
    );
    expect(
      second.lines.find((line) => line.step === "ready" && line.status === "done"),
    ).toBeDefined();
    expect(state.installs).toBe(1);
    expect(context.run.commands().some((command) => command.startsWith("docker build"))).toBe(
      false,
    );
    expect(second.lines.at(-1).result.origin).toBe("https://box.example.ts.net:44444");
  });

  test("an installation from another plan is never overwritten", async () => {
    const { context } = machine();
    const plan = await planFor(context, { devContainer: false, remote: { mode: "local" } });
    expect((await apply(plan, context)).ok).toBe(true);
    const other = { ...plan, installationId: "00000000-0000-4000-8000-999999999999" };
    await expect(applyPlan(other, context, () => {})).rejects.toThrow("never overwritten");
  });

  test("files left in the installation folder without a journal are refused", async () => {
    const { context } = machine();
    const plan = await planFor(context, { devContainer: false, remote: { mode: "local" } });
    mkdirSync(path.join(context.root, "host"), { recursive: true });
    writeFileSync(path.join(context.root, "host", "keep"), "x");
    await expect(applyPlan(plan, context, () => {})).rejects.toThrow("never overwritten");
  });

  test("a plan for another root or platform is refused", async () => {
    const { context } = machine();
    const plan = await planFor(context, { devContainer: false, remote: { mode: "local" } });
    await expect(applyPlan({ ...plan, platform: "linux" }, context, () => {})).rejects.toThrow(
      "not darwin",
    );
    await expect(
      applyPlan({ ...plan, paths: { ...plan.paths, root: "/elsewhere" } }, context, () => {}),
    ).rejects.toThrow("not ");
  });

  test("Host-only and local on Linux makes no Docker or Tailscale calls", async () => {
    const { context } = machine({ platform: "linux" });
    const plan = await planFor(context, {
      devContainer: false,
      remote: { mode: "local" },
      name: "Vorteo",
    });
    const { ok, lines } = await apply(plan, context);
    expect(ok).toBe(true);
    const commands = context.run.calls.map((call) => call.command);
    expect(commands).not.toContain("docker");
    expect(commands).not.toContain("tailscale");
    expect(commands).toContain("systemctl");
    // The default name is not stored, so the interface shows "Vorteo".
    expect(existsSync(path.join(plan.paths.coordinatorState, "installation-name.json"))).toBe(
      false,
    );
    const services = lines.find((line) => line.step === "services" && line.status === "done");
    expect(services.fix).toBe("sudo loginctl enable-linger owner");
    const config = JSON.parse(readFileSync(plan.paths.coordinatorConfig, "utf8"));
    expect(config.public.origin).toBe("http://localhost:6770");
    expect(config.container).toBeUndefined();
    expect(config.host.systemdService).toEqual({
      kind: "systemd-user",
      uid: 501,
      unit: `${plan.services.host}.service`,
    });
    expect(
      existsSync(
        path.join(context.home, ".config/systemd/user", `${plan.services.coordinator}.service`),
      ),
    ).toBe(true);
    expect(lines.at(-1).result).toMatchObject({
      origin: "http://localhost:6770",
      localOrigin: "http://localhost:6770",
    });
  });

  test("adoption refreshes the deployment scripts and switches to gate mode in place", async () => {
    const { context } = machine();
    const legacy = path.join(context.home, "paseo-instance");
    mkdirSync(legacy);
    writeFileSync(path.join(legacy, ".container-installation"), "1\n");
    writeFileSync(
      path.join(legacy, ".env"),
      "PASEO_INSTANCE=paseo-abcdefabcdef\nPASEO_PASSWORD=dev-password\n",
    );
    writeFileSync(path.join(legacy, "common.sh"), "# old\n");
    mkdirSync(path.join(legacy, "data"));
    const plan = await planFor(context);
    expect(plan.kind).toBe("adopt");
    const { ok } = await apply(plan, context);
    expect(ok).toBe(true);
    expect(readFileSync(path.join(legacy, "common.sh.before-installer"), "utf8")).toBe("# old\n");
    expect(existsSync(path.join(legacy, "gate.sh"))).toBe(true);
    expect(existsSync(path.join(legacy, "data"))).toBe(true);
    const enable = context.run.calls.find((call) => call.args[0] === path.join(legacy, "gate.sh"));
    expect(enable.args[1]).toBe("enable");
    expect(enable.options.env).toMatchObject({
      PASEO_IMAGE: "sha256:dev",
      PASEO_NETWORK_MODE: "gate",
    });
    expect(context.run.calls.some((call) => call.args[0]?.endsWith("install.sh"))).toBe(false);
    expect(
      context.run.calls.some(
        (call) => call.command === "docker" && call.args.includes("paseo-abcdefabcdef-paseo-1"),
      ),
    ).toBe(true);
  });
});

describe("lifecycle", () => {
  test("status, repair and uninstall --keep-data work from the journal", async () => {
    const { context, state } = machine();
    const plan = await planFor(context);
    await apply(plan, context);
    state.registered = true;

    const status = await installationStatus(context);
    expect(status).toMatchObject({
      installationId: plan.installationId,
      state: "installed",
      origin: "https://box.example.ts.net:44444",
      services: { host: { registered: true }, coordinator: { registered: true } },
      coordinator: { ready: true },
    });

    context.run.calls.length = 0;
    const repaired = [];
    expect(await repair(context, (line) => repaired.push(line))).toBe(true);
    const commands = context.run.commands();
    expect(commands).toContain(`launchctl bootout gui/501/${plan.services.host}`);
    expect(repaired.filter((line) => line.status === "done").map((line) => line.step)).toEqual([
      "services",
      "dev-create",
      "dev-identity",
      "ready",
      "remote",
    ]);

    context.run.calls.length = 0;
    const serve = JSON.stringify({
      Web: {
        "box.example.ts.net:44444": { Handlers: { "/": { Proxy: "http://127.0.0.1:6770" } } },
      },
    });
    const removed = [];
    const lifecycle = machine({ extraRules: [["tailscale serve status", serve]] });
    lifecycle.context.root = context.root;
    lifecycle.context.home = context.home;
    lifecycle.state.registered = true;
    const uninstalled = await uninstall(lifecycle.context, { keepData: true }, (line) =>
      removed.push(line),
    );
    expect(removed.filter((line) => line.status === "fail")).toEqual([]);
    expect(uninstalled).toBe(true);
    const removal = lifecycle.context.run.commands();
    expect(removal).toContain("tailscale serve --https=44444 off");
    expect(removal).not.toContain("tailscale serve --https=44445 off");
    expect(removal).toContain(`launchctl bootout gui/501/${plan.services.coordinator}`);
    expect(
      existsSync(path.join(plan.paths.host, "disabled-services", `${plan.services.host}.plist`)),
    ).toBe(true);
    expect(existsSync(plan.paths.ownerPassword)).toBe(true);
    expect((await installationStatus(lifecycle.context)).state).toBe("uninstalled");
  });

  test("uninstall without --keep-data keeps the source and Projects folders", async () => {
    const { context } = machine({ platform: "linux" });
    const plan = await planFor(context, { devContainer: false, remote: { mode: "local" } });
    await apply(plan, context);
    expect(await uninstall(context, { keepData: false }, () => {})).toBe(true);
    expect(existsSync(plan.paths.host)).toBe(false);
    expect(existsSync(plan.paths.state)).toBe(false);
    expect(existsSync(plan.paths.source)).toBe(true);
    expect(existsSync(plan.paths.projectsFolder)).toBe(true);
  });
  test("Linux Dev cleanup preserves the journal on failure and never mounts Projects", async () => {
    let refuseCleanup = true;
    const { context } = machine({
      platform: "linux",
      extraRules: [
        [
          (command, args) => command === "docker" && args.includes("/usr/bin/find"),
          () => {
            if (refuseCleanup) throw new Error("cleanup unavailable");
            return "";
          },
        ],
      ],
    });
    const plan = await planFor(context, { remote: { mode: "local" } });
    await apply(plan, context);
    mkdirSync(path.join(plan.paths.container, "data"));
    mkdirSync(path.join(plan.paths.container, "workspace"));
    expect(await uninstall(context, { keepData: false }, () => {})).toBe(false);
    expect(existsSync(path.join(plan.paths.state, "install.json"))).toBe(true);
    expect(existsSync(plan.paths.ownerPassword)).toBe(true);
    refuseCleanup = false;
    expect(await uninstall(context, { keepData: false }, () => {})).toBe(true);
    const cleanups = context.run.calls.filter((call) => call.args.includes("/usr/bin/find"));
    expect(cleanups.map((call) => call.args[call.args.indexOf("--mount") + 1])).toEqual([
      `type=bind,source=${plan.paths.container}/data,target=/cleanup`,
      `type=bind,source=${plan.paths.container}/data,target=/cleanup`,
      `type=bind,source=${plan.paths.container}/workspace,target=/cleanup`,
    ]);
    expect(existsSync(plan.paths.container)).toBe(false);
    expect(existsSync(plan.paths.projectsFolder)).toBe(true);
  });
});
