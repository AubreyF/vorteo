#!/usr/bin/env node
import { brokerClient } from "./preview-broker-client.mjs";
if (await brokerClient(process.argv.slice(2))) process.exit(process.exitCode ?? 0);
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import net from "node:net";
import { join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout } from "node:timers/promises";

const directory = join(homedir(), ".local/share/paseo-preview");
const stateFile = join(directory, "services.json");
const lockFile = join(directory, "services.lock");
const [action, ...args] = process.argv.slice(2);
const globalAction = ["recover", "status"].includes(action);
const name = globalAction || action === "list" ? null : args.shift();
if (
  !["start", "stop", "restart", "list", "recover", "status"].includes(action) ||
  (!globalAction && action !== "list" && !name)
) {
  throw new Error(
    "Usage: paseo-preview start|stop|restart SCRIPT --workspace ID; list [selector]; status; recover",
  );
}
if (
  args.length &&
  (globalAction || args.length !== 2 || !["--workspace", "--cwd"].includes(args[0]))
) {
  throw new Error("Select one workspace using --workspace ID or --cwd PATH");
}
function cli(cliArgs) {
  const result = JSON.parse(
    execFileSync("paseo", [...cliArgs, "--json"], {
      encoding: "utf8",
      timeout: 20000,
      maxBuffer: 4 * 1024 * 1024,
    }),
  );
  if (result.error) throw new Error(JSON.stringify(result.error));
  return result;
}
function scripts(workspaceId) {
  return cli(["script", "ls", "--workspace", workspaceId]);
}
function service(workspaceId, scriptName) {
  const script = scripts(workspaceId).find((item) => item.scriptName === scriptName);
  if (!script || script.type !== "service") throw new Error("Select a configured service script");
  return script;
}
function run(verb, entry) {
  return cli(["script", verb, entry.scriptName, "--workspace", entry.workspaceId]);
}
function atomic(file, value, mode = 0o600) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, value, { mode });
    renameSync(temp, file);
  } finally {
    rmSync(temp, { force: true });
  }
}
function save(state) {
  atomic(stateFile, JSON.stringify(state, null, 2) + "\n");
}
function daemonIdentity() {
  // Use the broker's pinned worker contract, including supervisor and PID reuse checks.
  return execFileSync(
    process.execPath,
    [
      "-e",
      "\nconst fs=require('node:fs');const path=require('node:path');const found=[];\nconst crypto=require('node:crypto');const replaced=new Map();\n// A program whose file was replaced keeps running the old inode, shown as \"(deleted)\". Accept it\n// only when the file now at that path is byte-identical; anything else fails closed.\nconst exe=pid=>{const link=fs.readlinkSync(`/proc/${pid}/exe`);if(!link.endsWith(' (deleted)'))return fs.realpathSync(`/proc/${pid}/exe`);\n  const current=fs.realpathSync(link.slice(0,-' (deleted)'.length));const key=`${link}:${fs.statSync(`/proc/${pid}/exe`).ino}`;\n  const digest=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');\n  if(!replaced.has(key))replaced.set(key,digest(`/proc/${pid}/exe`)===digest(current));\n  if(!replaced.get(key))process.exit(1);\n  return current;};\nconst home=process.env.PASEO_HOME||path.join(require('node:os').homedir(),'.paseo');\nconst ownerFile=path.join(home,'paseo.pid');\nconst ownerText=fs.readFileSync(ownerFile,'utf8');\nconst owner=JSON.parse(ownerText).pid;\nif(!Number.isSafeInteger(owner)||owner<=0)process.exit(1);\nconst boot=fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim();\nconst start=pid=>{const stat=fs.readFileSync(`/proc/${pid}/stat`,'utf8');return stat.slice(stat.lastIndexOf(')')+2).split(' ')[19];};\nconst owned=status=>{const ids=status.match(/^Uid:\\s+(\\d+)\\s+(\\d+)\\s+(\\d+)\\s+(\\d+)$/m);return ids&&ids.slice(1).every(id=>Number(id)===process.getuid());};\nconst ownerStart=start(owner);\nif(!owned(fs.readFileSync(`/proc/${owner}/status`,'utf8')))process.exit(1);\nconst markerFile=path.join(home,'managed-supervisor.json');\nlet markerText,selected,entry,node,marker;\nif(fs.existsSync(markerFile)){\n  markerText=fs.readFileSync(markerFile,'utf8');marker=JSON.parse(markerText);\n  if(marker.version!==1||marker.pid!==owner||!path.isAbsolute(marker.root)||!path.isAbsolute(marker.link)||path.dirname(marker.link)!==marker.root||fs.realpathSync(marker.root)!==marker.root)process.exit(1);\n  const env=fs.readFileSync(`/proc/${owner}/environ`,'utf8').split('\\0');\n  if(!env.includes(`PASEO_MANAGED_RELEASE_LINK=${marker.link}`)||!env.includes(`PASEO_MANAGED_RELEASE_ROOT=${marker.root}`))process.exit(1);\n  selected=fs.realpathSync(marker.link);\n  if(!selected.startsWith(marker.root+path.sep))process.exit(1);\n  entry=path.join(selected,'packages/server/dist/server/server/daemon-worker.js');\n  if(fs.realpathSync(entry)!==entry)process.exit(1);\n  node=exe(owner);\n}\nfor(const pid of fs.readdirSync('/proc').filter(p=>/^\\d+$/.test(p))){\n  try{\n    const ticks=start(pid);\n    if(!/^\\d+$/.test(ticks))process.exit(1);\n    const status=fs.readFileSync(`/proc/${pid}/status`,'utf8');\n    if(!owned(status))continue;\n    const parent=Number(status.match(/^PPid:\\s+(\\d+)$/m)?.[1]);\n    if(marker){\n      if(parent!==owner)continue;\n      const argv=fs.readFileSync(`/proc/${pid}/cmdline`,'utf8').split('\\0');\n      if(argv.pop()!==''||argv.length!==2||argv[1]!==entry||fs.realpathSync(argv[0])!==node||exe(pid)!==node)continue;\n    }else if(!/^Name:\\s+Paseo Daemon$/m.test(status)||(Number(pid)!==owner&&parent!==owner))continue;\n    found.push({pid,ticks,value:`${boot}:${pid}:${ticks}`});\n  }catch(e){if(!['ENOENT','EACCES','ESRCH'].includes(e.code))throw e;}\n}\nif(found.length!==1)process.exit(1);\nif(fs.readFileSync(ownerFile,'utf8')!==ownerText||start(owner)!==ownerStart||start(found[0].pid)!==found[0].ticks||fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim()!==boot)process.exit(1);\nif(marker&&(fs.readFileSync(markerFile,'utf8')!==markerText||fs.realpathSync(marker.link)!==selected))process.exit(1);\nprocess.stdout.write(found[0].value);\n",
    ],
    {
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: 4096,
    },
  ).trim();
}
function config(entry) {
  const file = join(entry.cwd, "paseo.json");
  const text = readFileSync(file, "utf8");
  const value = JSON.parse(text);
  const script = value.scripts?.[entry.scriptName];
  if (script?.type !== "service" || typeof script.command !== "string")
    throw new Error("Preview service configuration is missing");
  return { file, text, value, script };
}
function fingerprint(script) {
  return createHash("sha256").update(JSON.stringify(script)).digest("hex");
}
function pin(entry, port) {
  if (!Number.isInteger(port) || port < 32768 || port > 60999)
    throw new Error("Preview port must be in the approved range 32768 through 60999");
  const current = config(entry);
  if (current.script.port !== undefined && current.script.port !== port)
    throw new Error("Configured port differs from running preview; restart explicitly to apply it");
  if (current.script.port === undefined) {
    current.script.port = port;
    if (readFileSync(current.file, "utf8") !== current.text)
      throw new Error("Project config changed concurrently; retry");
    atomic(
      current.file,
      JSON.stringify(current.value, null, 2) + "\n",
      statSync(current.file).mode & 0o777,
    );
  }
  entry.port = port;
  entry.fingerprint = fingerprint(current.script);
}
async function start(entry) {
  const port = config(entry).script.port;
  if (port !== undefined) {
    const available = await new Promise((done) => {
      const listener = net.createServer();
      listener.once("error", () => done(false));
      listener.listen(port, "0.0.0.0", () => listener.close((error) => done(!error)));
    });
    if (!available)
      throw new Error(
        `Configured preview port ${port} is occupied; leave its owner running and choose a different project port`,
      );
  }
  return run("start", entry);
}
function hostname() {
  const value = readFileSync("/etc/personal-tailscale/hostname", "utf8").trim();
  if (!/^[a-z0-9][a-z0-9-]*\.[a-z0-9-]+\.ts\.net$/.test(value))
    throw new Error("Administrator must record the verified Tailscale hostname");
  return value;
}
async function probe(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3000), redirect: "manual" });
    await response.body?.cancel();
    return response.status;
  } catch (error) {
    if (error instanceof TypeError || error.name === "TimeoutError") return null;
    throw error;
  }
}
async function ready(entry) {
  const host = hostname();
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    const script = service(entry.workspaceId, entry.scriptName);
    if (script.lifecycle === "running" && script.port) {
      const url = `http://${host}:${script.port}/`;
      const status = await probe(url);
      if (status >= 200 && status < 400) return { url, status, script };
    }
    await setTimeout(1000);
  }
  throw new Error("Managed preview did not respond within 45 seconds");
}
async function locked(callback) {
  const state = existsSync(stateFile)
    ? JSON.parse(readFileSync(stateFile, "utf8"))
    : { version: 1, services: [] };
  if (state.version !== 1 || !Array.isArray(state.services))
    throw new Error("Unsupported preview state; preserve it for recovery");
  return await callback(state);
}

async function recover(state) {
  const daemon = daemonIdentity();
  const workspaces = cli(["workspace", "ls"]);
  const results = [];
  const deadline = Date.now() + 90000;
  for (const entry of state.services.filter((item) => item.enabled)) {
    if (Date.now() >= deadline) break;
    try {
      if (
        !workspaces.some((item) => item.workspaceId === entry.workspaceId && item.cwd === entry.cwd)
      )
        throw new Error("Workspace is missing or moved; restart explicitly after review");
      const script = service(entry.workspaceId, entry.scriptName);
      if (entry.daemon === daemon) {
        // Observe explicit UI/CLI stops without continuously restarting crashed scripts.
        if (script.lifecycle !== "running") {
          entry.enabled = false;
          entry.note = "Stopped or exited during current daemon session";
          save(state);
        }
        continue;
      }
      if (entry.retryDaemon !== daemon) {
        entry.retryDaemon = daemon;
        entry.attempts = 0;
      }
      if (entry.attempts >= 3) continue;
      if (fingerprint(config(entry).script) !== entry.fingerprint)
        throw new Error("Preview config changed; restart explicitly to approve restoration");
      entry.attempts += 1;
      save(state);
      if (script.lifecycle !== "running") await start(entry);
      const result = await ready(entry);
      if (result.script.port !== entry.port)
        throw new Error("Stable port changed; restoration stopped");
      entry.daemon = daemon;
      delete entry.error;
      results.push({ workspaceId: entry.workspaceId, restored: result.url });
    } catch (error) {
      entry.error = error.message;
      results.push({ workspaceId: entry.workspaceId, error: error.message });
    }
    save(state);
  }
  return results;
}
async function main() {
  if (action === "status") return locked((state) => state);
  if (action === "recover") return locked(recover);
  const workspaces = cli(["workspace", "ls"]);
  const matches = workspaces.filter((entry) =>
    args[0] === "--workspace"
      ? entry.workspaceId === args[1]
      : entry.cwd === resolvePath(args[1] || process.cwd()),
  );
  if (matches.length !== 1) throw new Error("Select exactly one workspace by ID");
  const workspace = matches[0];
  if (action === "list") return scripts(workspace.workspaceId);
  return locked(async (state) => {
    let entry = state.services.find(
      (item) => item.workspaceId === workspace.workspaceId && item.scriptName === name,
    );
    const current = service(workspace.workspaceId, name);
    if (!entry) {
      entry = {
        workspaceId: workspace.workspaceId,
        cwd: workspace.cwd,
        scriptName: name,
        enabled: false,
      };
      state.services.push(entry);
    }
    if (action === "stop") {
      entry.enabled = false;
      save(state);
      return current.lifecycle === "running" ? run("stop", entry) : current;
    }
    // A failed restart must not silently retain an old auto-restore request.
    entry.enabled = false;
    save(state);
    if (action === "restart" && current.lifecycle === "running") run("stop", entry);
    if (action === "restart" || current.lifecycle !== "running") await start(entry);
    const result = await ready(entry);
    pin(entry, result.script.port);
    entry.daemon = daemonIdentity();
    entry.enabled = true;
    entry.attempts = 0;
    delete entry.error;
    delete entry.note;
    save(state);
    return { ...result, stablePort: true, restoreAfterRestart: true };
  });
}
// Kernel locks release on crash and reboot, including when a PID is reused.
if (process.env.PASEO_PREVIEW_LOCK_HELD !== "1") {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const output = execFileSync(
    "/usr/bin/flock",
    [
      "--timeout",
      "60",
      lockFile,
      process.execPath,
      fileURLToPath(import.meta.url),
      ...process.argv.slice(2),
    ],
    {
      encoding: "utf8",
      timeout: 175000,
      env: { ...process.env, PASEO_PREVIEW_LOCK_HELD: "1" },
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  process.stdout.write(output);
} else {
  console.log(JSON.stringify(await main(), null, 2));
}
