import {
  loadTestClientFactory,
  loadTestServiceOptions,
  startSessionHostService,
} from "../src/server/session-host/service.js";

/**
 * Process entry for the durable session host, run by its own launchd job so provider sessions
 * outlive daemon workers and supervisors. It never listens on TCP: a starting daemon worker kills
 * TCP listeners whose command looks like a daemon worker, and the host must not be mistaken for
 * one, which is also why this file is not named like the worker entry.
 *
 * Test switch: with NODE_ENV=test, PASEO_SESSION_HOST_TEST_CLIENT_MODULE names a module whose
 * `createClient` export replaces the Claude client. It is ignored in any other environment.
 */
async function main(): Promise<void> {
  await startSessionHostService({
    createClient: await loadTestClientFactory(process.env),
    ...loadTestServiceOptions(process.env),
  });
}

main().catch((error: unknown) => {
  // The host log may not exist yet; launchd keeps stderr in the job's error log.
  process.stderr.write(
    `${JSON.stringify({ time: Date.now(), msg: "Session host failed to start", error: String(error) })}\n`,
  );
  process.exit(1);
});
