import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { buildCoordinatorConfig, gateRoutes, interfaceOrigins } from "./coordinator-config.mjs";
import { fakeContext } from "./fakes.mjs";
import { chooseSubnet, createPlan, subnetsOverlap, validateAnswers } from "./plan.mjs";
import { choosePorts } from "./ports.mjs";

function setup(options = {}) {
  const context = fakeContext(options);
  const source = path.join(context.home, "vorteo", "source");
  mkdirSync(path.join(source, ".git"), { recursive: true });
  const answers = (overrides = {}) => ({
    devContainer: true,
    name: "Vorteo",
    projectsFolder: path.join(context.home, "dev"),
    remote: { mode: "tailscale" },
    sourceDirectory: source,
    ...overrides,
  });
  return { context, answers, source };
}

function dockerCalls(context) {
  return context.run.calls.filter((call) => call.command === "docker");
}

const combinations = [];
for (const platform of ["darwin", "linux"])
  for (const devContainer of [true, false])
    for (const remote of ["tailscale", "local"])
      for (const authKey of remote === "tailscale" ? [false, true] : [false])
        combinations.push({ platform, devContainer, remote, authKey });

describe("plan generation", () => {
  test.each(combinations)(
    "$platform, Dev $devContainer, $remote, auth key $authKey",
    async ({ platform, devContainer, remote, authKey }) => {
      const { context, answers } = setup({ platform });
      const keyFile = path.join(context.home, "authkey");
      writeFileSync(keyFile, "tskey-test");
      const { plan, summary } = await createPlan(
        answers({
          devContainer,
          remote: { mode: remote, ...(authKey ? { authKeyFile: keyFile } : {}) },
        }),
        context,
      );
      expect(plan.platform).toBe(platform);
      expect(plan.kind).toBe("new");
      expect(plan.services.manager).toBe(platform === "darwin" ? "launchd" : "systemd-user");
      expect(plan.paths.ownerPassword).toBe(path.join(context.root, "host", "owner-password"));
      expect(plan.paths.container).toBe(
        devContainer ? path.join(context.root, "container") : undefined,
      );
      expect(plan.revision).toBe("a".repeat(40));
      expect(Object.keys(plan.ports).toSorted()).toEqual(
        [
          "coordinator",
          "host",
          ...(devContainer ? ["devRelay"] : []),
          ...(remote === "tailscale" ? ["https", "hostHttps"] : []),
          ...(remote === "tailscale" && devContainer ? ["devHttps"] : []),
        ].toSorted(),
      );
      expect(plan.steps.includes("tailscale")).toBe(remote === "tailscale");
      expect(plan.steps.includes("remote")).toBe(remote === "tailscale");
      expect(plan.steps.some((step) => step.startsWith("dev-"))).toBe(devContainer);
      expect(plan.steps.indexOf("identity")).toBeLessThan(plan.steps.indexOf("release"));
      if (devContainer) {
        // The installation exists before Dev boots, and Dev exists before the Host starts.
        expect(plan.steps.indexOf("identity")).toBeLessThan(plan.steps.indexOf("dev-create"));
        expect(plan.steps.indexOf("dev-create")).toBeLessThan(plan.steps.indexOf("services"));
        expect(plan.dev.subnet).toBe("172.31.250.0/24");
      } else {
        expect(dockerCalls(context)).toEqual([]);
        expect(plan.executables.docker).toBeUndefined();
      }
      expect(plan.remote.authKeyFile).toBe(authKey ? keyFile : undefined);
      expect(summary.join("\n")).toContain(
        remote === "local"
          ? "http://localhost:6770 on this machine only"
          : "https://box.example.ts.net:44444",
      );
      // A plan is plain data: it survives a JSON round trip unchanged.
      expect(JSON.parse(JSON.stringify(plan))).toEqual(plan);
    },
  );

  test("Tailscale that still needs a login is accepted only with an auth key", async () => {
    const rules = [["tailscale status", JSON.stringify({ BackendState: "NeedsLogin" })]];
    const { context, answers } = setup({ rules });
    await expect(createPlan(answers(), context)).rejects.toThrow("Tailscale running and signed in");
    const keyFile = path.join(context.home, "authkey");
    writeFileSync(keyFile, "tskey-test");
    const { plan, summary } = await createPlan(
      answers({ remote: { mode: "tailscale", authKeyFile: keyFile } }),
      context,
    );
    expect(plan.remote.hostname).toBeUndefined();
    expect(summary.join("\n")).toContain("<this machine's tailnet name>");
  });

  test("missing Docker stops a Dev plan with the exact fix", async () => {
    const { context, answers } = setup({ rules: [["docker info", new Error("not running")]] });
    const error = await createPlan(answers(), context).catch((caught) => caught);
    expect(error.message).toContain("Docker running");
    expect(error.fix).toContain("Docker Desktop");
    await expect(createPlan(answers({ devContainer: false }), context)).resolves.toBeDefined();
  });

  test("busy ports and serve routes move to the next free port without taking a later default", async () => {
    const serve = JSON.stringify({ Web: { "box.example.ts.net:44444": {} }, TCP: { 44446: {} } });
    const { context, answers } = setup({
      busyPorts: [6768, 6770],
      rules: [["tailscale serve status", serve]],
    });
    const { plan, summary } = await createPlan(answers(), context);
    expect(plan.ports).toEqual({
      coordinator: 6772,
      host: 6771,
      devRelay: 6769,
      https: 44447,
      hostHttps: 44445,
      devHttps: 44448,
    });
    expect(summary.join("\n")).toContain("coordinator 6772 (default 6770 is in use)");
  });

  test("an existing installation is never planned over", async () => {
    const { context, answers } = setup();
    mkdirSync(path.join(context.root, "host"), { recursive: true });
    writeFileSync(
      path.join(context.root, "host", "installation.json"),
      JSON.stringify({ origin: "https://box.example.ts.net:44444" }),
    );
    const error = await createPlan(answers(), context).catch((caught) => caught);
    expect(error.message).toContain("already exists");
    expect(error.fix).toContain("https://box.example.ts.net:44444");
  });

  test("a standalone deployment is adopted in place, keeping its published port", async () => {
    const { context, answers } = setup();
    const legacy = path.join(context.home, "paseo-instance");
    mkdirSync(legacy);
    writeFileSync(path.join(legacy, ".container-installation"), "1\n");
    writeFileSync(
      path.join(legacy, ".env"),
      "PASEO_INSTANCE=paseo-abcdefabcdef\nPASEO_PASSWORD=x\n",
    );
    writeFileSync(
      path.join(legacy, "host-loopback.compose.json"),
      JSON.stringify({ services: { paseo: { ports: [{ published: "6790" }] } } }),
    );
    const { plan, summary } = await createPlan(answers(), context);
    expect(plan.kind).toBe("adopt");
    expect(plan.paths.container).toBe(legacy);
    expect(plan.dev.instance).toBe("paseo-abcdefabcdef");
    expect(plan.dev.legacy).toEqual({ kind: "legacy-container", path: legacy, gateMode: false });
    expect(plan.ports.devRelay).toBe(6790);
    expect(plan.steps).toContain("dev-adopt");
    expect(plan.steps).not.toContain("dev-create");
    expect(summary[0]).toContain("stay where they are");
    expect(JSON.stringify(plan)).not.toContain("PASEO_PASSWORD");

    // Without a Dev container the deployment is left alone.
    const hostOnly = await createPlan(answers({ devContainer: false }), context);
    expect(hostOnly.plan.kind).toBe("new");
    expect(hostOnly.plan.untouched).toEqual([legacy]);
  });

  test("answers are validated before anything is detected", () => {
    const home = "/Users/owner";
    const base = { devContainer: true, remote: { mode: "local" }, sourceDirectory: "/nowhere" };
    expect(() => validateAnswers({ ...base, devContainer: "yes" }, { home })).toThrow(
      "devContainer",
    );
    expect(() => validateAnswers({ ...base, remote: { mode: "vpn" } }, { home })).toThrow(
      "remote.mode",
    );
    expect(() =>
      validateAnswers({ ...base, remote: { mode: "local", authKeyFile: "/k" } }, { home }),
    ).toThrow("only applies to Tailscale");
    expect(() => validateAnswers({ ...base, name: "x".repeat(41) }, { home })).toThrow("1 to 40");
    expect(() => validateAnswers({ ...base, projectsFolder: "dev" }, { home })).toThrow("absolute");
    expect(() =>
      validateAnswers({ ...base, projectsFolder: "/Users/owner/my dev" }, { home }),
    ).toThrow("cannot mount");
    expect(() => validateAnswers({ ...base, version: "v1; rm" }, { home })).toThrow("not a tag");
    expect(() => validateAnswers(base, { home })).toThrow("not a Git checkout");
  });

  test("the Projects folder must stay outside the installation folder", async () => {
    const { context, answers } = setup();
    await expect(
      createPlan(answers({ projectsFolder: path.join(context.root, "projects") }), context),
    ).rejects.toThrow("inside");
  });

  test("an unsupported platform is refused", async () => {
    const { context, answers } = setup({ platform: "win32" });
    await expect(createPlan(answers(), context)).rejects.toThrow("macOS and Linux");
  });
});

describe("port and subnet choice", () => {
  test("fixed ports are kept even when busy", async () => {
    const ports = await choosePorts({
      wanted: ["coordinator", "devRelay"],
      isPortFree: async () => false,
      fixed: { devRelay: 6768 },
    }).catch((error) => error);
    expect(ports.message).toContain("No free port");
    await expect(
      choosePorts({
        wanted: ["devRelay"],
        isPortFree: async () => false,
        fixed: { devRelay: 6768 },
      }),
    ).resolves.toEqual({ devRelay: 6768 });
  });

  test("the gate subnet avoids every Docker network it overlaps", () => {
    expect(chooseSubnet([])).toBe("172.31.250.0/24");
    expect(chooseSubnet(["172.31.250.0/24", "172.31.251.0/24"])).toBe("172.31.252.0/24");
    expect(chooseSubnet(["172.31.250.0/23", "172.31.252.0/22"])).toBe("172.31.0.0/24");
    expect(chooseSubnet(["172.31.0.0/16"])).toBe("172.30.0.0/24");
    expect(chooseSubnet(["fd00::/64", "172.17.0.0/16"])).toBe("172.31.250.0/24");
    expect(subnetsOverlap("172.16.0.0/12", "172.31.250.0/24")).toBe(true);
    expect(subnetsOverlap("10.0.0.0/8", "172.31.250.0/24")).toBe(false);
  });
});

describe("coordinator configuration", () => {
  async function configFor(answerOverrides) {
    const { context, answers } = setup();
    const { plan } = await createPlan(answers(answerOverrides), context);
    return {
      plan,
      config: buildCoordinatorConfig({
        plan,
        hostname: "box.example.ts.net",
        hostServerId: "srv_host",
        containerServerId: "srv_dev",
        hostPassword: "host-password",
        containerPassword: "dev-password",
        hashes: { owner: "$2b$owner", hostAgent: "a".repeat(64), containerAgent: "b".repeat(64) },
        hostService: { launchdService: "gui/501/local.vorteo.x.host" },
        coordinatorService: { launchdService: "gui/501/local.vorteo.x.installation" },
      }),
    };
  }

  test("Host-only omits the container and lists only the Host", async () => {
    const { plan, config } = await configFor({ devContainer: false });
    expect(config.container).toBeUndefined();
    expect(config.public.environments).toEqual([
      { kind: "host", serverId: "srv_host", endpoint: "box.example.ts.net:44445", useTls: true },
    ]);
    expect(config.access).toEqual({ remote: "tailscale" });
    expect(config.deployment).toEqual({
      installRoot: plan.paths.root,
      sourceDirectory: plan.paths.source,
      hostHome: plan.paths.hostHome,
      hostReleaseLink: plan.paths.hostReleaseLink,
      coordinator: {
        releaseLink: plan.paths.coordinatorReleaseLink,
        service: { launchdService: "gui/501/local.vorteo.x.installation" },
      },
    });
  });

  test("local access serves exactly http://localhost:<port> with loopback environments", async () => {
    const { plan, config } = await configFor({ remote: { mode: "local" } });
    // Dev reaches the local-only coordinator through the gate's named route.
    expect(config.access).toEqual({
      remote: "none",
      gateRoute: { authority: "host.docker.internal:6770" },
    });
    expect(config.public.origin).toBe("http://localhost:6770");
    expect(config.public.environments).toEqual([
      { kind: "container", serverId: "srv_dev", endpoint: "127.0.0.1:6768", useTls: false },
      { kind: "host", serverId: "srv_host", endpoint: "127.0.0.1:6771", useTls: false },
    ]);
    expect(config.container).toEqual({ endpoint: "127.0.0.1:6768", password: "dev-password" });
    expect(config.deployment.containerDirectory).toBe(plan.paths.container);
    expect(gateRoutes(plan, undefined)).toEqual(["host.docker.internal:6770"]);
    expect(interfaceOrigins(plan)).toEqual(["http://localhost:6770", "http://127.0.0.1:6770"]);
  });

  test("Tailscale with Dev uses HTTPS endpoints for both environments", async () => {
    const { plan, config } = await configFor({});
    expect(config.public.origin).toBe("https://box.example.ts.net:44444");
    expect(config.public.environments.map((environment) => environment.endpoint)).toEqual([
      "box.example.ts.net:44446",
      "box.example.ts.net:44445",
    ]);
    expect(config.host).toMatchObject({
      endpoint: "127.0.0.1:6771",
      launchdService: "gui/501/local.vorteo.x.host",
      startupValidation: { node: "/opt/node/bin/node", home: plan.paths.hostHome },
    });
    expect(config.stateDir).toBe(plan.paths.coordinatorState);
    expect(gateRoutes(plan, "box.example.ts.net")).toEqual(["box.example.ts.net:44444"]);
  });
});

test("a deployment inside the installation folder cannot be adopted in place", async () => {
  const { context, answers } = setup();
  mkdirSync(context.root, { recursive: true });
  writeFileSync(path.join(context.root, ".container-installation"), "1\n");
  writeFileSync(path.join(context.root, ".env"), "PASEO_INSTANCE=paseo-x\nPASEO_PASSWORD=x\n");
  const error = await createPlan(answers(), context).catch((caught) => caught);
  expect(error.message).toContain("overlaps the installation folder");
  expect(error.fix).toContain(`| VORTEO_LEGACY_DEPLOYMENT='${context.root}' bash -s -- --root`);
  const alternateRoot = path.join(context.home, "vorteo-installation");
  expect(error.fix).toContain(`--root '${alternateRoot}'`);
  const { plan } = await createPlan(answers(), {
    ...context,
    root: alternateRoot,
    env: { ...context.env, VORTEO_LEGACY_DEPLOYMENT: context.root },
  });
  expect(plan.kind).toBe("adopt");
  expect(plan.paths.container).toBe(context.root);
  expect(plan.steps).toContain("dev-adopt");
  expect(plan.steps).not.toContain("dev-create");
});

// The coordinator reads what the engine writes; parse every shape with its real reader.
describe("coordinator configuration contract", () => {
  const reader = path.resolve(
    import.meta.dirname,
    "../../packages/server/dist/server/server/execution-installation/config.js",
  );
  test.skipIf(!existsSync(reader)).each(combinations)(
    "$platform, Dev $devContainer, $remote: the coordinator accepts the configuration",
    async ({ platform, devContainer, remote }) => {
      const { InstallationConfigSchema, readInstallationConfig } = await import(reader);
      const { context, answers } = setup({ platform });
      const { plan } = await createPlan(
        answers({ devContainer, remote: { mode: remote } }),
        context,
      );
      const darwin = platform === "darwin";
      const service = (label) =>
        darwin
          ? { launchdService: `gui/501/${label}` }
          : { systemdService: { kind: "systemd-user", uid: 501, unit: `${label}.service` } };
      const config = buildCoordinatorConfig({
        plan,
        hostname: "box.example.ts.net",
        hostServerId: "srv_host",
        containerServerId: "srv_dev",
        hostPassword: "host-password",
        containerPassword: "dev-password",
        hashes: {
          owner: "$2b$10$owner",
          hostAgent: "a".repeat(64),
          containerAgent: "b".repeat(64),
        },
        hostService: service(plan.services.host),
        coordinatorService: service(plan.services.coordinator),
      });
      // The full reader also checks platform rules, which hold only on this machine's platform.
      if (platform === process.platform) {
        const file = path.join(context.home, "coordinator.json");
        writeFileSync(file, JSON.stringify(config));
        expect(() => readInstallationConfig(file)).not.toThrow();
      } else {
        expect(() => InstallationConfigSchema.parse(config)).not.toThrow();
      }
    },
  );
});
