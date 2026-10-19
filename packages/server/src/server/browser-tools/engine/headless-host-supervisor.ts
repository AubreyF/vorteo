import type {
  BrowserAutomationExecuteRequest,
  BrowserAutomationExecuteResponse,
} from "@getpaseo/protocol/browser-automation/rpc-schemas";
import type { HeadlessHostProcess } from "./headless-host-process-client.js";
import type { HeadlessHostProcessOptions } from "./headless-host-process-protocol.js";

type ExecutePayload = BrowserAutomationExecuteResponse["payload"];

const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
// A process that stayed up this long counts as healthy; its next exit restarts the backoff.
const HEALTHY_UPTIME_MS = 60_000;

export interface HeadlessHostSupervisorInput {
  options: HeadlessHostProcessOptions;
  spawn: (options: HeadlessHostProcessOptions) => Promise<HeadlessHostProcess>;
  onExit?: (detail: { uptimeMs: number; retryInMs: number }) => void;
  now?: () => number;
}

// Owns one headless browser host process. It starts the process on demand,
// fails requests fast during crash backoff instead of holding them, and
// restarts on the next request once the backoff passes.
export class HeadlessHostSupervisor {
  private current: Promise<HeadlessHostProcess> | null = null;
  private failures = 0;
  private retryAt = 0;
  private stopped = false;
  private readonly now: () => number;

  public constructor(private readonly input: HeadlessHostSupervisorInput) {
    this.now = input.now ?? Date.now;
  }

  // Starts the process now, for callers that want startup errors up front.
  public async start(): Promise<void> {
    await this.ensureProcess();
  }

  public async execute(request: BrowserAutomationExecuteRequest): Promise<ExecutePayload> {
    try {
      return await (await this.ensureProcess()).execute(request);
    } catch (error) {
      return {
        requestId: request.requestId,
        ok: false,
        error: {
          code: "browser_no_host",
          message: error instanceof Error ? error.message : String(error),
          retryable: true,
        },
      };
    }
  }

  public async stop(): Promise<void> {
    this.stopped = true;
    const current = await this.current?.catch(() => null);
    this.current = null;
    await current?.close();
  }

  private ensureProcess(): Promise<HeadlessHostProcess> {
    if (this.stopped) return Promise.reject(new Error("The headless browser host has stopped."));
    if (this.current) return this.current;
    const waitMs = this.retryAt - this.now();
    if (waitMs > 0) {
      return Promise.reject(
        new Error(
          `The headless browser host is restarting; retry in ${Math.ceil(waitMs / 1000)}s.`,
        ),
      );
    }
    const startedAt = this.now();
    const current = this.input.spawn(this.input.options).then(
      (process) => {
        void process.exited.then(() => this.handleExit(current, this.now() - startedAt));
        if (this.stopped) void process.close();
        return process;
      },
      (error: unknown) => {
        this.handleExit(current, 0);
        throw error;
      },
    );
    this.current = current;
    return current;
  }

  private handleExit(exitedProcess: Promise<HeadlessHostProcess>, uptimeMs: number): void {
    if (this.current !== exitedProcess) return;
    this.current = null;
    if (this.stopped) return;
    this.failures = uptimeMs >= HEALTHY_UPTIME_MS ? 1 : this.failures + 1;
    const retryInMs = Math.min(MIN_BACKOFF_MS * 2 ** (this.failures - 1), MAX_BACKOFF_MS);
    this.retryAt = this.now() + retryInMs;
    this.input.onExit?.({ uptimeMs, retryInMs });
  }
}
