// Entry point for the headless browser host process. The daemon and
// `paseo browser host` fork this file instead of importing Playwright, which
// keeps Playwright out of the Host startup module contract and isolates
// browser crashes from the daemon. It is not part of that contract.
import { launchHeadlessBrowserHost } from "./headless-host.js";
import {
  decodeHeadlessHostProcessOptions,
  parseHeadlessHostParentMessage,
} from "./headless-host-process-protocol.js";
import { runHeadlessHostProcess } from "./headless-host-process-runner.js";

async function main(): Promise<number> {
  const send = process.send?.bind(process);
  if (!send) {
    process.stderr.write("The headless browser host must be started over Node IPC.\n");
    return 2;
  }
  let options;
  try {
    options = decodeHeadlessHostProcessOptions(process.argv[2]);
  } catch (error) {
    send({ type: "fatal", message: error instanceof Error ? error.message : String(error) });
    return 1;
  }
  const run = await runHeadlessHostProcess({
    options,
    launch: launchHeadlessBrowserHost,
    channel: {
      send: (message) => void send(message),
      onMessage: (listener) =>
        process.on("message", (raw) => {
          const message = parseHeadlessHostParentMessage(raw);
          if (message) listener(message);
        }),
      onDisconnect: (listener) => process.once("disconnect", listener),
    },
  });
  process.once("SIGTERM", () => void run.close());
  process.once("SIGINT", () => void run.close());
  return (await run.done) ? 0 : 1;
}

process.exitCode = await main();
// Close the IPC channel so the event loop can drain after the browser exits.
if (process.connected) process.disconnect();
