import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { connectSessionHost } from "./client.js";
import { readSessionHostToken, sessionHostPaths } from "./host-files.js";
import { bootoutJob, bootstrapJob, printJob, renderSessionHostPlist } from "./launchd.js";
import { SESSION_HOST_TEST_CLIENT_MODULE_ENV } from "./service.js";
import { durableSessionsSettingsPath } from "./settings.js";

/**
 * An isolated test installation for the durable sessions end-to-end tests: its own PASEO_HOME
 * under /tmp, a session host run by launchd under a test.durable-sessions.* label, and real
 * supervisor and worker processes on a free loopback port. Nothing here reads or writes the live
 * installation: every child gets an explicit environment instead of this process's, which in a
 * Vorteo agent carries the live PASEO_HOME, installation client config and credentials.
 */

export const thisRepoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../..",
);

/** Ports of the live installation; a test must never use or connect to them. */
const LIVE_PORTS = new Set([6767, 6771]);

/** The text the daemon queues when a hosted session is lost (message-queue/service.ts). */
export const HOST_LOSS_CONTINUATION =
  "The session host stopped and interrupted this turn. Continue the work in progress";
/** The text of an installation restart continuation, which hosted turns must never get. */
export const RESTART_CONTINUATION = "The installation restart hold has ended.";

/** A source tree the host or daemon runs from. Release labels come from its server package. */
export interface ReleaseTree {
  repoRoot: string;
}

function serverRoot(tree: ReleaseTree): string {
  return path.join(tree.repoRoot, "packages/server");
}

/** The tsx loader by absolute URL, so a launchd job resolves it without a working directory. */
function tsxLoader(tree: ReleaseTree): string {
  return pathToFileURL(path.join(tree.repoRoot, "node_modules/tsx/dist/loader.mjs")).href;
}

export function releaseOf(tree: ReleaseTree): string {
  return (
    JSON.parse(readFileSync(path.join(serverRoot(tree), "package.json"), "utf8")) as {
      version: string;
    }
  ).version;
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function waitUntil<T>(
  what: string,
  probe: () => Promise<T | null | undefined | false> | T | null | undefined | false,
  timeoutMs: number,
  intervalMs = 250,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  for (;;) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() > deadline)
      throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}`, {
        cause: lastError ?? undefined,
      });
    await delay(intervalMs);
  }
}

async function availablePort(): Promise<number> {
  for (;;) {
    const port = await new Promise<number>((resolve, reject) => {
      const server = net.createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const { port: bound } = server.address() as net.AddressInfo;
        server.close(() => resolve(bound));
      });
    });
    if (!LIVE_PORTS.has(port)) return port;
  }
}

export interface Supervisor {
  process: ChildProcess;
  tree: ReleaseTree;
  /** Every worker pid this supervisor reported listening, oldest first. */
  workers: number[];
  /** Resolves with the next listening worker other than the given pids. */
  waitForWorker(exclude?: readonly number[], timeoutMs?: number): Promise<number>;
  /** SIGTERM, as launchd stops the job, then waits for the supervisor and its worker to exit. */
  stop(timeoutMs?: number): Promise<void>;
}

export interface FakeCliProcess {
  pid: number;
  ppid: number;
}

export interface Installation {
  runId: string;
  root: string;
  home: string;
  port: number;
  label: string;
  /** A marker in each stand-in provider CLI command line, unique to this run. */
  cliMarker: string;
  /** The provider scripted agents use; the fake host runs sessions of this shape. */
  agentProvider: ScriptedProvider;
  /** Loads the launchd job running the host from tree, and waits until it answers. */
  startHost(tree: ReleaseTree): Promise<HostIdentity>;
  /** The host answering now; waits for one other than notPid when given. */
  host(options?: { notPid?: number; timeoutMs?: number }): Promise<HostIdentity>;
  startSupervisor(tree: ReleaseTree): Promise<Supervisor>;
  client(): Promise<DaemonClient>;
  fakeCliProcesses(): FakeCliProcess[];
  /** The tool endpoint token the running host hands its workers at hello. */
  hostMcpToken(): Promise<string>;
  /** Status of an MCP initialize request to the daemon's agent tool endpoint with this bearer. */
  postAgentEndpoint(agentId: string, bearer: string): Promise<number>;
  auditRecords(): Record<string, unknown>[];
  /** Tails of the daemon, host and launchd logs, for failure messages. */
  logs(): string;
  cleanup(): Promise<void>;
}

export interface HostIdentity {
  pid: number;
  release?: string;
}

export interface InstallationOptions {
  /**
   * fake runs the scripted provider in the host and a stub claude in the worker. The worker finds
   * the stub only through the provider command setting written below: if that setting stopped
   * applying, the worker would run the real claude on PATH, with the isolated config directory and
   * so without a login.
   */
  provider: "fake" | "real";
  /**
   * The provider shape the fake host runs and scripted agents are created with. Codex sessions
   * carry goal state and run /goal and /compact out of band, as the real adapter does.
   */
  agentProvider?: ScriptedProvider;
  /** Milliseconds between scripted chunks. */
  chunkMs?: number;
  /**
   * Protects the daemon with a password. Without one the agent tool endpoint accepts any request,
   * so a check of which tokens it accepts needs this.
   */
  password?: boolean;
}

/** Answers what the daemon asks a claude binary before it hosts a session (see authentication.ts). */
const FAKE_CLAUDE = `#!/bin/sh
case "$*" in
  *"auth status"*) echo '{"loggedIn":true,"authMethod":"oauth_token","apiProvider":"firstParty"}' ;;
  *--version*) echo "2.1.284 (Claude Code)" ;;
  *) echo "the fake claude only answers auth status and --version" >&2; exit 2 ;;
esac
`;

/**
 * Stands in for the Codex CLI in the worker. The session itself runs in the host, but the worker
 * still asks the binary for its version and, through a short-lived app-server, for the model
 * catalog before it creates an agent. The stand-in answers exactly those: one model, empty saved
 * configuration, and a JSON-RPC error for anything else, so a thread started here would fail loudly.
 */
const FAKE_CODEX_APP_SERVER = `
import readline from "node:readline";
const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("codex-cli 99.0.0");
  process.exit(0);
}
if (args[0] !== "app-server") {
  console.error("the fake codex answers only --version and app-server");
  process.exit(2);
}
const results = {
  initialize: {},
  "model/list": { data: [{ id: "gpt-5.4", displayName: "GPT-5.4", isDefault: true }] },
  getUserSavedConfig: { config: {} },
  "config/read": { config: {} },
};
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.id === undefined) return;
  const result = results[message.method];
  const reply = result
    ? { id: message.id, result }
    : { id: message.id, error: { code: -32601, message: "the fake codex runs no threads" } };
  process.stdout.write(JSON.stringify(reply) + "\\n");
});
`;

export type ScriptedProvider = "claude" | "codex";

/** The host fixture reads the provider shape from this variable. */
export const FAKE_PROVIDER_ENV = "DURABLE_SESSIONS_FAKE_PROVIDER";

const ALL_PROVIDERS = ["claude", "codex", "copilot", "cursor", "opencode", "pi", "omp"];

function tail(file: string, bytes = 6_000): string {
  try {
    const text = readFileSync(file, "utf8");
    return `--- ${file}\n${text.slice(-bytes)}`;
  } catch {
    return `--- ${file}: missing`;
  }
}

export async function createInstallation(options: InstallationOptions): Promise<Installation> {
  const runId = randomBytes(5).toString("hex");
  // Short and under /tmp so the host socket path stays far below the 103 byte limit.
  const root = mkdtempSync("/tmp/dsh-e2e-");
  const home = path.join(root, "home");
  const userHome = path.join(root, "user");
  const claudeConfig = path.join(root, "claude-config");
  const work = path.join(root, "work");
  for (const directory of [home, userHome, claudeConfig, work]) mkdirSync(directory);
  const port = await availablePort();
  const label = `test.durable-sessions.${runId}`;
  const cliMarker = `dsh-fake-cli-${runId}`;
  const launchdLog = path.join(root, "launchd.log");
  const fake = options.provider === "fake";
  const agentProvider: ScriptedProvider = options.agentProvider ?? "claude";
  const password = options.password ? randomBytes(16).toString("hex") : null;

  writeFileSync(durableSessionsSettingsPath(home), JSON.stringify({ enabled: true }));
  // Only the provider under test is enabled, so nothing else on this machine is ever consulted.
  const providers: Record<string, unknown> = Object.fromEntries(
    ALL_PROVIDERS.filter((id) => id !== agentProvider).map((id) => [id, { enabled: false }]),
  );
  if (fake && agentProvider === "claude") {
    const fakeClaude = path.join(root, "fake-claude.sh");
    writeFileSync(fakeClaude, FAKE_CLAUDE);
    chmodSync(fakeClaude, 0o755);
    providers.claude = { command: [fakeClaude], env: { CLAUDE_CONFIG_DIR: claudeConfig } };
  } else if (fake) {
    const fakeCodexModule = path.join(root, "fake-codex.mjs");
    writeFileSync(fakeCodexModule, FAKE_CODEX_APP_SERVER);
    const fakeCodex = path.join(root, "fake-codex.sh");
    writeFileSync(fakeCodex, `#!/bin/sh\nexec "${process.execPath}" "${fakeCodexModule}" "$@"\n`);
    chmodSync(fakeCodex, 0o755);
    const codexHome = path.join(root, "codex-home");
    mkdirSync(codexHome);
    providers.codex = { command: [fakeCodex], env: { CODEX_HOME: codexHome } };
  }
  writeFileSync(
    path.join(home, "config.json"),
    JSON.stringify({ version: 1, agents: { providers } }),
  );

  // The real provider needs the owner's Claude login, so it keeps HOME and CLAUDE_CONFIG_DIR.
  const providerEnv: Record<string, string> = fake
    ? { HOME: userHome, CLAUDE_CONFIG_DIR: claudeConfig }
    : {
        HOME: process.env.HOME ?? userHome,
        ...(process.env.CLAUDE_CONFIG_DIR
          ? { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR }
          : {}),
      };
  const baseEnv: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    LANG: process.env.LANG ?? "en_US.UTF-8",
    TMPDIR: path.join(root, "tmp"),
    ...providerEnv,
    PASEO_HOME: home,
  };
  mkdirSync(baseEnv.TMPDIR!);

  const supervisors: Supervisor[] = [];
  let jobLoaded = false;

  async function host(input: { notPid?: number; timeoutMs?: number } = {}): Promise<HostIdentity> {
    const paths = sessionHostPaths(home);
    return waitUntil(
      "the session host to answer",
      async () => {
        const client = await connectSessionHost({
          socketPath: paths.socketPath,
          token: await readSessionHostToken(paths),
          connectTimeoutMs: 1_000,
        });
        client.close();
        return client.host.pid === input.notPid ? null : client.host;
      },
      input.timeoutMs ?? 45_000,
      200,
    );
  }

  const installation: Installation = {
    runId,
    root,
    home,
    port,
    label,
    cliMarker,
    agentProvider,

    async startHost(tree) {
      const plistPath = path.join(root, `${label}.plist`);
      writeFileSync(
        plistPath,
        renderSessionHostPlist({
          label,
          nodePath: process.execPath,
          nodeArguments: ["--import", tsxLoader(tree)],
          entrypointPath: path.join(serverRoot(tree), "scripts/session-host-entrypoint.ts"),
          paseoHome: home,
          logPath: launchdLog,
          workingDirectory: serverRoot(tree),
          environment: {
            ...baseEnv,
            ...(fake
              ? {
                  NODE_ENV: "test",
                  [SESSION_HOST_TEST_CLIENT_MODULE_ENV]: path.join(
                    serverRoot(tree),
                    "src/server/session-host/durable-sessions.fixture.e2e.ts",
                  ),
                  DURABLE_SESSIONS_FAKE_CLI_MARKER: cliMarker,
                  [FAKE_PROVIDER_ENV]: agentProvider,
                  ...(options.chunkMs
                    ? { DURABLE_SESSIONS_FAKE_CHUNK_MS: String(options.chunkMs) }
                    : {}),
                }
              : {}),
          },
        }),
      );
      jobLoaded = true;
      await bootstrapJob(plistPath);
      return host();
    },

    host,

    async startSupervisor(tree) {
      const child = spawn(
        process.execPath,
        [
          "--import",
          tsxLoader(tree),
          path.join(serverRoot(tree), "scripts/supervisor-entrypoint.ts"),
          "--dev",
          "--no-relay",
        ],
        {
          cwd: serverRoot(tree),
          env: {
            ...baseEnv,
            PASEO_LISTEN: `127.0.0.1:${port}`,
            PASEO_DICTATION_ENABLED: "0",
            PASEO_VOICE_MODE_ENABLED: "0",
            PASEO_LOG_FORMAT: "json",
            PASEO_NODE_ENV: "development",
            PASEO_NODE_INSPECT: "0",
            PASEO_LOCAL_MODELS_DIR: path.join(root, "models"),
            OPENAI_API_KEY: "",
            ...(password ? { PASEO_PASSWORD: password } : {}),
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const workers: number[] = [];
      const waiters = new Set<() => void>();
      let buffered = "";
      child.stdout!.on("data", (chunk: Buffer) => {
        buffered += chunk.toString();
        const lines = buffered.split("\n");
        buffered = lines.pop() ?? "";
        for (const line of lines) {
          try {
            const record = JSON.parse(line) as { msg?: string; pid?: number };
            if (record.msg?.startsWith("Server listening") && record.pid) {
              workers.push(record.pid);
              for (const wake of waiters) wake();
            }
          } catch {
            // Not a log record.
          }
        }
      });
      child.stderr!.resume();
      const supervisor: Supervisor = {
        process: child,
        tree,
        workers,
        async waitForWorker(exclude = [], timeoutMs = 120_000) {
          return waitUntil(
            "a listening daemon worker",
            () => workers.find((pid) => !exclude.includes(pid) && alive(pid)),
            timeoutMs,
            100,
          );
        },
        async stop(timeoutMs = 45_000) {
          const lastWorker = workers.at(-1);
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
          await waitUntil(
            "the supervisor to exit",
            () => child.exitCode !== null || child.signalCode !== null,
            timeoutMs,
          );
          if (lastWorker !== undefined)
            await waitUntil("the worker to exit", () => !alive(lastWorker), timeoutMs);
        },
      };
      supervisors.push(supervisor);
      await supervisor.waitForWorker();
      return supervisor;
    },

    async client() {
      if (LIVE_PORTS.has(port)) throw new Error("Refusing to connect to a live installation port.");
      const client = new DaemonClient({
        url: `ws://127.0.0.1:${port}/ws`,
        appVersion: "0.7.2",
        ...(password ? { password } : {}),
      });
      await client.connect();
      return client;
    },

    async hostMcpToken() {
      const paths = sessionHostPaths(home);
      const client = await connectSessionHost({
        socketPath: paths.socketPath,
        token: await readSessionHostToken(paths),
        connectTimeoutMs: 5_000,
      });
      client.close();
      return client.mcpToken;
    },

    async postAgentEndpoint(agentId, bearer) {
      if (LIVE_PORTS.has(port)) throw new Error("Refusing to connect to a live installation port.");
      const response = await fetch(
        `http://127.0.0.1:${port}/mcp/agents?callerAgentId=${encodeURIComponent(agentId)}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${bearer}`,
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2025-03-26",
              capabilities: {},
              clientInfo: { name: "durable-sessions-e2e", version: "1" },
            },
          }),
        },
      );
      await response.body?.cancel();
      return response.status;
    },

    fakeCliProcesses() {
      return processTable()
        .filter((entry) => entry.command.includes(cliMarker))
        .map(({ pid, ppid }) => ({ pid, ppid }));
    },

    auditRecords() {
      try {
        return readFileSync(sessionHostPaths(home).auditLogPath, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Record<string, unknown>);
      } catch {
        return [];
      }
    },

    logs() {
      return [
        tail(path.join(home, "daemon.log")),
        tail(path.join(home, "session-host/host.log")),
        tail(path.join(home, "session-host/audit.log"), 3_000),
        tail(launchdLog, 3_000),
      ].join("\n");
    },

    async cleanup() {
      // Order matters: the job first, so launchd does not restart a host we are about to remove.
      if (jobLoaded) await bootoutJob(label).catch(() => {});
      await waitUntil(
        "the test job to unload",
        async () => (await printJob(label)) === null,
        25_000,
      ).catch(() => {});
      for (const supervisor of supervisors) {
        const child = supervisor.process;
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        for (const pid of supervisor.workers) if (alive(pid)) process.kill(pid, "SIGKILL");
      }
      // Everything this run started mentions its root, in its command line or as PASEO_HOME in
      // its environment, as the stand-in CLIs and terminal workers do. The shell and test runner
      // above this process may mention it too and are never touched.
      const spared = ancestorsOfThisProcess();
      for (const pid of processesMentioning((text) => text.includes(root)))
        if (!spared.has(pid) && alive(pid)) process.kill(pid, "SIGKILL");
      rmSync(root, { recursive: true, force: true });
    },
  };
  return installation;
}

interface ProcessEntry {
  pid: number;
  ppid: number;
  command: string;
}

/** Every process with its parent, one line each: command lines never contain newlines. */
function processTable(): ProcessEntry[] {
  return execFileSync("/bin/ps", ["-axww", "-o", "pid=,ppid=,command="], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\n")
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3]! }))
    .filter((entry) => entry.pid !== process.pid);
}

/**
 * Pids whose command line or environment satisfies matches. ps -E prints the environment after
 * the command, and a variable can contain newlines, so a record runs until the next line that
 * starts with a pid.
 */
function processesMentioning(matches: (text: string) => boolean): number[] {
  const output = execFileSync("/bin/ps", ["-axwwE", "-o", "pid=,command="], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const records: { pid: number; text: string }[] = [];
  for (const line of output.split("\n")) {
    const start = /^\s*(\d+)\s(.*)$/.exec(line);
    if (start) records.push({ pid: Number(start[1]), text: start[2]! });
    else if (records.length > 0) records[records.length - 1]!.text += `\n${line}`;
  }
  return records
    .filter((record) => record.pid !== process.pid && matches(record.text))
    .map((record) => record.pid);
}

/** This process and every ancestor, such as the shell that started the test. */
function ancestorsOfThisProcess(): Set<number> {
  const parents = new Map(processTable().map((entry) => [entry.pid, entry.ppid]));
  const ancestors = new Set<number>([process.pid]);
  for (let pid = process.ppid; pid > 1 && !ancestors.has(pid); pid = parents.get(pid) ?? 0)
    ancestors.add(pid);
  return ancestors;
}

/** Leftovers from any durable sessions test run, for the final cleanup check. */
export async function leftovers(): Promise<{
  jobs: string[];
  directories: string[];
  processes: string[];
}> {
  const jobs = execFileSync("/bin/launchctl", ["list"], { encoding: "utf8" })
    .split("\n")
    .filter((line) => line.includes("test.durable-sessions."));
  const directories = execFileSync("/bin/ls", ["/tmp"], { encoding: "utf8" })
    .split("\n")
    .filter((name) => /^dsh-(e2e|release-[a-z]+)-/.test(name));
  // The shell that started this test can mention these paths in its own command line.
  const spared = ancestorsOfThisProcess();
  const commands = new Map(processTable().map((entry) => [entry.pid, entry.command]));
  const processes = processesMentioning((text) => /\/tmp\/dsh-(e2e|release-[a-z]+)-/.test(text))
    .filter((pid) => !spared.has(pid))
    .map((pid) => `${pid} ${(commands.get(pid) ?? "").slice(0, 160)}`);
  return { jobs, directories, processes };
}

export interface TimelineSummary {
  /** Chunk numbers seen per scripted session id, in timeline order. */
  chunks: Map<string, number[]>;
  /** Every assistant message text, including replies to out-of-band commands. */
  assistantTexts: string[];
  userMessages: string[];
  systemErrors: string[];
  notifications: string[];
}

const CHUNK_PATTERN = /\[chunk ([a-z0-9]+):(\d+)\]/g;

export async function summarizeTimeline(
  client: DaemonClient,
  agentId: string,
): Promise<TimelineSummary> {
  const timeline = await client.fetchAgentTimeline(agentId, { direction: "tail", limit: 1_000 });
  const summary: TimelineSummary = {
    chunks: new Map(),
    assistantTexts: [],
    userMessages: [],
    systemErrors: [],
    notifications: [],
  };
  for (const entry of timeline.entries) {
    const item = entry.item as { type: string; text?: string; message?: string };
    if (item.type === "assistant_message" && item.text) {
      summary.assistantTexts.push(item.text);
      if (item.text.startsWith("[System Error]")) summary.systemErrors.push(item.text);
      for (const match of item.text.matchAll(CHUNK_PATTERN)) {
        const list = summary.chunks.get(match[1]!) ?? [];
        list.push(Number(match[2]));
        summary.chunks.set(match[1]!, list);
      }
    } else if (item.type === "user_message" && item.text) {
      summary.userMessages.push(item.text);
    } else if (item.type === "notification") {
      summary.notifications.push(item.message ?? item.text ?? JSON.stringify(item));
    }
  }
  return summary;
}

/**
 * Starts a scripted turn of `chunks` numbered chunks on the installation's provider and waits
 * until it is running in the host. With permissionAt, the turn pauses on a permission request
 * after that chunk.
 */
export async function startScriptedAgent(
  installation: Installation,
  client: DaemonClient,
  chunks: number,
  options: { permissionAt?: number } = {},
): Promise<string> {
  const permission = options.permissionAt ? ` PERMISSION_AT=${options.permissionAt}` : "";
  const agent = await client.createAgent({
    config: {
      provider: installation.agentProvider,
      cwd: path.join(installation.root, "work"),
      title: "durable sessions e2e",
    },
    initialPrompt: `Stream your scripted turn. CHUNKS=${chunks}${permission}`,
  });
  await client.waitForAgentUpsert(agent.id, (snapshot) => snapshot.status === "running", 60_000);
  return agent.id;
}

/** Waits until the turn's chunks reach at least n, so a restart lands mid-turn. */
export async function waitForChunks(
  client: DaemonClient,
  agentId: string,
  atLeast: number,
  timeoutMs = 60_000,
): Promise<number> {
  return waitUntil(
    `${atLeast} streamed chunks`,
    async () => {
      const summary = await summarizeTimeline(client, agentId);
      const seen = Math.max(0, ...[...summary.chunks.values()].map((list) => list.length));
      return seen >= atLeast ? seen : null;
    },
    timeoutMs,
    250,
  );
}
