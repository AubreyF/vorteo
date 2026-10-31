#!/usr/bin/env node
// End-to-end install checks for the release workflow. Each command runs on a
// throwaway CI runner against a real installation made by install.sh.
//
//   install <full|host-only|wrap>   run install.sh as `curl | bash` would, record new services
//   wait-ready <scenario>           poll `status --json` until the expected environments are ready
//   assert-access <scenario>        welcome page, owner-access metadata and owner sign-in on localhost
//   assert-gate                     Dev isolation and gate audit log (Linux, Dev container scenarios)
//   assert-identity                 Dev kept the legacy deployment's server-id
//   assert-no-docker                the Host-only install never invoked Docker
//   uninstall                       `vorteo uninstall` removes the services it added
//   diagnose                        print status and service state after a failure
//
// Secrets: the owner password is read from its file, masked in GitHub logs and
// never printed. Diagnostics print status and service state, not credentials.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { isMainModule } from "../../is-main-module.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const stateDir = process.env.VORTEO_E2E_STATE ?? path.join(os.tmpdir(), "vorteo-e2e");

// Everything this file assumes about the installer, built in parallel by the
// installer workstreams. Adjust here when their interface settles.
export const CONTRACT = {
  home: path.join(os.homedir(), "vorteo"),
  passwordFile: path.join(os.homedir(), "vorteo", "host", "owner-password"),
  installedCli: path.join(os.homedir(), "vorteo", "source", "scripts", "installer", "main.mjs"),
  vorteoCommand: path.join(os.homedir(), ".local", "bin", "vorteo"),
  projectsFolder: path.join(os.homedir(), "dev"),
  // `--yes` takes every default: Dev container on, name Vorteo, Projects ~/dev.
  installArgs: {
    full: ["--yes", "--remote=local"],
    "host-only": ["--yes", "--no-dev-container", "--remote=local"],
    wrap: ["--yes", "--remote=local"],
  },
  uninstallArgs: ["uninstall", "--yes"],
  installEnv: ({ devImage, legacyDeployment, serviceFallback }) => ({
    // Install this checkout instead of downloading the latest release: the
    // commit under test has no release yet.
    VORTEO_INSTALL_SOURCE: repoRoot,
    // Prebuilt from the same commit with cached layers; the installer may build it itself.
    ...(devImage ? { VORTEO_DEV_IMAGE: devImage } : {}),
    // A hint only; the installer finds legacy deployments by their markers.
    ...(legacyDeployment ? { VORTEO_LEGACY_DEPLOYMENT: legacyDeployment } : {}),
    // Used only when the runner has no user systemd; see linux-user-systemd.sh.
    ...(serviceFallback ? { VORTEO_SERVICE_MANAGER: "process" } : {}),
  }),
  // `status --json` readers, tolerant of a list or a map of environments.
  environments(status) {
    const raw = status.environments ?? [];
    const list = Array.isArray(raw)
      ? raw
      : Object.entries(raw).map(([kind, value]) => Object.assign({ kind }, value));
    return list.map((environment) => ({
      kind: environment.kind === "dev" ? "container" : environment.kind,
      ready: environment.ready === true || environment.status === "ready",
      serverId: environment.serverId,
      container: environment.container ?? environment.containerName,
    }));
  },
  localUrl: (status) =>
    process.env.VORTEO_E2E_URL ??
    status.access?.local ??
    status.localUrl ??
    status.coordinator?.localUrl,
  gateLog: (status) => status.gate?.log ?? status.gate?.logFile,
};

const EXPECTED_KINDS = {
  full: ["container", "host"],
  "host-only": ["host"],
  wrap: ["container", "host"],
};

const isLinux = process.platform === "linux";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (options.check !== false && result.status !== 0) {
    const detail = options.quiet ? "" : `\n${result.stdout ?? ""}${result.stderr ?? ""}`;
    throw new Error(`${command} ${args.join(" ")} exited ${result.status}${detail}`);
  }
  return result;
}

function fail(message) {
  throw new Error(message);
}

function saveState(name, value) {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(path.join(stateDir, name), JSON.stringify(value, null, 2));
}

function loadState(name) {
  return JSON.parse(readFileSync(path.join(stateDir, name), "utf8"));
}

function step(message) {
  console.log(`- ${message}`);
}

// Services ------------------------------------------------------------------

function serviceNames() {
  if (process.platform === "darwin") {
    const labels = run("launchctl", ["list"])
      .stdout.split("\n")
      .slice(1)
      .map((line) => line.split("\t")[2])
      .filter(Boolean);
    return [...new Set(labels)];
  }
  if (process.env.VORTEO_E2E_SERVICE_FALLBACK === "1") return [];
  return run("systemctl", ["--user", "list-units", "--all", "--plain", "--no-legend"])
    .stdout.split("\n")
    .map((line) => line.trim().split(/\s+/)[0])
    .filter(Boolean);
}

// Install -------------------------------------------------------------------

function install(scenario) {
  const args = CONTRACT.installArgs[scenario] ?? fail(`Unknown scenario ${scenario}`);
  mkdirSync(CONTRACT.projectsFolder, { recursive: true });
  const before = serviceNames();
  const env = {
    ...process.env,
    ...CONTRACT.installEnv({
      devImage: process.env.VORTEO_E2E_DEV_IMAGE,
      legacyDeployment: process.env.VORTEO_E2E_LEGACY_DEPLOYMENT,
      serviceFallback: process.env.VORTEO_E2E_SERVICE_FALLBACK === "1",
    }),
  };
  step(`install.sh ${args.join(" ")} (piped to bash, no terminal)`);
  // The published command is `curl -fsSL <address> | bash`; feed the same script on stdin.
  const script = readFileSync(path.join(repoRoot, "install.sh"));
  run("bash", ["-s", "--", ...args], {
    input: script,
    env,
    stdio: ["pipe", "inherit", "inherit"],
  });
  const added = serviceNames().filter((name) => !before.includes(name));
  if (process.env.VORTEO_E2E_SERVICE_FALLBACK === "1") {
    step("user systemd unavailable: process fallback, service registration not asserted");
  } else if (added.length === 0) {
    fail("install.sh finished but registered no launchd agent or systemd user service.");
  } else {
    step(`registered services: ${added.join(", ")}`);
  }
  saveState("services.json", added);
}

// Status --------------------------------------------------------------------

function readStatus() {
  if (!existsSync(CONTRACT.installedCli)) fail(`${CONTRACT.installedCli} is missing.`);
  const result = run(process.execPath, [CONTRACT.installedCli, "status", "--json"], {
    check: false,
  });
  if (result.status !== 0) return { error: result.stderr.trim() || `exit ${result.status}` };
  try {
    return JSON.parse(result.stdout);
  } catch {
    return { error: "status --json printed invalid JSON" };
  }
}

function readiness(scenario, status) {
  const expected = EXPECTED_KINDS[scenario] ?? fail(`Unknown scenario ${scenario}`);
  const environments = CONTRACT.environments(status);
  const kinds = environments.map((environment) => environment.kind).sort();
  const missing = expected.filter(
    (kind) => !environments.some((environment) => environment.kind === kind && environment.ready),
  );
  const extra = kinds.filter((kind) => !expected.includes(kind));
  return { environments, missing, extra };
}

async function waitReady(scenario) {
  const deadline = Date.now() + Number(process.env.VORTEO_E2E_READY_SECONDS ?? 600) * 1000;
  let last;
  while (Date.now() < deadline) {
    const status = readStatus();
    last = status.error ? { error: status.error } : readiness(scenario, status);
    if (!status.error && last.missing.length === 0) {
      if (last.extra.length) fail(`Unexpected environments for ${scenario}: ${last.extra}`);
      step(`ready: ${last.environments.map((environment) => environment.kind).join(", ")}`);
      saveState("status.json", status);
      return status;
    }
    await sleep(5000);
  }
  fail(`Environments not ready in time: ${JSON.stringify(last)}`);
}

// Access --------------------------------------------------------------------

function httpRequest(url, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, { method, headers, timeout: 15000 }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () =>
        resolve({
          status: response.statusCode,
          headers: response.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        }),
      );
    });
    request.on("timeout", () => request.destroy(new Error(`${url} timed out`)));
    request.on("error", reject);
    if (body) request.write(body);
    request.end();
  });
}

function ownerPassword() {
  const password = readFileSync(CONTRACT.passwordFile, "utf8").trim();
  if (!password) fail(`${CONTRACT.passwordFile} is empty.`);
  if (process.env.GITHUB_ACTIONS) console.log(`::add-mask::${password}`);
  return password;
}

export async function assertWelcome(origin) {
  const page = await httpRequest(`${origin}/`);
  if (page.status !== 200 || !/text\/html/.test(page.headers["content-type"] ?? "")) {
    fail(`GET ${origin}/ answered ${page.status} ${page.headers["content-type"]}`);
  }
  if (!page.body.includes('<div id="root">')) fail("The welcome page is not the Vorteo app shell.");
  const access = JSON.parse((await httpRequest(`${origin}/api/installation/owner-access`)).body);
  if (access.passwordFile !== CONTRACT.passwordFile) {
    fail(`The welcome page names ${access.passwordFile}, not ${CONTRACT.passwordFile}.`);
  }
  step(`welcome page served at ${origin} and names the owner password file`);
}

export async function assertSignIn(origin, scenario) {
  const unlock = (token) =>
    httpRequest(`${origin}/api/installation/owner/unlock`, {
      method: "POST",
      headers: { origin, authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "{}",
    });
  const refused = await unlock("not-the-owner-password");
  if (refused.status !== 401) fail(`A wrong password answered ${refused.status}, not 401.`);
  const signedIn = await unlock(ownerPassword());
  if (signedIn.status !== 200) fail(`Owner sign-in answered ${signedIn.status}.`);
  const port = new URL(origin).port;
  const cookie = (signedIn.headers["set-cookie"] ?? [])
    .map((value) => value.split(";")[0])
    .find((value) => value.startsWith(`vorteo-owner-local-${port}=`));
  if (!cookie) fail("Owner sign-in set no local session cookie.");
  const kinds = JSON.parse(signedIn.body)
    .connections.map((connection) => connection.kind)
    .sort();
  if (JSON.stringify(kinds) !== JSON.stringify(EXPECTED_KINDS[scenario])) {
    fail(`Sign-in returned connections for ${kinds}, expected ${EXPECTED_KINDS[scenario]}.`);
  }
  const session = await httpRequest(`${origin}/api/installation/owner/session`, {
    method: "POST",
    headers: { origin, cookie },
  });
  if (JSON.parse(session.body).authenticated !== true) fail("The session cookie is not accepted.");
  step(`owner sign-in succeeded with the generated password (${kinds.join(", ")})`);
}

async function assertAccess(scenario) {
  const status = readStatus();
  const origin = CONTRACT.localUrl(status)?.replace(/\/$/, "");
  if (!origin) fail("status --json reports no local interface address.");
  const { hostname } = new URL(origin);
  if (!["localhost", "127.0.0.1"].includes(hostname)) fail(`${origin} is not a loopback address.`);
  await assertWelcome(origin);
  await assertSignIn(origin, scenario);
}

// Gate ----------------------------------------------------------------------

function docker(args, options) {
  return run("docker", args, options);
}

function devContainer(status) {
  const named = CONTRACT.environments(status).find((item) => item.kind === "container")?.container;
  if (named) return named;
  // Only the Dev image carries this label; the gate image carries sh.paseo.gate-contract.
  const names = docker([
    "ps",
    "--filter",
    "label=sh.paseo.container-contract",
    "--format",
    "{{.Names}}",
  ])
    .stdout.trim()
    .split("\n")
    .filter(Boolean);
  if (names.length !== 1) fail(`Expected one running Dev container, found: ${names.join(", ")}`);
  return names[0];
}

function gateways(container) {
  const bridge = docker([
    "network",
    "inspect",
    "bridge",
    "--format",
    "{{(index .IPAM.Config 0).Gateway}}",
  ]).stdout.trim();
  const networks = Object.keys(
    JSON.parse(
      docker(["inspect", container, "--format", "{{json .NetworkSettings.Networks}}"]).stdout,
    ),
  );
  const own = networks.flatMap((network) =>
    JSON.parse(
      docker(["network", "inspect", network, "--format", "{{json .IPAM.Config}}"]).stdout,
    ).map((config) => config.Gateway),
  );
  return { bridge, all: [...new Set([bridge, ...own].filter(Boolean))] };
}

// Runs inside Dev as the agent user. Prints the outcome of each direct TCP attempt.
export const PROBE = `
const net = require("node:net");
const targets = JSON.parse(process.argv[1]);
Promise.all(targets.map(([host, port]) => new Promise((done) => {
  const socket = net.connect({ host, port, timeout: 5000 });
  socket.on("connect", () => { socket.destroy(); done([host, "connected"]); });
  socket.on("timeout", () => { socket.destroy(); done([host, "timeout"]); });
  socket.on("error", (error) => done([host, error.code || error.message]));
}))).then((results) => console.log(JSON.stringify(results)));
`;

function inDev(container, script, check = false) {
  return docker(["exec", "--user", "paseo", container, "sh", "-c", script], { check });
}

function listenOnHost() {
  return new Promise((resolve) => {
    const server = http.createServer((_request, response) => response.end("host"));
    server.listen(0, "0.0.0.0", () => resolve(server));
  });
}

function assertControl(image, gateway, port) {
  // Proves the gateway listener is reachable from an ordinary container, so a
  // failure from Dev means isolation rather than a dead listener.
  const control = docker(
    [
      "run",
      "--rm",
      "--network",
      "bridge",
      "--entrypoint",
      "curl",
      image,
      "-fsS",
      "-m",
      "10",
      `http://${gateway}:${port}/`,
    ],
    { check: false },
  );
  if (control.stdout.trim() !== "host") {
    fail(
      `Control container could not reach ${gateway}:${port}; the isolation probe is inconclusive.`,
    );
  }
}

function assertDirectRefused(container, targets) {
  const probe = docker(
    ["exec", "--user", "paseo", container, "node", "-e", PROBE, JSON.stringify(targets)],
    { check: true },
  );
  const results = JSON.parse(probe.stdout);
  const reached = results.filter(([, outcome]) => outcome === "connected");
  if (reached.length) fail(`Dev reached ${reached.map(([host]) => host).join(", ")} directly.`);
  step(`direct connections refused: ${results.map((result) => result.join(" ")).join(", ")}`);
}

function assertThroughGate(container, gateway, port) {
  const proxy = inDev(container, 'printf %s "${HTTPS_PROXY:-$https_proxy}"').stdout.trim();
  if (!proxy.startsWith("http://")) fail("Dev has no gate proxy in HTTPS_PROXY.");
  const direct = inDev(
    container,
    "curl --noproxy '*' -fsS -m 10 https://registry.npmjs.org/-/ping",
  );
  if (direct.status === 0) fail("Dev reached registry.npmjs.org without the gate.");
  const viaGate = inDev(
    container,
    "curl -fsS -m 60 -o /dev/null -w '%{http_code}' https://registry.npmjs.org/-/ping",
  );
  if (viaGate.status !== 0)
    fail(`Dev could not fetch the npm registry through the gate: ${viaGate.stderr}`);
  const refused = inDev(
    container,
    `curl -s -m 10 -o /dev/null -w '%{http_code}' -x "\${HTTP_PROXY:-$http_proxy}" http://${gateway}:${port}/`,
  );
  if (refused.stdout.trim() !== "403") {
    fail(`The gate answered ${refused.stdout.trim()} for the Docker host gateway, not 403.`);
  }
  step("npm registry reachable through the gate; the gate refuses the Docker host gateway");
}

// The gate writes its log as an unprivileged container user with mode 600.
function privileged(command, args) {
  return isLinux ? run("sudo", [command, ...args]) : run(command, args);
}

function gateLogEntries(status) {
  const listed = CONTRACT.gateLog(status);
  const files = listed
    ? [listed]
    : privileged("find", [
        CONTRACT.home,
        "-type",
        "f",
        "-path",
        "*gate*",
        "(",
        "-name",
        "*.log",
        "-o",
        "-name",
        "*.jsonl",
        ")",
      ])
        .stdout.trim()
        .split("\n")
        .filter(Boolean);
  if (!files.length) fail(`No gate log found under ${CONTRACT.home}.`);
  return files.flatMap((file) =>
    privileged("cat", [file])
      .stdout.split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line)),
  );
}

async function assertGateLog(status, gateway) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const entries = gateLogEntries(status);
    const allowed = entries.some(
      (entry) => entry.host === "registry.npmjs.org" && entry.decision === "allow",
    );
    const denied = entries.some((entry) => entry.host === gateway && entry.decision === "deny");
    if (allowed && denied) {
      step("gate log records the npm fetch (allow) and the gateway attempt (deny)");
      return;
    }
    await sleep(2000);
  }
  fail("The gate log does not record the npm fetch and the refused gateway request.");
}

async function assertGate() {
  if (!isLinux) fail("assert-gate runs on Linux runners only.");
  const status = readStatus();
  const container = devContainer(status);
  const image = docker(["inspect", container, "--format", "{{.Config.Image}}"]).stdout.trim();
  const server = await listenOnHost();
  try {
    const { port } = server.address();
    const { bridge, all } = gateways(container);
    assertControl(image, bridge, port);
    assertDirectRefused(container, [
      ...all.map((gateway) => [gateway, port]),
      ["10.0.0.1", 443],
      ["10.255.255.254", 80],
    ]);
    assertThroughGate(container, bridge, port);
    await assertGateLog(status, bridge);
  } finally {
    server.close();
  }
}

// Legacy identity -----------------------------------------------------------

function assertIdentity() {
  const expected = readFileSync(path.join(stateDir, "legacy-server-id"), "utf8").trim();
  const status = readStatus();
  const dev = CONTRACT.environments(status).find((environment) => environment.kind === "container");
  if (!dev) fail("The installation has no Dev environment after wrapping.");
  if (dev.serverId !== expected) fail(`Dev is ${dev.serverId}, not the legacy ${expected}.`);
  const container = devContainer(status);
  const home = JSON.parse(
    docker(["inspect", container, "--format", "{{json .Mounts}}"]).stdout,
  ).find((mount) => mount.Destination === "/home/paseo");
  const legacy = process.env.VORTEO_E2E_LEGACY_DEPLOYMENT;
  const kept =
    home && (home.Source.startsWith(`${legacy}/`) || home.Source.startsWith(CONTRACT.home));
  if (!kept) fail(`Dev's home is ${home?.Source}, not the legacy deployment's.`);
  step(`Dev kept server-id ${expected} and the legacy home (${home.Source})`);
}

function assertNoDocker() {
  const log = process.env.VORTEO_E2E_DOCKER_LOG ?? fail("VORTEO_E2E_DOCKER_LOG is not set.");
  const calls = existsSync(log) ? readFileSync(log, "utf8").trim() : "";
  if (calls) fail(`The Host-only install ran Docker:\n${calls}`);
  step("no Docker command ran during the Host-only install");
}

// Uninstall -----------------------------------------------------------------

async function uninstall() {
  const added = loadState("services.json");
  const origin = CONTRACT.localUrl(loadState("status.json"))?.replace(/\/$/, "");
  run(CONTRACT.vorteoCommand, CONTRACT.uninstallArgs, { stdio: ["ignore", "inherit", "inherit"] });
  const remaining = serviceNames().filter((name) => added.includes(name));
  if (remaining.length) fail(`Services still registered after uninstall: ${remaining.join(", ")}`);
  if (origin) {
    const answered = await httpRequest(`${origin}/`).then(
      () => true,
      () => false,
    );
    if (answered) fail(`${origin} still answers after uninstall.`);
  }
  step(`uninstall removed ${added.length} service(s) and stopped the interface`);
}

function diagnose() {
  const status = existsSync(CONTRACT.installedCli) ? readStatus() : { error: "not installed" };
  console.log(JSON.stringify(status, null, 2));
  if (process.platform === "darwin") {
    run("launchctl", ["list"], { check: false, stdio: "inherit" });
    return;
  }
  run("systemctl", ["--user", "--no-pager", "--all", "list-units"], {
    check: false,
    stdio: "inherit",
  });
  run("journalctl", ["--user", "--no-pager", "-n", "200"], { check: false, stdio: "inherit" });
  run("docker", ["ps", "-a"], { check: false, stdio: "inherit" });
}

const COMMANDS = {
  install,
  "wait-ready": waitReady,
  "assert-access": assertAccess,
  "assert-gate": assertGate,
  "assert-identity": assertIdentity,
  "assert-no-docker": assertNoDocker,
  uninstall,
  diagnose,
};

if (isMainModule(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  try {
    await (
      COMMANDS[command] ?? fail(`Usage: install-e2e.mjs <${Object.keys(COMMANDS).join("|")}>`)
    )(...args);
  } catch (error) {
    console.error(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
