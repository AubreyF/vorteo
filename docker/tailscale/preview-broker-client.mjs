import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
const channel = join(homedir(), ".local/share/paseo-preview/https");
function installation() {
  return JSON.parse(readFileSync(join(channel, "installed.json"), "utf8"));
}
function cli(args) {
  const config = installation();
  const [executable, ...prefix] = config.cliCommand ?? ["/usr/local/bin/paseo"];
  const home = config.daemonHome ? ["--home", config.daemonHome] : [];
  const result = JSON.parse(
    execFileSync(executable, [...prefix, ...home, ...args, "--json"], {
      encoding: "utf8",
      timeout: 20000,
    }),
  );
  if (result.error) throw Error("Daemon CLI refused the preview operation");
  return result;
}
const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
export async function brokerClient(argv) {
  const [operation, ...args] = argv;
  if (!existsSync(join(channel, "installed.json")) && operation !== "env") return false;
  if (operation === "recover") {
    // Legacy recovery is retained for services not taken over by this broker.
    return false;
  }
  if (operation === "env") runWithOrigin(args);
  if (existsSync(join(channel, "disabled.json")))
    throw Error("HTTPS broker is disabled by the administrator");
  if (!["start", "restart", "stop", "status", "list"].includes(operation))
    throw Error("Use start, restart, stop, status or list");
  const { name, workspace, preferredPort, workspaces } = select(operation, args);
  if (operation === "list") {
    console.log(JSON.stringify(cli(["script", "ls", "--workspace", workspace]), null, 2));
    return true;
  }
  if (operation === "status" && !name) {
    const { readdirSync } = await import("node:fs");
    const reservations = readdirSync(join(channel, "origins"))
      .filter((n) => n.endsWith(".json"))
      .map((n) => JSON.parse(readFileSync(join(channel, "origins", n), "utf8")));
    const results = [];
    for (const r of reservations.filter((item) => !workspace || item.workspaceId === workspace))
      results.push({
        workspaceId: r.workspaceId,
        service: r.service,
        ...(await request("status", r.workspaceId, r.service)),
      });
    console.log(JSON.stringify({ services: results }, null, 2));
    return true;
  }
  if (
    !/^wks_[a-zA-Z0-9_-]{1,80}$/.test(workspace ?? "") ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name ?? "")
  )
    throw Error("Select a workspace and service");
  const w = workspaces.find((item) => item.workspaceId === workspace);
  if (!w) throw Error("Unknown workspace");
  prepare(operation, workspace, name, w);
  let result = await request(operation, workspace, name, preferredPort);
  const deadline = Date.now() + 60000;
  while (result.status === "pending" && Date.now() < deadline) {
    await setTimeout(2000);
    result = await request("status", workspace, name);
  }
  console.log(JSON.stringify(result, null, 2));
  if (result.status === "failed") process.exitCode = 1;
  return true;
}
function replace(path, text) {
  const temp = path + "." + randomUUID() + ".tmp";
  writeFileSync(temp, text, { mode: statSync(path).mode & 0o777, flag: "wx" });
  renameSync(temp, path);
}
async function request(operation, workspaceId, service, preferredPort) {
  const id = randomUUID();
  const r = { id, operation, workspaceId, service, createdAt: Date.now() / 1000 };
  if (preferredPort !== undefined) r.preferredPort = preferredPort;
  const temp = join(channel, "inbox", "." + id);
  const target = join(channel, "inbox", id + ".json");
  writeFileSync(temp, JSON.stringify(r), { mode: 0o600, flag: "wx" });
  renameSync(temp, target);
  const receipt = join(channel, "receipts", id + ".json");
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    if (existsSync(receipt)) return JSON.parse(readFileSync(receipt, "utf8"));
    await setTimeout(500);
  }
  return {
    status: "pending",
    requestId: id,
    message:
      "Host broker has not returned a receipt. Inspect status; do not replay this request ID.",
  };
}

function runWithOrigin(args) {
  const [name, flag, workspace, separator, ...command] = args;
  if (flag !== "--workspace" || separator !== "--" || !command.length)
    throw Error("env SERVICE --workspace ID -- COMMAND [ARGS]");
  if (
    !/^wks_[a-zA-Z0-9_-]{1,80}$/.test(workspace) ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name)
  )
    throw Error("Invalid preview identity");
  const data = JSON.parse(
    readFileSync(join(channel, "origins", `${workspace}.${name}.json`), "utf8"),
  );
  if (!/^https:\/\/[a-z0-9.-]+\.ts\.net:[0-9]+$/.test(data.origin))
    throw Error("Invalid reserved origin");
  const result = spawnSync(command[0], command.slice(1), {
    stdio: "inherit",
    env: { ...process.env, PASEO_PREVIEW_ORIGIN: data.origin },
  });
  process.exit(result.status ?? 1);
}

function select(operation, args) {
  let name =
    ["list", "status"].includes(operation) && (!args.length || args[0].startsWith("--"))
      ? null
      : args.shift();
  let workspace;
  let preferredPort;
  while (args.length) {
    const flag = args.shift();
    const value = args.shift();
    if (flag === "--workspace") workspace = value;
    else if (flag === "--cwd") {
      const found = cli(["workspace", "ls"]).filter((w) => w.cwd === resolve(value));
      if (found.length !== 1) throw Error("Select one workspace by ID");
      workspace = found[0].workspaceId;
    } else if (flag === "--https-port") preferredPort = Number(value);
    else throw Error("Supported options: --workspace ID, --cwd PATH, --https-port PORT");
  }
  const workspaces = cli(["workspace", "ls"]);
  if (!workspace && operation !== "status") {
    const found = workspaces.filter((w) => w.cwd === process.cwd());
    if (found.length !== 1) throw Error("Select one workspace by ID");
    workspace = found[0].workspaceId;
  }
  return { name, workspace, preferredPort, workspaces };
}

function prepare(operation, workspace, name, w) {
  if (operation === "status") return;
  // Disable legacy restoration before the broker takes ownership, including stop.
  const old = join(homedir(), ".local/share/paseo-preview/services.json");
  if (existsSync(old)) {
    const state = JSON.parse(readFileSync(old, "utf8"));
    for (const e of state.services)
      if (e.workspaceId === workspace && e.scriptName === name) {
        e.enabled = false;
        e.note = "HTTPS broker lifecycle";
      }
    replace(old, JSON.stringify(state, null, 2) + "\n");
  }
  if (["start", "restart"].includes(operation)) {
    const services = cli(["script", "ls", "--workspace", workspace]);
    const service = services.find((s) => s.scriptName === name && s.type === "service");
    if (!service) throw Error("Unknown managed service");
    // The daemon does not inherit caller environment. Wrap the registered command
    // before its first stopped launch. An already-running application is adopted.
    if (service.lifecycle !== "running" || operation === "restart") {
      const helper = installation().helperCommand;
      const executable = helper
        ? helper.map(quote).join(" ")
        : "/home/paseo/.local/bin/paseo-preview";
      const prefix = `${executable} env ${quote(name)} --workspace ${quote(workspace)} -- `;
      wrapPreviewCommand(w.cwd, name, prefix, localProjectConfigSupported());
    }
  }
}

function localProjectConfigSupported() {
  try {
    return cli(["daemon", "status"]).localProjectConfig === true;
  } catch {
    return false;
  }
}

// Daemons that merge paseo.local.json get the wrapper there, so a preview never dirties the
// committed paseo.json of a shared checkout. Older daemons only read paseo.json.
export function wrapPreviewCommand(cwd, name, prefix, useLocalConfig) {
  const projectPath = join(cwd, "paseo.json");
  const projectText = readFileSync(projectPath, "utf8");
  const project = JSON.parse(projectText);
  const committed = project.scripts?.[name]?.command;
  if (typeof committed !== "string") throw Error("Preview service configuration is missing");
  if (!useLocalConfig) {
    if (committed.startsWith(prefix)) return;
    project.scripts[name].command = prefix + "/bin/sh -lc " + quote(committed);
    if (readFileSync(projectPath, "utf8") !== projectText)
      throw Error("Configuration changed concurrently");
    replace(projectPath, JSON.stringify(project, null, 2) + "\n");
    return;
  }
  const localPath = join(cwd, "paseo.local.json");
  const localText = existsSync(localPath) ? readFileSync(localPath, "utf8") : null;
  const local = localText === null ? {} : JSON.parse(localText);
  const current = local.scripts?.[name]?.command ?? committed;
  if (current.startsWith(prefix)) return;
  local.scripts = {
    ...local.scripts,
    [name]: { ...local.scripts?.[name], command: prefix + "/bin/sh -lc " + quote(current) },
  };
  const now = existsSync(localPath) ? readFileSync(localPath, "utf8") : null;
  if (now !== localText) throw Error("Configuration changed concurrently");
  const text = JSON.stringify(local, null, 2) + "\n";
  if (localText === null) {
    const temp = localPath + "." + randomUUID() + ".tmp";
    writeFileSync(temp, text, { mode: 0o644, flag: "wx" });
    renameSync(temp, localPath);
  } else replace(localPath, text);
}
