import { setTimeout, clearTimeout } from "node:timers";
import { randomUUID } from "node:crypto";
import type { ProviderLoginState } from "@getpaseo/protocol/provider-login";
import type { ProviderLoginSession } from "./session.js";

// React Native overloads global timers when browser fixtures import this Node-only module.
const nodeTimeout = setTimeout as (callback: () => void, delay: number) => NodeJS.Timeout;

interface LoginClient {
  openAccountLoginSession?(): Promise<ProviderLoginSession>;
}
interface LoginServiceOptions {
  getClient(providerId: string): LoginClient | null;
  onConnected(providerId: string): void;
  now?: () => number;
  schedule?: (callback: () => void, delay: number) => () => void;
}
interface Attempt {
  providerId: string;
  state: ProviderLoginState;
  session: ProviderLoginSession | null;
  expiresAt: string;
  stopTimer: () => void;
  task: Promise<void>;
}
const SIGN_IN_LIFETIME_MS = 15 * 60_000;
function isActive(state: ProviderLoginState): boolean {
  return state.status === "starting" || state.status === "waiting" || state.status === "verifying";
}
function scheduleTimeout(callback: () => void, delay: number): () => void {
  const timer = nodeTimeout(callback, delay);
  timer.unref();
  return () => clearTimeout(timer);
}

/** Daemon-owned attempts survive client reconnects; codes never enter persistent storage. */
export class ProviderLoginService {
  private readonly attempts = new Map<string, Attempt>();
  private readonly scopes = new Map<string, Attempt>();
  private readonly now: () => number;
  private readonly schedule: NonNullable<LoginServiceOptions["schedule"]>;
  private disposed = false;
  constructor(private readonly options: LoginServiceOptions) {
    this.now = options.now ?? Date.now;
    this.schedule = options.schedule ?? scheduleTimeout;
  }

  read(providerId: string): ProviderLoginState {
    return this.attempts.get(providerId)?.state ?? { status: "idle" };
  }

  start(providerId: string): ProviderLoginState {
    const current = this.attempts.get(providerId);
    if (current && isActive(current.state)) return current.state;
    const attemptId = randomUUID();
    const attempt: Attempt = {
      providerId,
      state: { status: "starting", attemptId },
      expiresAt: new Date(this.now() + SIGN_IN_LIFETIME_MS).toISOString(),
      session: null,
      stopTimer: () => {},
      task: Promise.resolve(),
    };
    this.attempts.set(providerId, attempt);
    if (this.disposed) {
      attempt.state = {
        status: "failed",
        attemptId,
        message: "The host is shutting down. Reconnect and try again.",
      };
      return attempt.state;
    }
    attempt.stopTimer = this.schedule(() => {
      if (!isActive(attempt.state)) return;
      attempt.state = {
        status: "failed",
        attemptId,
        message: "The sign-in code expired. Start again to get a new code.",
      };
      void this.release(attempt);
    }, SIGN_IN_LIFETIME_MS);
    attempt.task = this.begin(attempt, attemptId);
    return attempt.state;
  }

  private async begin(attempt: Attempt, attemptId: string): Promise<void> {
    try {
      const client = this.options.getClient(attempt.providerId);
      if (!client?.openAccountLoginSession)
        throw new Error("Provider does not support device sign-in");
      const session = await client.openAccountLoginSession();
      if (!isActive(attempt.state)) {
        await session.dispose();
        return;
      }
      const shared = this.scopes.get(session.scope);
      if (shared && isActive(shared.state)) {
        attempt.stopTimer();
        this.attempts.set(attempt.providerId, shared);
        await session.dispose();
        return;
      }
      this.scopes.set(session.scope, attempt);
      attempt.session = session;
      const challenge = await session.start((success) => {
        void this.complete(attempt, attemptId, success);
      });
      if (attempt.state.status === "starting") {
        attempt.state = {
          status: "waiting",
          attemptId,
          ...challenge,
          expiresAt: attempt.expiresAt,
        };
      }
    } catch {
      if (isActive(attempt.state)) {
        attempt.state = {
          status: "failed",
          attemptId,
          message:
            "Could not start account sign-in. Check the host connection and update this account’s CLI. For ChatGPT accounts, enable device-code sign-in in ChatGPT security settings. Then try again.",
        };
      }
      await this.release(attempt);
    }
  }

  private async complete(attempt: Attempt, attemptId: string, success: boolean): Promise<void> {
    if (!isActive(attempt.state) || attempt.state.status === "verifying") return;
    if (!success) {
      attempt.state = {
        status: "failed",
        attemptId,
        message:
          "Sign-in did not complete. The code may have expired or access was denied. Start again for a new code.",
      };
      await this.release(attempt);
      return;
    }
    attempt.state = { status: "verifying", attemptId };
    let accountLabel: string | null = null;
    const session = attempt.session;
    try {
      if (session) accountLabel = await session.readAccountLabel();
    } catch {
      /* Login completion already proves credentials were saved. */
    }
    if (attempt.state.status !== "verifying") return;
    attempt.state = { status: "succeeded", attemptId, accountLabel };
    this.options.onConnected(attempt.providerId);
    await this.release(attempt);
  }

  async submitCode(
    providerId: string,
    attemptId: string,
    code: string,
  ): Promise<ProviderLoginState> {
    const attempt = this.attempts.get(providerId);
    if (
      !attempt ||
      attempt.state.status !== "waiting" ||
      attempt.state.attemptId !== attemptId ||
      !attempt.session?.submitCode
    )
      throw new Error("This sign-in attempt is no longer accepting a code. Refresh its status.");
    await attempt.session.submitCode(code);
    return attempt.state;
  }

  async cancel(providerId: string, attemptId: string): Promise<ProviderLoginState> {
    const attempt = this.attempts.get(providerId);
    if (
      !attempt ||
      attempt.state.status === "idle" ||
      attempt.state.attemptId !== attemptId ||
      !isActive(attempt.state)
    )
      return this.read(providerId);
    attempt.state = { status: "cancelled", attemptId };
    try {
      await attempt.session?.cancel();
    } catch {
      /* Disposing the dedicated process also cancels its polling. */
    }
    await this.release(attempt);
    return attempt.state;
  }

  private async release(attempt: Attempt): Promise<void> {
    attempt.stopTimer();
    const session = attempt.session;
    attempt.session = null;
    if (!session) return;
    if (this.scopes.get(session.scope) === attempt) this.scopes.delete(session.scope);
    try {
      await session.dispose();
    } catch {
      /* The transport already force-kills its dedicated process. */
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const attempts = [...new Set(this.attempts.values())];
    await Promise.all(
      attempts.map(async (attempt) => {
        if (attempt.state.status !== "idle")
          await this.cancel(attempt.providerId, attempt.state.attemptId);
        await attempt.task;
        await this.release(attempt);
      }),
    );
    this.attempts.clear();
    this.scopes.clear();
  }
}
