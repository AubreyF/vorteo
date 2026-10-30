// In-place upgrade of Host installations made by scripts/install-execution-host.mjs
// `install`. The fixture copies the shape that install() writes; every command is fake.
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { detectExisting, serviceArguments } from "./detect.mjs";
import { fakeContext } from "./fakes.mjs";
import {
  COORDINATOR_ENTRYPOINT,
  INSTALLATION_SKILL,
  SUPERVISOR_ENTRYPOINT,
  WEB_DIST,
} from "./host-installation.mjs";
import { adoptHost, createHostAdoptionPlan } from "./host-adoption.mjs";
import { plist } from "./launchd.mjs";

const REPOSITORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ID = "791360b7-0000-4000-8000-000000000001";
const INSTALLED = "1".repeat(40);
const NEWER = "2".repeat(40);
const DEV_ID = "srv_dev123";
const OLD_CONTAINER = "a".repeat(64);
const NEW_CONTAINER = "b".repeat(64);
const SECRETS = ["host-daemon-secret", "dev-daemon-secret"];

function touch(file, content = "") {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

/** A release folder as buildRelease leaves it, named by its commit like install() does. */
function release(root, revision) {
  const directory = path.join(root, "releases", revision);
  for (const file of [SUPERVISOR_ENTRYPOINT, COORDINATOR_ENTRYPOINT, INSTALLATION_SKILL])
    touch(path.join(directory, file));
  mkdirSync(path.join(directory, WEB_DIST), { recursive: true });
  return directory;
}

/**
 * An old Host root at `root` with its LaunchAgents and, unless `dev` is false, the
 * Tailscale-mode Dev deployment it pairs with on 127.0.0.1:6768.
 */
function legacyInstallation(home, { root, dev = true, sourceUpdates = false } = {}) {
  const current = release(root, INSTALLED);
  const agents = path.join(home, "Library", "LaunchAgents");
  const label = `local.vorteo.${ID}`;
  const hostHome = path.join(root, "state", "host");
  const projects = path.join(home, "dev");
  mkdirSync(projects, { recursive: true });
  touch(path.join(hostHome, "projects-folder.json"), JSON.stringify({ root: projects }));
  touch(path.join(root, "owner-password"), "owner-secret\n");
  const managed = path.join(root, "managed", "current");
  if (sourceUpdates) {
    mkdirSync(path.dirname(managed), { recursive: true });
    cpSync(current, path.join(root, "managed", "job-1"), { recursive: true });
    writeFileSync(
      path.join(root, "managed", "job-1", ".installation-source.json"),
      JSON.stringify({ sourceCommit: INSTALLED }),
    );
    symlinkSync(path.join(root, "managed", "job-1"), managed);
  }
  const hostEntrypoint = sourceUpdates
    ? path.join(managed, SUPERVISOR_ENTRYPOINT)
    : path.join(current, SUPERVISOR_ENTRYPOINT);
  const config = {
    public: {
      version: 1,
      installationId: ID,
      origin: "https://box.example.ts.net:44444",
      environments: [
        ...(dev
          ? [
              {
                kind: "container",
                serverId: DEV_ID,
                endpoint: "paseo-dev.example.ts.net",
                useTls: true,
              },
            ]
          : []),
        { kind: "host", serverId: "srv_host", endpoint: "box.example.ts.net:44445", useTls: true },
      ],
    },
    listenPort: 6770,
    webDistDir: sourceUpdates ? path.join(root, "web") : path.join(current, WEB_DIST),
    stateDir: path.join(root, "state", "coordinator"),
    ownerPasswordFile: path.join(root, "owner-password"),
    ownerPasswordHash: "$2b$10$owner",
    hostAgentTokenHash: "c".repeat(64),
    containerAgentTokenHash: "d".repeat(64),
    host: {
      endpoint: "127.0.0.1:6771",
      password: SECRETS[0],
      launchdService: `gui/501/${label}.host`,
      startupValidation: { node: "/opt/node/bin/node", entrypoint: hostEntrypoint, home: hostHome },
    },
    ...(dev ? { container: { endpoint: "127.0.0.1:6768", password: SECRETS[1] } } : {}),
    ...(dev
      ? {
          containerSourceUpdates: {
            sourceRepository: path.join(root, "dev-source.git"),
            toolingDirectory: path.join(root, "container-update-tools"),
            integrationRef: "refs/heads/integration",
            receiptFile: path.join(root, "state", "coordinator", "container-source.json"),
            docker: "/usr/bin/docker",
            containerId: OLD_CONTAINER,
            user: "paseo",
            node: "/usr/local/bin/node",
            home: "/home/paseo/.paseo",
            releaseRoot: "/home/paseo/releases",
            currentReleaseLink: "/home/paseo/releases/current",
          },
        }
      : {}),
    ...(sourceUpdates
      ? {
          sourceUpdates: {
            sourceRepository: path.join(root, "source.git"),
            releaseRoot: path.join(root, "managed"),
            currentReleaseLink: managed,
            webDirectory: path.join(root, "web"),
            toolingDirectory: path.join(root, "tools"),
            integrationRef: "refs/heads/integration",
          },
        }
      : {}),
  };
  touch(path.join(root, "coordinator.json"), JSON.stringify(config, null, 2));
  mkdirSync(config.stateDir, { recursive: true });
  const env = { HOME: home, PASEO_HOME: hostHome };
  const hostPlist = path.join(agents, `${label}.host.plist`);
  const coordinatorPlist = path.join(agents, `${label}.installation.plist`);
  touch(
    hostPlist,
    plist(`${label}.host`, ["/opt/node/bin/node", hostEntrypoint], env, `${root}/logs/host.log`),
  );
  touch(
    coordinatorPlist,
    plist(
      `${label}.installation`,
      [
        "/opt/node/bin/node",
        path.join(current, COORDINATOR_ENTRYPOINT),
        `${root}/coordinator.json`,
      ],
      env,
      `${root}/logs/installation.log`,
    ),
  );
  touch(
    path.join(root, "installation.json"),
    JSON.stringify({
      version: 1,
      installationId: ID,
      revision: INSTALLED,
      root,
      release: current,
      origin: config.public.origin,
      configFile: path.join(root, "coordinator.json"),
      hostHome,
      hostPlist,
      coordinatorPlist,
      hostService: `gui/501/${label}.host`,
      coordinatorService: `gui/501/${label}.installation`,
      plan: {
        docker: "/usr/bin/docker",
        tailscale: "/usr/bin/tailscale",
        httpsPort: 44444,
        hostHttpsPort: 44445,
      },
      phase: "started",
    }),
  );
  let deployment = null;
  if (dev) {
    deployment = path.join(home, "paseo-instance");
    touch(path.join(deployment, ".container-installation"), "1\n");
    touch(path.join(deployment, ".env"), "PASEO_INSTANCE=paseo-0123456789ab\nPASEO_PASSWORD=x\n");
    touch(
      path.join(deployment, "host-loopback.compose.json"),
      JSON.stringify({ services: { paseo: { ports: [{ published: "6768" }] } } }),
    );
    mkdirSync(path.join(deployment, "data", "home"), { recursive: true });
  }
  return { root, config, hostPlist, coordinatorPlist, deployment, current, projects };
}

/** Commands answer the way a Host with Docker, Tailscale and launchd would. */
function machine({ revision = INSTALLED, gateFails = 0, devId = DEV_ID, ...options } = {}) {
  const state = { gateMode: false, gateFailures: gateFails, restarts: [] };
  const rules = [
    [
      "git clone",
      (args) => {
        const target = args.at(-1);
        mkdirSync(path.join(target, ".git"), { recursive: true });
        cpSync(path.join(REPOSITORY, "docker"), path.join(target, "docker"), { recursive: true });
      },
    ],
    ["docker ps", ""],
    ["docker image inspect", new Error("No such image")],
    ["docker build", (args) => writeFileSync(args[args.indexOf("--iidfile") + 1], "sha256:dev\n")],
    ["docker inspect", () => (state.gateMode ? NEW_CONTAINER : OLD_CONTAINER)],
    [(command, args) => command === "bash" && args[0].endsWith("gate/build.sh"), "sha256:gate"],
    [
      (command, args) => command === "bash" && args[0].endsWith("gate.sh"),
      () => {
        if (state.gateFailures > 0) {
          state.gateFailures -= 1;
          return new Error("Dev did not become healthy in gate mode; rolling back.");
        }
        state.gateMode = true;
        return "Dev runs in gate mode.";
      },
    ],
    [(command, args) => command === "docker" && args[0] === "exec", devId],
    [
      "tar -xf",
      (args) => {
        for (const file of [SUPERVISOR_ENTRYPOINT, COORDINATOR_ENTRYPOINT, INSTALLATION_SKILL])
          touch(path.join(args[3], file));
      },
    ],
    ["launchctl print", ""],
    [
      "launchctl bootstrap",
      (args) => {
        state.restarts.push(path.basename(args[2]));
      },
    ],
  ];
  let context;
  context = fakeContext({
    rules,
    engineRevision: revision,
    readyTimeoutMs: 30,
    fetch: async () => ({ ok: true, json: async () => ({ installationId: ID }) }),
    serverModules: {
      hashDaemonPassword: (password) => `$2b$10$${password}`,
      getOrCreateServerId: () => "srv_host",
      connectInstallationDaemon: async () => ({
        getDaemonStatus: async () => ({ pid: 1 }),
        close: async () => {},
      }),
    },
    configReader: (file) => {
      const config = JSON.parse(readFileSync(file, "utf8"));
      if (!config.deployment?.coordinator) throw new Error("no deployment");
      return config;
    },
    ...options,
  });
  return { context, state };
}

function labRoot(context) {
  return path.join(context.home, ".local/share/vorteo-lab/host");
}

async function adopt(context, options = {}) {
  const lines = [];
  const outcome = path.join(context.home, "outcome.json");
  const ok = await adoptHost(context, { outcome, ...options }, (line) => lines.push(line));
  return { ok, lines, outcome: JSON.parse(readFileSync(outcome, "utf8")) };
}

describe("detection", () => {
  test("the lab layout's Host is a legacy Host installation, ahead of its own Dev deployment", async () => {
    const { context } = machine();
    const { root, deployment } = legacyInstallation(context.home, { root: labRoot(context) });
    const existing = await detectExisting(context);
    expect(existing).toMatchObject({
      kind: "legacy-host",
      paths: { root, host: root, coordinatorConfig: path.join(root, "coordinator.json") },
      installationId: ID,
      origin: "https://box.example.ts.net:44444",
      container: true,
    });
    expect(existing.candidates).not.toContain(deployment);
    for (const secret of SECRETS) expect(JSON.stringify(existing)).not.toContain(secret);
  });

  test("a non-default --root installs there instead of adopting an installation elsewhere", async () => {
    const { context } = machine();
    legacyInstallation(context.home, { root: labRoot(context) });
    const trial = { ...context, root: path.join(context.home, "vorteo-trial") };
    expect(await detectExisting(trial)).toEqual({ kind: "none", paths: {} });
    // Pointing --root at the old installation itself still offers to upgrade it.
    const here = { ...context, root: labRoot(context) };
    expect(await detectExisting(here)).toMatchObject({ kind: "legacy-host" });
  });

  test("an arbitrary root is found through its coordinator's LaunchAgent", async () => {
    const { context } = machine();
    const root = path.join(context.home, "Installations", "vorteo-host");
    legacyInstallation(context.home, { root });
    expect(await detectExisting(context)).toMatchObject({ kind: "legacy-host", paths: { root } });
  });

  test("service arguments come from plists and systemd units alike", () => {
    expect(serviceArguments(plist("x", ["/n", "/a&b/main.js", "/c.json"], {}, "/l"))).toEqual([
      "/n",
      "/a&b/main.js",
      "/c.json",
    ]);
    expect(serviceArguments('[Service]\nExecStart="/n" "/r/main.js" "/a%%b.json"\n')).toEqual([
      "/n",
      "/r/main.js",
      "/a%b.json",
    ]);
  });
});

describe("plan", () => {
  test("upgrades in place on the releases the services run, without secrets", async () => {
    const { context } = machine();
    const { root, deployment, current } = legacyInstallation(context.home, {
      root: labRoot(context),
    });
    context.root = root;
    const { plan, summary } = await createHostAdoptionPlan(context);
    expect(plan).toMatchObject({
      kind: "adopt-host",
      installationId: ID,
      origin: "https://box.example.ts.net:44444",
      ports: { coordinator: 6770, host: 6771, devRelay: 6768, https: 44444, devHttps: 44446 },
      paths: {
        root,
        host: root,
        source: path.join(root, "source"),
        release: current,
        hostReleaseLink: path.join(root, "releases", "host-current"),
        coordinatorReleaseLink: path.join(root, "releases", "coordinator-current"),
        container: deployment,
      },
      services: { manager: "launchd", host: `local.vorteo.${ID}.host` },
      dev: { instance: "paseo-0123456789ab", extraRoutes: ["box.example.ts.net:44444"] },
      adoption: { build: false, hostTarget: current, restartHost: true },
    });
    expect(plan.steps).toEqual([
      "adopt-backup",
      "tailscale",
      "adopt-source",
      "dev-images",
      "dev-adopt",
      "dev-identity",
      "adopt-links",
      "adopt-config",
      "adopt-services",
      "remote",
      "adopt-restart",
      "ready",
      "finish",
    ]);
    expect(summary[0]).toContain("in place");
    for (const secret of [...SECRETS, "owner-secret"])
      expect(JSON.stringify(plan)).not.toContain(secret);
  });

  test("an older coordinator release is replaced by a build of the installer's commit", async () => {
    const { context } = machine({ revision: NEWER });
    const { root } = legacyInstallation(context.home, { root: labRoot(context), dev: false });
    context.root = root;
    const { plan } = await createHostAdoptionPlan(context);
    const built = path.join(root, "releases", NEWER);
    expect(plan.paths.release).toBe(built);
    expect(plan.adoption).toMatchObject({ build: true, hostTarget: built });
    expect(plan.steps).toContain("release");
    expect(plan.steps).not.toContain("dev-adopt");
  });

  test("a root that is not an old Host installation is refused with the fix", async () => {
    const { context } = machine();
    await expect(createHostAdoptionPlan(context)).rejects.toMatchObject({
      fix: expect.stringContaining("--root"),
    });
  });
});

describe("apply", () => {
  test("moves the lab Host to the installer layout and Dev to gate mode", async () => {
    const { context, state } = machine();
    const legacy = legacyInstallation(context.home, { root: labRoot(context) });
    const { root, hostPlist, coordinatorPlist, current } = legacy;
    context.root = root;
    const { ok, outcome, lines } = await adopt(context);
    expect(lines.find((line) => line.status === "fail")).toBeUndefined();
    expect(ok).toBe(true);
    expect(outcome.status).toBe("succeeded");

    const config = JSON.parse(readFileSync(path.join(root, "coordinator.json"), "utf8"));
    const hostLink = path.join(root, "releases", "host-current");
    const coordinatorLink = path.join(root, "releases", "coordinator-current");
    expect(config.deployment).toEqual({
      installRoot: root,
      sourceDirectory: path.join(root, "source"),
      hostHome: path.join(root, "state", "host"),
      hostReleaseLink: hostLink,
      coordinator: {
        releaseLink: coordinatorLink,
        service: { launchdService: `gui/501/local.vorteo.${ID}.installation` },
      },
      containerDirectory: legacy.deployment,
      containerHome: path.join(legacy.deployment, "data", "home"),
    });
    expect(config).toMatchObject({ claudeHostRefresh: true, codexHostRefresh: true });
    expect(config.public.environments[0]).toEqual({
      kind: "container",
      serverId: DEV_ID,
      endpoint: "box.example.ts.net:44446",
      useTls: true,
    });
    // Credentials, identity and the loopback endpoint the gate relay now publishes stay.
    expect(config.host.password).toBe(SECRETS[0]);
    expect(config.container).toEqual({ endpoint: "127.0.0.1:6768", password: SECRETS[1] });
    expect(config.public.installationId).toBe(ID);
    expect(config.containerSourceUpdates.containerId).toBe(NEW_CONTAINER);
    expect(config.webDistDir).toBe(path.join(coordinatorLink, WEB_DIST));
    expect(config.host.startupValidation.entrypoint).toBe(
      path.join(hostLink, SUPERVISOR_ENTRYPOINT),
    );
    expect(readFileSync(path.join(root, "coordinator.json.before-adoption"), "utf8")).toContain(
      "paseo-dev.example.ts.net",
    );

    expect(realpathSync(hostLink)).toBe(realpathSync(current));
    expect(readlinkSync(coordinatorLink)).toBe(current);
    expect(serviceArguments(readFileSync(hostPlist, "utf8"))[1]).toBe(
      path.join(hostLink, SUPERVISOR_ENTRYPOINT),
    );
    expect(serviceArguments(readFileSync(coordinatorPlist, "utf8"))[1]).toBe(
      path.join(coordinatorLink, COORDINATOR_ENTRYPOINT),
    );
    expect(
      existsSync(
        path.join(root, "state", "adoption", path.basename(hostPlist) + ".before-adoption"),
      ),
    ).toBe(true);

    const commands = context.run.commands();
    const enable = context.run.calls.find((call) => call.args[0]?.endsWith("gate.sh"));
    expect(enable.args).toEqual([path.join(legacy.deployment, "gate.sh"), "enable"]);
    expect(enable.options.env).toMatchObject({
      PASEO_IMAGE: "sha256:dev",
      PASEO_PUBLIC_HOSTNAME: "box.example.ts.net",
      PASEO_GATE_RELAY_PORT: "6768",
      PASEO_GATE_ROUTES: "box.example.ts.net:44444",
      PASEO_PROJECTS_FOLDER: realpathSync(legacy.projects),
    });
    expect(enable.options.env.PASEO_CORS_ORIGINS.split(",")[0]).toBe(
      "https://box.example.ts.net:44444",
    );
    expect(commands).toContain("tailscale serve --bg --https=44446 http://127.0.0.1:6768");
    expect(commands.some((command) => command.includes("--https=44444"))).toBe(false);
    // The coordinator restarts last: it may be the process that launched this command.
    expect(state.restarts).toEqual([path.basename(hostPlist), path.basename(coordinatorPlist)]);

    expect(await detectExisting(context)).toMatchObject({
      kind: "current",
      state: "installed",
      paths: { root, host: root },
    });
    // A second run finds the finished journal and changes nothing.
    context.run.calls.length = 0;
    expect((await adopt(context)).ok).toBe(true);
    expect(context.run.calls).toEqual([]);
  });

  test("a failed gate switch leaves the configuration alone and a rerun resumes", async () => {
    const { context } = machine({ gateFails: 1 });
    const { root } = legacyInstallation(context.home, { root: labRoot(context) });
    context.root = root;
    const original = readFileSync(path.join(root, "coordinator.json"), "utf8");
    const first = await adopt(context);
    expect(first.ok).toBe(false);
    expect(first.outcome).toMatchObject({
      status: "failed",
      detail: expect.stringContaining("gate"),
    });
    expect(readFileSync(path.join(root, "coordinator.json"), "utf8")).toBe(original);
    expect(await detectExisting(context)).toMatchObject({ kind: "legacy-host", resume: true });
    const second = await adopt(context);
    expect(second.ok).toBe(true);
    expect(second.lines.find((line) => line.step === "adopt-source").status).toBe("skip");
  });

  test("a Dev that answers with another identity is never paired", async () => {
    const { context } = machine({ devId: "srv_someone_else" });
    const { root } = legacyInstallation(context.home, { root: labRoot(context) });
    context.root = root;
    const original = readFileSync(path.join(root, "coordinator.json"), "utf8");
    const { ok, outcome } = await adopt(context);
    expect(ok).toBe(false);
    expect(outcome.detail).toContain("srv_someone_else");
    expect(readFileSync(path.join(root, "coordinator.json"), "utf8")).toBe(original);
  });

  test("Host source updates keep the Host's own release link and launcher", async () => {
    const { context, state } = machine();
    const legacy = legacyInstallation(context.home, {
      root: labRoot(context),
      dev: false,
      sourceUpdates: true,
    });
    context.root = legacy.root;
    const hostBefore = readFileSync(legacy.hostPlist, "utf8");
    const { ok } = await adopt(context);
    expect(ok).toBe(true);
    const config = JSON.parse(readFileSync(path.join(legacy.root, "coordinator.json"), "utf8"));
    expect(config.deployment.hostReleaseLink).toBe(legacy.config.sourceUpdates.currentReleaseLink);
    expect(config.host.startupValidation).toEqual(legacy.config.host.startupValidation);
    expect(config.webDistDir).toBe(legacy.config.webDistDir);
    expect(readFileSync(legacy.hostPlist, "utf8")).toBe(hostBefore);
    expect(existsSync(path.join(legacy.root, "releases", "host-current"))).toBe(false);
    expect(state.restarts).toEqual([path.basename(legacy.coordinatorPlist)]);
  });
});

describe("coordinator configuration contract", () => {
  const reader = path.resolve(
    import.meta.dirname,
    "../../packages/server/dist/server/server/execution-installation/config.js",
  );
  test.skipIf(!existsSync(reader) || process.platform !== "darwin")(
    "the coordinator accepts the adopted configuration, with and without source updates",
    async () => {
      const { readInstallationConfig } = await import(reader);
      for (const sourceUpdates of [false, true]) {
        const { context } = machine({ configReader: readInstallationConfig });
        const legacy = legacyInstallation(context.home, {
          root: labRoot(context),
          sourceUpdates,
        });
        context.root = legacy.root;
        const { ok, outcome } = await adopt(context);
        expect(outcome).toMatchObject({ status: "succeeded" });
        expect(ok).toBe(true);
      }
    },
  );
});
