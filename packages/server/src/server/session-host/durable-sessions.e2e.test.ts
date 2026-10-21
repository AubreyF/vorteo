import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, test } from "vitest";
import type { DaemonClient } from "../test-utils/daemon-client.js";
import {
  createInstallation,
  HOST_LOSS_CONTINUATION,
  leftovers,
  releaseOf,
  RESTART_CONTINUATION,
  startScriptedAgent,
  summarizeTimeline,
  thisRepoRoot,
  waitForChunks,
  waitUntil,
  type Installation,
  type ReleaseTree,
} from "./durable-sessions.harness.e2e.js";

/**
 * Durable sessions phase 1, proven against real processes: a session host run by launchd, and a
 * real supervisor and worker in an isolated PASEO_HOME. The host runs a scripted fake Claude
 * (durable-sessions.fixture.e2e.ts) whose turn streams numbered chunks about once a second, so
 * each test can restart something in the middle of a turn.
 *
 * Run on request only, on macOS: DURABLE_SESSIONS_E2E=1 npx vitest run <this file> --bail=1
 */

const ENABLED = process.env.DURABLE_SESSIONS_E2E === "1" && process.platform === "darwin";
const TURN_CHUNKS = 20;
/** Chunks streamed before the restart, so it lands well inside the turn. */
const RESTART_AFTER_CHUNKS = 4;
const THIS_TREE: ReleaseTree = { repoRoot: thisRepoRoot };

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const step of cleanups.splice(0).toReversed()) await step();
});

afterAll(async () => {
  if (!ENABLED) return;
  // Every job, directory and process from this file must be gone, even after a failure.
  expect(await leftovers()).toEqual({ jobs: [], directories: [], processes: [] });
});

/** Timings go straight to stdout; the console is not reliably shown for passing tests. */
function report(line: string): void {
  process.stdout.write(`${line}\n`);
}

async function freshInstallation(options: { password?: boolean } = {}): Promise<Installation> {
  const created = await createInstallation({ provider: "fake", ...options });
  cleanups.push(() => created.cleanup());
  return created;
}

async function connected(installation: Installation): Promise<DaemonClient> {
  const client = await installation.client();
  cleanups.push(() => client.close().catch(() => {}));
  return client;
}

/** Waits until the agent is idle and the turn has streamed through its last chunk. */
async function waitForTurnEnd(
  client: DaemonClient,
  agentId: string,
  lastChunk: number,
  timeoutMs = 120_000,
) {
  return waitUntil(
    "the turn to finish",
    async () => {
      const agent = (await client.fetchAgent(agentId))?.agent;
      if (agent?.status !== "idle") return null;
      const summary = await summarizeTimeline(client, agentId);
      const done = [...summary.chunks.values()].some((list) => list.includes(lastChunk));
      return done ? { agent, summary } : null;
    },
    timeoutMs,
    500,
  );
}

/** A hosted turn that survived: every chunk exactly once, no failure, no continuation of any kind. */
async function expectUninterruptedTurn(client: DaemonClient, agentId: string): Promise<void> {
  const { agent, summary } = await waitForTurnEnd(client, agentId, TURN_CHUNKS);
  expect([...summary.chunks.values()]).toEqual([
    Array.from({ length: TURN_CHUNKS }, (_, index) => index + 1),
  ]);
  expect(summary.systemErrors).toEqual([]);
  expect(
    summary.userMessages.filter(
      (text) => text.includes(HOST_LOSS_CONTINUATION) || text.includes(RESTART_CONTINUATION),
    ),
  ).toEqual([]);
  expect((agent as { lastError?: unknown }).lastError ?? null).toBeNull();
  const queue = await client.readMessageQueue(agentId);
  expect(queue.snapshot?.items ?? []).toEqual([]);
}

/** Every stand-in CLI belongs to the live host, one per hosted session. */
function expectProviderProcesses(installation: Installation, hostPid: number, count: number) {
  const processes = installation.fakeCliProcesses();
  expect(processes.map((entry) => entry.ppid)).toEqual(
    Array.from({ length: count }, () => hostPid),
  );
}

/** Stand-in CLIs whose parent is the given host process. */
function providersOf(install: Installation, hostPid: number): number {
  return install.fakeCliProcesses().filter((entry) => entry.ppid === hostPid).length;
}

/** Attachments the host recorded after a moment, from workers other than the first. */
function attachesSince(installation: Installation, since: number) {
  return installation
    .auditRecords()
    .filter((record) => record.event === "attach" && Date.parse(String(record.at)) >= since);
}

describe.skipIf(!ENABLED)("durable sessions with a real daemon", () => {
  test("a worker killed mid-turn is replaced and the hosted turn completes", async () => {
    const install = await freshInstallation();
    const host = await install.startHost(THIS_TREE);
    const supervisor = await install.startSupervisor(THIS_TREE);
    const firstWorker = supervisor.workers[0]!;
    const client = await connected(install);
    const agentId = await startScriptedAgent(install, client, TURN_CHUNKS);
    await waitForChunks(client, agentId, RESTART_AFTER_CHUNKS);
    expectProviderProcesses(install, host.pid, 1);
    await client.close();

    const killedAt = Date.now();
    process.kill(firstWorker, "SIGKILL");
    const nextWorker = await supervisor.waitForWorker([firstWorker]);
    const readyMs = Date.now() - killedAt;
    const next = await connected(install);
    await expectUninterruptedTurn(next, agentId);
    const doneMs = Date.now() - killedAt;

    expect(nextWorker).not.toBe(firstWorker);
    expect((await install.host()).pid).toBe(host.pid);
    expect(attachesSince(install, killedAt).length).toBeGreaterThan(0);
    expectProviderProcesses(install, host.pid, 1);
    report(`[worker kill] new worker listening after ${readyMs} ms, turn done after ${doneMs} ms`);
  }, 300_000);

  test("a graceful supervisor restart mid-turn leaves the hosted turn running", async () => {
    const install = await freshInstallation();
    const host = await install.startHost(THIS_TREE);
    const first = await install.startSupervisor(THIS_TREE);
    const client = await connected(install);
    const agentId = await startScriptedAgent(install, client, TURN_CHUNKS);
    await waitForChunks(client, agentId, RESTART_AFTER_CHUNKS);
    await client.close();

    const stoppedAt = Date.now();
    await first.stop();
    const stopMs = Date.now() - stoppedAt;
    // The provider kept running in the host while no daemon existed.
    expectProviderProcesses(install, host.pid, 1);
    const second = await install.startSupervisor(THIS_TREE);
    const readyMs = Date.now() - stoppedAt;
    const next = await connected(install);
    await expectUninterruptedTurn(next, agentId);
    const doneMs = Date.now() - stoppedAt;

    expect(second.workers[0]).not.toBe(first.workers[0]);
    expect((await install.host()).pid).toBe(host.pid);
    expect(attachesSince(install, stoppedAt).length).toBeGreaterThan(0);
    expectProviderProcesses(install, host.pid, 1);
    report(
      `[supervisor restart] stopped in ${stopMs} ms, new worker after ${readyMs} ms, turn done after ${doneMs} ms`,
    );
  }, 300_000);

  // Two release labels on one protocol, not an upgrade: the trees differ only in their version, run
  // from source and use a fixed plist path. A real upgrade is left to installed acceptance.
  test("a host on release label A finishes the hosted turn for a worker on release label B", async () => {
    // Cloned first so it is removed last, after every process running from it is gone.
    const releaseA = cloneRelease("release-a");
    const install = await freshInstallation();
    const versionA = releaseOf(releaseA);
    const versionB = releaseOf(THIS_TREE);
    expect(versionA).not.toBe(versionB);

    const host = await install.startHost(releaseA);
    expect(host.release).toBe(versionA);
    const first = await install.startSupervisor(releaseA);
    const client = await connected(install);
    const agentId = await startScriptedAgent(install, client, TURN_CHUNKS);
    await waitForChunks(client, agentId, RESTART_AFTER_CHUNKS);
    await client.close();

    const upgradedAt = Date.now();
    await first.stop();
    await install.startSupervisor(THIS_TREE);
    const next = await connected(install);
    await expectUninterruptedTurn(next, agentId);
    const doneMs = Date.now() - upgradedAt;

    // The host stayed on release A throughout; the worker that finished the turn ran release B.
    const finalHost = await install.host();
    expect(finalHost).toMatchObject({ pid: host.pid, release: versionA });
    const helloReleases = install
      .auditRecords()
      .filter((record) => record.event === "hello_accepted")
      .map((record) => record.clientRelease);
    expect(helloReleases).toContain(versionA);
    expect(helloReleases).toContain(versionB);
    expectProviderProcesses(install, host.pid, 1);
    report(`[release labels] ${versionA} -> ${versionB}, turn done after ${doneMs} ms`);
  }, 600_000);

  test("a permission asked before a worker kill is answered after the replacement attaches", async () => {
    const install = await freshInstallation();
    const host = await install.startHost(THIS_TREE);
    const supervisor = await install.startSupervisor(THIS_TREE);
    const firstWorker = supervisor.workers[0]!;
    const client = await connected(install);
    const agentId = await startScriptedAgent(install, client, TURN_CHUNKS, { permissionAt: 3 });
    const asked = await waitUntil(
      "the permission request",
      async () => (await client.fetchAgent(agentId))?.agent?.pendingPermissions?.[0]?.id,
      60_000,
    );
    await client.close();

    const killedAt = Date.now();
    process.kill(firstWorker, "SIGKILL");
    await supervisor.waitForWorker([firstWorker]);
    const next = await connected(install);
    // The replacement shows the same request once and delivers the answer to the running turn.
    const pending = await waitUntil(
      "the permission after the restart",
      async () => {
        const agent = (await next.fetchAgent(agentId))?.agent;
        return agent?.pendingPermissions?.length ? agent.pendingPermissions : null;
      },
      60_000,
    );
    expect(pending.map((request) => request.id)).toEqual([asked]);
    await next.respondToPermission(agentId, asked, { behavior: "allow" });
    await expectUninterruptedTurn(next, agentId);
    const doneMs = Date.now() - killedAt;

    expect((await install.host()).pid).toBe(host.pid);
    expectProviderProcesses(install, host.pid, 1);
    report(`[permission across restart] turn done ${doneMs} ms after the kill`);
  }, 300_000);

  test("the replacement worker accepts the session host's tool token at the agent endpoint", async () => {
    // Only a password-protected daemon checks tokens at the endpoint.
    const install = await freshInstallation({ password: true });
    await install.startHost(THIS_TREE);
    const supervisor = await install.startSupervisor(THIS_TREE);
    const firstWorker = supervisor.workers[0]!;
    const client = await connected(install);
    const agentId = await startScriptedAgent(install, client, TURN_CHUNKS);
    await waitForChunks(client, agentId, RESTART_AFTER_CHUNKS);
    await client.close();

    const killedAt = Date.now();
    process.kill(firstWorker, "SIGKILL");
    await supervisor.waitForWorker([firstWorker]);
    const next = await connected(install);
    await waitUntil(
      "the replacement worker to attach",
      () => attachesSince(install, killedAt).length > 0,
      60_000,
    );

    // The hosted provider still holds the host's token, issued before the restart.
    const hostToken = await install.hostMcpToken();
    expect(await install.postAgentEndpoint(agentId, hostToken)).toBe(200);
    expect(await install.postAgentEndpoint(agentId, `${hostToken}x`)).toBe(401);
    await expectUninterruptedTurn(next, agentId);
  }, 300_000);

  test("a host killed mid-turn is restarted and the agent finishes from one continuation", async () => {
    const install = await freshInstallation();
    const host = await install.startHost(THIS_TREE);
    await install.startSupervisor(THIS_TREE);
    const client = await connected(install);
    const agentId = await startScriptedAgent(install, client, TURN_CHUNKS);
    await waitForChunks(client, agentId, RESTART_AFTER_CHUNKS);

    const killedAt = Date.now();
    process.kill(host.pid, "SIGKILL");
    // launchd's process group cleanup takes the provider with the host: no second writer.
    await waitUntil(
      "the killed host's provider to exit",
      () => providersOf(install, host.pid) === 0,
      10_000,
    );
    const restarted = await install.host({ notPid: host.pid });
    const hostBackMs = Date.now() - killedAt;

    const { agent, summary } = await waitUntil(
      "the continuation turn to finish",
      async () => {
        const current = (await client.fetchAgent(agentId))?.agent;
        const timeline = await summarizeTimeline(client, agentId);
        return current?.status === "idle" && timeline.chunks.size === 2
          ? { agent: current, summary: timeline }
          : null;
      },
      120_000,
      500,
    );
    const doneMs = Date.now() - killedAt;

    expect(
      summary.userMessages.filter((text) => text.includes(HOST_LOSS_CONTINUATION)),
    ).toHaveLength(1);
    expect(summary.userMessages.filter((text) => text.includes(RESTART_CONTINUATION))).toEqual([]);
    const [original, continuation] = [...summary.chunks.values()];
    // The interrupted turn's chunks appear once each, in order, up to where the host died.
    expect(original).toEqual(Array.from({ length: original!.length }, (_, index) => index + 1));
    expect(original!.length).toBeLessThan(TURN_CHUNKS);
    // The continuation ran a fresh scripted session to completion.
    expect(continuation).toEqual([1, 2, 3]);
    expect(summary.systemErrors).toEqual([]);
    expect((agent as { lastError?: unknown }).lastError ?? null).toBeNull();
    expect((await client.readMessageQueue(agentId)).snapshot?.items ?? []).toEqual([]);
    expectProviderProcesses(install, restarted.pid, 1);
    report(`[host kill] host back after ${hostBackMs} ms, continuation done after ${doneMs} ms`);
  }, 300_000);
});

/**
 * Release A for the upgrade test: an APFS clone (copy on write, so nearly free in space) of the
 * packages the daemon and host load, with only the server package version changed. Both trees
 * share the session host protocol, as two adjacent releases would.
 */
function cloneRelease(name: string): ReleaseTree {
  const root = mkdtempSync(`/tmp/dsh-${name}-`);
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "packages"));
  const entries = [
    "package.json",
    "node_modules",
    "plugins",
    ...["server", "protocol", "client", "highlight", "plugin", "relay"].map((pkg) =>
      path.join("packages", pkg),
    ),
  ];
  for (const entry of entries)
    execFileSync("/bin/cp", ["-c", "-R", path.join(thisRepoRoot, entry), path.join(root, entry)]);
  const manifestPath = path.join(root, "packages/server/package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { version: string };
  manifest.version = `${manifest.version}-${name}`;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { repoRoot: root };
}
