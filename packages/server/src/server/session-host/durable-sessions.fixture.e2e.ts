import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
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
    let sent = 0;
    const tick = (): void => {
      sent += 1;
      this.text(chunkText(this.tag, sent));
      if (sent >= total) {
        this.stopTimer();
        this.complete();
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
