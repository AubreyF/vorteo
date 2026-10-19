import type { HeadlessBrowserHost, LaunchHeadlessBrowserHostOptions } from "./headless-host.js";
import type {
  HeadlessHostChildMessage,
  HeadlessHostParentMessage,
  HeadlessHostProcessOptions,
} from "./headless-host-process-protocol.js";

export interface HeadlessHostChannel {
  send(message: HeadlessHostChildMessage): void;
  onMessage(listener: (message: HeadlessHostParentMessage) => void): void;
  onDisconnect(listener: () => void): void;
}

export interface HeadlessHostProcessRun {
  // Resolves after the browser closes; false when it never started.
  done: Promise<boolean>;
  close(): Promise<void>;
}

// Runs a headless browser host behind a message channel. The child entry
// wires this to Node IPC so Playwright never loads in the daemon or CLI process.
export async function runHeadlessHostProcess(input: {
  channel: HeadlessHostChannel;
  options: HeadlessHostProcessOptions;
  launch: (options: LaunchHeadlessBrowserHostOptions) => Promise<HeadlessBrowserHost>;
}): Promise<HeadlessHostProcessRun> {
  const { channel, options } = input;
  let host: HeadlessBrowserHost;
  try {
    host = await input.launch({
      deniedHosts: options.deniedHosts,
      ...(options.viewport ? { viewport: options.viewport } : {}),
      ...(options.headed ? { headed: true } : {}),
    });
  } catch (error) {
    channel.send({
      type: "fatal",
      message: error instanceof Error ? error.message : String(error),
    });
    return { done: Promise.resolve(false), close: async () => {} };
  }

  let closing: Promise<void> | null = null;
  let resolveDone: (started: boolean) => void = () => {};
  const done = new Promise<boolean>((resolve) => {
    resolveDone = resolve;
  });
  function close(): Promise<void> {
    closing ??= host.close().finally(() => resolveDone(true));
    return closing;
  }

  async function answer(message: HeadlessHostParentMessage): Promise<void> {
    const payload = await host.execute(message.request);
    if (!closing) channel.send({ type: "response", payload });
  }
  channel.onMessage((message) => {
    if (message.type === "execute" && !closing) void answer(message);
  });
  // The parent owns this process; losing it means nobody can use the browser.
  channel.onDisconnect(() => void close());
  channel.send({ type: "ready" });
  return { done, close };
}
