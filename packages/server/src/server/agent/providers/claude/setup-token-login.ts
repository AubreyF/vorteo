import { setTimeout, clearTimeout } from "node:timers";
import * as pty from "node-pty";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ProviderLoginChallenge,
  ProviderLoginSession,
} from "../../../../services/provider-login/session.js";
import { ensureNodePtySpawnHelperExecutableForCurrentPlatform } from "../../../../terminal/terminal.js";
import { createProviderEnv, type ProviderRuntimeSettings } from "../../provider-launch-config.js";
import { ClaudeSetupTokenError, ClaudeSetupTokenOutput } from "./setup-token-output.js";
import type { ClaudeSetupToken } from "./setup-token-store.js";

// React Native overloads global timers when browser fixtures import this Node-only module.
const nodeTimeout = setTimeout as (callback: () => void, delay: number) => NodeJS.Timeout;

export interface SetupTokenProcess {
  write(data: string): void;
  kill(signal?: string): void;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (event: { exitCode: number }) => void): { dispose(): void };
}
export interface SetupTokenSpawnInput {
  executable: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}
interface LoginOptions {
  executable: string;
  args: string[];
  scope: string;
  runtimeSettings?: ProviderRuntimeSettings;
  saveToken(token: ClaudeSetupToken, signal: AbortSignal): Promise<void>;
  spawn?: (input: SetupTokenSpawnInput) => SetupTokenProcess;
}

function spawnSetupToken(input: SetupTokenSpawnInput): SetupTokenProcess {
  ensureNodePtySpawnHelperExecutableForCurrentPlatform();
  return pty.spawn(input.executable, input.args, {
    cwd: input.cwd,
    env: input.env,
    name: "xterm-256color",
    cols: 2000,
    rows: 60,
  });
}

/** A private PTY, never registered with terminal history, logs, or client subscriptions. */
export class ClaudeSetupTokenLoginSession implements ProviderLoginSession {
  readonly scope: string;
  private process: SetupTokenProcess | null = null;
  private home: string | null = null;
  private closed: Promise<void> = Promise.resolve();
  private readonly cancellation = new AbortController();
  private readonly output = new ClaudeSetupTokenOutput();
  private acceptingCode = false;
  private receivedToken = false;
  private exited = false;
  private save: Promise<void> = Promise.resolve();

  constructor(private readonly options: LoginOptions) {
    this.scope = options.scope;
  }

  async start(onComplete: (success: boolean) => void): Promise<ProviderLoginChallenge> {
    if (this.cancellation.signal.aborted || this.process) throw new ClaudeSetupTokenError();
    this.home = await mkdtemp(join(tmpdir(), "vorteo-claude-connect-"));
    const config = join(this.home, "config");
    await mkdir(config, { mode: 0o700 });
    if (this.cancellation.signal.aborted) {
      await this.dispose();
      throw new ClaudeSetupTokenError();
    }
    const env = createProviderEnv({ runtimeSettings: this.options.runtimeSettings });
    for (const key of Object.keys(env)) {
      if (key.startsWith("CLAUDE_") || key.startsWith("ANTHROPIC_")) delete env[key];
    }
    Object.assign(env, {
      CLAUDE_CONFIG_DIR: config,
      CLAUDE_SECURESTORAGE_CONFIG_DIR: join(this.home, "secure"),
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_AUTOUPDATER: "1",
      BROWSER: process.platform === "win32" ? "cmd /c exit" : "/usr/bin/false",
    });
    const child = (this.options.spawn ?? spawnSetupToken)({
      executable: this.options.executable,
      args: [...this.options.args, "setup-token"],
      cwd: this.home,
      env,
    });
    this.process = child;
    this.closed = new Promise((resolve) =>
      child.onExit(() => {
        this.exited = true;
        resolve();
      }),
    );
    let accept!: (value: ProviderLoginChallenge) => void;
    let decline!: (error: Error) => void;
    const challengePromise = new Promise<ProviderLoginChallenge>((resolve, reject) => {
      accept = resolve;
      decline = reject;
    });
    const challenge = { promise: challengePromise, resolve: accept, reject: decline };
    let challengeSettled = false;
    {
      let challenged = false;
      const rejectChallenge = () => {
        if (challengeSettled) return;
        challengeSettled = true;
        challenge.reject(new ClaudeSetupTokenError());
      };
      const resolveChallenge = (verificationUrl: string) => {
        if (challengeSettled) return;
        challengeSettled = true;
        challenge.resolve({ verificationUrl, userCode: "", inputRequired: true });
      };
      let completed = false;
      const complete = (success: boolean) => {
        if (completed || this.cancellation.signal.aborted) return;
        completed = true;
        onComplete(success);
      };
      const timeout = nodeTimeout(() => {
        rejectChallenge();
        void this.dispose();
      }, 30_000);
      timeout.unref();
      child.onData((chunk) => {
        if (this.cancellation.signal.aborted || this.receivedToken) return;
        try {
          const result = this.output.append(chunk);
          if (result.verificationUrl && !challenged) {
            challenged = true;
            this.acceptingCode = true;
            clearTimeout(timeout);
            resolveChallenge(result.verificationUrl);
          }
          if (!result.token) return;
          if (!challenged) throw new ClaudeSetupTokenError();
          this.receivedToken = true;
          this.acceptingCode = false;
          this.output.clear();
          this.save = this.options
            .saveToken(
              { version: 1, accessToken: result.token, createdAt: Date.now() },
              this.cancellation.signal,
            )
            .then(
              () => complete(true),
              () => complete(false),
            );
        } catch {
          clearTimeout(timeout);
          rejectChallenge();
          complete(false);
          void this.dispose();
        }
      });
      child.onExit(() => {
        clearTimeout(timeout);
        this.output.clear();
        rejectChallenge();
        if (!this.receivedToken) complete(false);
      });
    }
    return challenge.promise;
  }

  async submitCode(code: string): Promise<void> {
    if (!code || code.length > 4096 || !/^[!-~]+$/.test(code)) throw new ClaudeSetupTokenError();
    if (!this.acceptingCode || !this.process || this.exited || this.cancellation.signal.aborted)
      throw new ClaudeSetupTokenError();
    this.acceptingCode = false;
    // Bracketed paste keeps long codes from being interpreted as individual terminal shortcuts.
    this.process.write(`\x1b[200~${code}\x1b[201~\r`);
  }

  async readAccountLabel(): Promise<string | null> {
    // setup-token prints no verified account identity. Never reuse a cached native-login email.
    return null;
  }

  cancel(): Promise<void> {
    return this.dispose();
  }

  async dispose(): Promise<void> {
    this.cancellation.abort();
    this.output.clear();
    if (this.process && !this.exited) {
      const child = this.process;
      child.kill("SIGTERM");
      const force = nodeTimeout(() => {
        if (!this.exited) child.kill("SIGKILL");
      }, 1000);
      force.unref();
      await this.closed;
      clearTimeout(force);
    }
    await this.save;
    if (this.home) {
      await rm(this.home, { recursive: true, force: true });
      this.home = null;
    }
  }
}
