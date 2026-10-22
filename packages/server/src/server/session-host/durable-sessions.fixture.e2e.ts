import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import type {
  AgentClient,
  AgentPersistenceHandle,
  AgentPromptInput,
  AgentSessionConfig,
} from "../agent/agent-sdk-types.js";
import {
  CONTROLLED_SESSION_CAPABILITIES,
  ControlledSession,
} from "../test-utils/controlled-provider-session.js";

/**
 * The session host's fake provider for durable-sessions.e2e.test.ts, loaded through the host's
 * test client module switch. Each session runs a scripted turn: numbered assistant chunks about
 * once a second, then completion, so a test can restart the daemon in the middle of it. Each
 * session also holds a child process standing in for the Claude CLI, so the test can check that
 * no provider process outlives its session or its host.
 */

/** A prompt containing `CHUNKS=<n>` streams n chunks; any other prompt, such as a continuation, streams this many. */
const DEFAULT_CHUNKS = 3;
/**
 * A prompt containing `PERMISSION_AT=<k>` pauses the turn after chunk k on a permission request,
 * as a tool call would, and resumes once it is allowed.
 */
const PERMISSION_PATTERN = /PERMISSION_AT=(\d+)/;
/**
 * A prompt containing `TOOL_AT=<k>` pauses the turn after chunk k, waits a moment so a restart
 * started at that chunk is under way, then lists the daemon's tools through the configured paseo
 * server, as a provider's tool call would, and reports the outcome as a line before resuming.
 */
const TOOL_PATTERN = /TOOL_AT=(\d+)/;
const TOOL_DELAY_MS = Number(process.env.DURABLE_SESSIONS_FAKE_TOOL_DELAY_MS ?? 3_000);
/**
 * When set, the tool call waits for this file to exist instead of the delay, so a test can kill
 * the worker first and then release the call, which makes the hold certain rather than likely.
 */
const TOOL_TRIGGER = process.env.DURABLE_SESSIONS_FAKE_TOOL_TRIGGER;
const TOOL_TIMEOUT_MS = 90_000;
const CHUNK_INTERVAL_MS = Number(process.env.DURABLE_SESSIONS_FAKE_CHUNK_MS ?? 1_000);
/** Marks this run's stand-in CLI processes, so the test finds exactly its own. */
const CLI_MARKER = process.env.DURABLE_SESSIONS_FAKE_CLI_MARKER ?? "durable-sessions-fake-cli";
/**
 * The provider shape of every session (see FAKE_PROVIDER_ENV in the harness). The Codex shape
 * carries goal state and runs /goal and /compact out of band, as the real Codex adapter does.
 */
const PROVIDER = process.env.DURABLE_SESSIONS_FAKE_PROVIDER === "codex" ? "codex" : "claude";

function promptText(prompt: AgentPromptInput): string {
  if (typeof prompt === "string") return prompt;
  return prompt
    .map((block) => ("text" in block && typeof block.text === "string" ? block.text : ""))
    .join("");
}

/**
 * The text of one chunk. The id is fresh for every session, so a continuation on a new session is
 * told apart from the original turn, and the test can count each chunk of each session.
 */
function chunkText(sessionTag: string, chunk: number): string {
  return `[chunk ${sessionTag}:${chunk}]`;
}

/**
 * Lists the daemon's tools through the paseo server in the session config. Only the relay's
 * stdio form is spoken here: the bridge is run as the provider would run it, and the MCP stdio
 * framing goes over its stdin and stdout. The direct http form the worker injects means the host
 * did not rewrite the config, which the test reports as an error.
 */
async function listDaemonTools(config: AgentSessionConfig): Promise<number> {
  const server = config.mcpServers?.paseo;
  if (!server) throw new Error("no paseo server configured");
  if (server.type !== "stdio") throw new Error(`paseo server is ${server.type}, not the relay`);
  const bridge = spawn(server.command, server.args ?? [], { stdio: ["pipe", "pipe", "pipe"] });
  const lines = createInterface({ input: bridge.stdout });
  const send = (message: unknown) => bridge.stdin.write(`${JSON.stringify(message)}\n`);
  try {
    return await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("tool call timed out")), TOOL_TIMEOUT_MS);
      lines.on("line", (line) => {
        const message = JSON.parse(line) as {
          id?: number;
          result?: { tools?: unknown[] };
          error?: { message?: string };
        };
        if (message.id !== 2) return;
        clearTimeout(timer);
        if (message.error) reject(new Error(message.error.message ?? "tool call failed"));
        else resolve(message.result?.tools?.length ?? 0);
      });
      bridge.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`bridge exited with ${code}`));
      });
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "durable-sessions-fixture", version: "0" },
        },
      });
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    });
  } finally {
    lines.close();
    bridge.kill("SIGKILL");
  }
}

class ScriptedSession extends ControlledSession {
  private readonly cli: ChildProcess;
  private timer: NodeJS.Timeout | null = null;
  private readonly tag = randomBytes(4).toString("hex");

  constructor(config: AgentSessionConfig) {
    super(config, [], { provider: PROVIDER, goals: PROVIDER === "codex" });
    // Stands in for the provider CLI: a plain child in the host's process group, as Claude's is.
    this.cli = spawn(process.execPath, ["-e", "setInterval(() => {}, 60_000)", CLI_MARKER], {
      stdio: "ignore",
    });
  }

  override async startTurn(prompt: AgentPromptInput): Promise<{ turnId: string }> {
    const started = await super.startTurn(prompt);
    const text = promptText(prompt);
    const match = /CHUNKS=(\d+)/.exec(text);
    const total = match ? Number(match[1]) : DEFAULT_CHUNKS;
    const permissionAt = Number(PERMISSION_PATTERN.exec(text)?.[1] ?? 0);
    const toolAt = Number(TOOL_PATTERN.exec(text)?.[1] ?? 0);
    let sent = 0;
    const tick = (): void => {
      sent += 1;
      this.text(chunkText(this.tag, sent));
      if (sent >= total) {
        this.stopTimer();
        this.complete();
        return;
      }
      if (sent === toolAt) {
        this.stopTimer();
        void this.pauseForTool(tick);
        return;
      }
      if (sent !== permissionAt) return;
      this.stopTimer();
      void this.pauseForPermission(tick);
    };
    this.timer = setInterval(tick, CHUNK_INTERVAL_MS);
    return started;
  }

  /** Waits on a permission, as a tool call would, and resumes the turn once it is allowed. */
  private async pauseForPermission(resume: () => void): Promise<void> {
    const response = await this.requestPermission(`perm-${this.tag}`);
    if (response.behavior === "allow") this.timer = setInterval(resume, CHUNK_INTERVAL_MS);
    else this.complete();
  }

  /** Calls the daemon's tools the way the provider would, through the server the host configured. */
  private async pauseForTool(resume: () => void): Promise<void> {
    if (TOOL_TRIGGER) {
      const deadline = Date.now() + TOOL_TIMEOUT_MS;
      while (!existsSync(TOOL_TRIGGER) && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 100));
    } else await new Promise((resolve) => setTimeout(resolve, TOOL_DELAY_MS));
    try {
      const count = await listDaemonTools(this.config);
      this.text(`[tool ok ${count} tools]`);
    } catch (error) {
      this.text(`[tool error ${error instanceof Error ? error.message : String(error)}]`);
    }
    this.timer = setInterval(resume, CHUNK_INTERVAL_MS);
  }

  override async interrupt(): Promise<void> {
    this.stopTimer();
    await super.interrupt();
  }

  override async close(): Promise<void> {
    this.stopTimer();
    this.cli.kill("SIGKILL");
    await super.close();
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

export function createClient(): AgentClient {
  return {
    provider: PROVIDER,
    capabilities: CONTROLLED_SESSION_CAPABILITIES,
    async createSession(config) {
      return new ScriptedSession(config);
    },
    async resumeSession(_handle: AgentPersistenceHandle, overrides) {
      return new ScriptedSession({
        provider: PROVIDER,
        cwd: "/",
        ...overrides,
      } as AgentSessionConfig);
    },
    async fetchCatalog() {
      return { models: [], modes: [] };
    },
    async isAvailable() {
      return true;
    },
  };
}
