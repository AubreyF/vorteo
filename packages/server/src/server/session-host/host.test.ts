import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue } from "@getpaseo/protocol/agent-types";
import { afterEach, expect, test } from "vitest";
import { connectSessionHost, type HostedSession, type SessionHostClient } from "./client.js";
import {
  claimSocketPath,
  createRotatingAppender,
  createSessionHostAuditLog,
  preparePrivateDirectory,
  readSessionHostLock,
  readSessionHostToken,
  rotateSessionHostToken,
  SessionHostAlreadyRunningError,
  sessionHostPaths,
  type SessionHostAuditRecord,
} from "./host-files.js";
import {
  startSessionHost,
  type HostedSessionPort,
  type SessionHost,
  type SessionHostLimits,
} from "./host.js";
import { SELF_PROBE_RELEASE, SESSION_HOST_PROTOCOL_VERSION } from "./protocol.js";

const token = "test-session-host-token";
const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

/** A provider session whose turn keeps running until the test finishes it. */
function controllableSession() {
  const listeners = new Set<(event: JsonValue) => void>();
  const permissions = new Map<string, JsonValue>();
  const answers: [string, JsonValue][] = [];
  const counts = { interrupted: 0, closed: 0 };
  function emit(event: JsonValue): void {
    for (const listener of listeners) listener(event);
  }
  const port: HostedSessionPort = {
    async call(call) {
      switch (call.method) {
        case "startTurn":
          emit({ type: "turn_started", prompt: call.prompt });
          return { turnId: "turn-1" };
        case "interrupt":
          counts.interrupted += 1;
          return null;
        case "respondToPermission":
          permissions.delete(call.requestId);
          answers.push([call.requestId, call.response]);
          emit({ type: "permission_resolved", permissionId: call.requestId });
          return null;
        default:
          throw new Error(`Unexpected ${call.method}`);
      }
    },
    snapshot: () => ({ pendingPermissions: [...permissions.values()] }),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async close() {
      counts.closed += 1;
    },
  };
  return {
    port,
    emit,
    answers,
    counts,
    requestPermission(permissionId: string) {
      const request = { permissionId, tool: "Bash", command: "npm test" };
      permissions.set(permissionId, request);
      emit({ type: "permission_requested", permissionId });
    },
  };
}

function scratchDirectory(): string {
  const dir = mkdtempSync(join(tmpdir(), "session-host-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function hostWith(
  session: ReturnType<typeof controllableSession>,
  input: {
    limits?: Partial<SessionHostLimits>;
    audit?: (record: SessionHostAuditRecord) => void;
    socketPath?: string;
    token?: string | (() => Promise<string>);
    openSession?: () => Promise<HostedSessionPort>;
  } = {},
) {
  const socketPath = input.socketPath ?? join(scratchDirectory(), "host.sock");
  const host: SessionHost = await startSessionHost({
    socketPath,
    token: input.token ?? token,
    mcpToken: "test-mcp-token",
    openSession: input.openSession ?? (async () => session.port),
    limits: input.limits,
    audit: input.audit,
  });
  cleanups.push(() => host.close());
  return { socketPath, host };
}

async function worker(socketPath: string, workerToken = token): Promise<SessionHostClient> {
  const client = await connectSessionHost({ socketPath, token: workerToken });
  cleanups.push(() => client.close());
  return client;
}

function record(session: HostedSession): { events: JsonValue[]; seqs: number[] } {
  const seen = { events: [] as JsonValue[], seqs: [] as number[] };
  session.subscribe((event, seq) => {
    seen.events.push(event);
    seen.seqs.push(seq);
  });
  return seen;
}

/** Speaks the wire protocol directly, for peers the real client would never imitate. */
async function rawPeer(socketPath: string) {
  const socket = net.createConnection(socketPath);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const frames: Record<string, unknown>[] = [];
  let buffered = "";
  socket.on("data", (chunk: Buffer) => {
    buffered += chunk.toString("utf8");
    let newline = buffered.indexOf("\n");
    while (newline !== -1) {
      frames.push(JSON.parse(buffered.slice(0, newline)) as Record<string, unknown>);
      buffered = buffered.slice(newline + 1);
      newline = buffered.indexOf("\n");
    }
  });
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  socket.on("error", () => {});
  cleanups.push(() => {
    socket.destroy();
  });
  return {
    socket,
    frames,
    closed,
    send: (frame: unknown) => socket.write(`${JSON.stringify(frame)}\n`),
    hello: (helloToken = token) =>
      socket.write(
        `${JSON.stringify({
          type: "hello",
          protocolVersion: SESSION_HOST_PROTOCOL_VERSION,
          token: helloToken,
          client: { pid: process.pid },
        })}\n`,
      ),
  };
}

test("a running turn survives its worker; the next worker replays what it missed and finishes it", async () => {
  const provider = controllableSession();
  const { socketPath } = await hostWith(provider);
  expect(statSync(socketPath).mode & 0o777).toBe(0o600);

  const first = await worker(socketPath);
  const hostedByFirst = await first.open({ sessionId: "agent-1", provider: "fake", config: {} });
  const firstSeen = record(hostedByFirst);
  expect(await hostedByFirst.call({ method: "startTurn", prompt: "long task" })).toEqual({
    turnId: "turn-1",
  });
  provider.emit({ type: "text", text: "part 1" });
  await expect.poll(() => firstSeen.seqs).toEqual([1, 2]);
  hostedByFirst.acknowledge(2);
  provider.requestPermission("perm-1");
  await expect.poll(() => firstSeen.seqs).toEqual([1, 2, 3]);

  // The worker dies without detaching; event 3 reached it but was never durably applied.
  first.close();
  provider.emit({ type: "text", text: "part 2 while no worker is attached" });

  const second = await worker(socketPath);
  const hostedBySecond = await second.attach({ sessionId: "agent-1", afterSeq: 2 });
  expect(hostedBySecond.attach.snapshot).toEqual({
    pendingPermissions: [{ permissionId: "perm-1", tool: "Bash", command: "npm test" }],
  });
  const secondSeen = record(hostedBySecond);
  expect(secondSeen.seqs).toEqual([3, 4]);
  expect(secondSeen.events[1]).toEqual({
    type: "text",
    text: "part 2 while no worker is attached",
  });

  await hostedBySecond.call({
    method: "respondToPermission",
    requestId: "perm-1",
    response: { behavior: "allow" },
  });
  provider.emit({ type: "turn_completed", turnId: "turn-1" });
  await expect.poll(() => secondSeen.seqs).toEqual([3, 4, 5, 6]);
  expect(provider.answers).toEqual([["perm-1", { behavior: "allow" }]]);
  expect(provider.counts).toEqual({ interrupted: 0, closed: 0 });
});

test("a newer attachment fences the previous worker so two workers never drive one turn", async () => {
  const provider = controllableSession();
  const { socketPath } = await hostWith(provider);
  const stale = await worker(socketPath);
  const staleSession = await stale.open({ sessionId: "agent-1", provider: "fake", config: {} });
  const detachReasons: string[] = [];
  staleSession.onDetached((reason) => detachReasons.push(reason));
  const current = await worker(socketPath);
  const currentSession = await current.attach({ sessionId: "agent-1", afterSeq: 0 });
  const currentSeen = record(currentSession);
  await expect.poll(() => detachReasons).toEqual(["fenced"]);
  await expect(
    staleSession.call({ method: "startTurn", prompt: "duplicate" }),
  ).rejects.toMatchObject({
    code: "not_attached",
  });
  expect(provider.counts.interrupted).toBe(0);

  // The stale worker cannot acknowledge events the current worker still needs for replay.
  provider.emit({ type: "text", text: "one" });
  provider.emit({ type: "text", text: "two" });
  await expect.poll(() => currentSeen.seqs).toEqual([1, 2]);
  staleSession.acknowledge(2);
  current.close();
  const next = await worker(socketPath);
  expect(record(await next.attach({ sessionId: "agent-1", afterSeq: 0 })).seqs).toEqual([1, 2]);
});

test("reattach falls back when unacknowledged events were dropped past the retention bound", async () => {
  const provider = controllableSession();
  const { socketPath } = await hostWith(provider, { limits: { maxRetainedEvents: 2 } });
  const first = await worker(socketPath);
  record(await first.open({ sessionId: "agent-1", provider: "fake", config: {} }));
  first.close();
  for (const text of ["a", "b", "c"]) provider.emit({ type: "text", text });
  const second = await worker(socketPath);
  await expect(second.attach({ sessionId: "agent-1", afterSeq: 0 })).rejects.toMatchObject({
    code: "replay_unavailable",
  });
  const caughtUp = await second.attach({ sessionId: "agent-1", afterSeq: 1 });
  expect(record(caughtUp).seqs).toEqual([2, 3]);
});

test("reattach below the acknowledged seq falls back instead of silently skipping events", async () => {
  const provider = controllableSession();
  const { socketPath } = await hostWith(provider);
  const first = await worker(socketPath);
  const session = await first.open({ sessionId: "agent-1", provider: "fake", config: {} });
  const seen = record(session);
  for (const text of ["a", "b", "c"]) provider.emit({ type: "text", text });
  await expect.poll(() => seen.seqs).toEqual([1, 2, 3]);
  session.acknowledge(3);
  first.close();
  const second = await worker(socketPath);
  await expect(second.attach({ sessionId: "agent-1", afterSeq: 1 })).rejects.toMatchObject({
    code: "replay_unavailable",
  });
  await expect(second.attach({ sessionId: "agent-1", afterSeq: 9 })).rejects.toMatchObject({
    code: "replay_unavailable",
  });
  expect(record(await second.attach({ sessionId: "agent-1", afterSeq: 3 })).seqs).toEqual([]);
});

test("the host rejects a wrong token, a wrong version and unknown sessions", async () => {
  const { socketPath } = await hostWith(controllableSession());
  await expect(connectSessionHost({ socketPath, token: "wrong" })).rejects.toMatchObject({
    code: "unauthorized",
  });
  const futureWorker = await rawPeer(socketPath);
  futureWorker.send({ type: "hello", protocolVersion: 99, token, client: { pid: 1 }, extra: true });
  await futureWorker.closed;
  expect(futureWorker.frames).toEqual([
    expect.objectContaining({ type: "error", requestId: null, code: "version" }),
  ]);
  const client = await worker(socketPath);
  await expect(client.attach({ sessionId: "missing", afterSeq: 0 })).rejects.toMatchObject({
    code: "not_found",
  });
});

test("unauthenticated peers get one small frame and a short deadline", async () => {
  const { socketPath } = await hostWith(controllableSession(), { limits: { helloTimeoutMs: 100 } });

  const flooding = await rawPeer(socketPath);
  flooding.socket.write("x".repeat(8 * 1024));
  await flooding.closed;
  expect(flooding.frames).toEqual([
    expect.objectContaining({ type: "error", code: "invalid_frame" }),
  ]);

  const silent = await rawPeer(socketPath);
  await silent.closed;
  expect(silent.frames).toEqual([]);

  const skipping = await rawPeer(socketPath);
  skipping.send({ type: "attach", requestId: "r1", sessionId: "agent-1", afterSeq: 0 });
  await skipping.closed;
  expect(skipping.frames).toEqual([
    expect.objectContaining({ type: "error", code: "unauthorized" }),
  ]);
});

test("a malformed or oversized frame after hello ends only that connection", async () => {
  const provider = controllableSession();
  const { socketPath } = await hostWith(provider, { limits: { maxFrameBytes: 16 * 1024 } });
  const healthy = await worker(socketPath);
  const session = await healthy.open({ sessionId: "agent-1", provider: "fake", config: {} });
  const seen = record(session);

  const malformed = await rawPeer(socketPath);
  malformed.hello();
  malformed.send({ type: "call", requestId: "r1", sessionId: "agent-1", call: { method: "eval" } });
  await malformed.closed;
  expect(malformed.frames.at(-1)).toMatchObject({ type: "error", code: "invalid_frame" });

  const oversized = await rawPeer(socketPath);
  oversized.hello();
  oversized.socket.write("y".repeat(32 * 1024));
  await oversized.closed;
  expect(oversized.frames.at(-1)).toMatchObject({ type: "error", code: "invalid_frame" });

  provider.emit({ type: "text", text: "still running" });
  await expect.poll(() => seen.seqs).toEqual([1]);
});

test("an event too large for one frame is replaced by a marker so seqs stay contiguous", async () => {
  const provider = controllableSession();
  const { socketPath } = await hostWith(provider, { limits: { maxFrameBytes: 16 * 1024 } });
  const client = await worker(socketPath);
  const seen = record(await client.open({ sessionId: "agent-1", provider: "fake", config: {} }));
  provider.emit({ type: "text", text: "z".repeat(32 * 1024) });
  provider.emit({ type: "text", text: "after" });
  await expect.poll(() => seen.seqs).toEqual([1, 2]);
  expect(seen.events[0]).toMatchObject({
    type: "session_host_event_dropped",
    reason: "oversized",
  });
  expect(seen.events[1]).toEqual({ type: "text", text: "after" });
});

test("a worker that stops reading is dropped; the session keeps running for the next worker", async () => {
  const provider = controllableSession();
  const audit: SessionHostAuditRecord[] = [];
  const { socketPath } = await hostWith(provider, {
    limits: { maxBufferedBytes: 256 * 1024, maxFrameBytes: 64 * 1024 },
    audit: (entry) => audit.push(entry),
  });
  const hung = await rawPeer(socketPath);
  hung.hello();
  await expect.poll(() => hung.frames.length).toBe(1);
  hung.send({ type: "open", requestId: "r1", sessionId: "agent-1", provider: "fake", config: {} });
  await expect.poll(() => hung.frames.length).toBe(2);
  // A paused socket stops reading, like a worker hung in shutdown. It never sees the close
  // either, so watch the host's side of the connection instead.
  hung.socket.pause();
  const hostDropped = () => audit.some((entry) => entry.event === "disconnected");
  let emitted = 0;
  for (; emitted < 400 && !hostDropped(); emitted += 1) {
    provider.emit({ type: "text", text: `${emitted}:${"w".repeat(8 * 1024)}` });
    await new Promise((resolve) => setImmediate(resolve));
  }
  expect(audit).toContainEqual(expect.objectContaining({ event: "backpressure" }));
  expect(audit).toContainEqual(expect.objectContaining({ event: "disconnected", released: 1 }));
  hung.socket.destroy();

  const next = await worker(socketPath);
  const caughtUp = record(await next.attach({ sessionId: "agent-1", afterSeq: 0 }));
  const everySeq = Array.from({ length: emitted }, (_, index) => index + 1);
  await expect.poll(() => caughtUp.seqs).toEqual(everySeq);
});

test("concurrent opens of one session start one provider session", async () => {
  const provider = controllableSession();
  let opened = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { socketPath } = await hostWith(provider, {
    openSession: async () => {
      opened += 1;
      await gate;
      return provider.port;
    },
  });
  const left = await worker(socketPath);
  const right = await worker(socketPath);
  const first = left.open({ sessionId: "agent-1", provider: "fake", config: {} });
  const second = right.open({ sessionId: "agent-1", provider: "fake", config: {} });
  await expect(second).rejects.toMatchObject({ code: "conflict" });
  release();
  await first;
  expect(opened).toBe(1);
});

test("a second host refuses a live socket and replaces one left by a crashed host", async () => {
  const provider = controllableSession();
  const { socketPath } = await hostWith(provider);
  await expect(claimSocketPath(socketPath)).rejects.toBeInstanceOf(SessionHostAlreadyRunningError);
  await expect(
    startSessionHost({
      socketPath,
      token,
      mcpToken: "test-mcp-token",
      openSession: async () => provider.port,
    }),
  ).rejects.toBeInstanceOf(SessionHostAlreadyRunningError);
  await worker(socketPath);

  // A host killed without cleanup leaves its socket file behind with nobody listening.
  const crashedPath = join(scratchDirectory(), "host.sock");
  const crashed = spawn(
    process.execPath,
    [
      "-e",
      "require('node:net').createServer().listen(process.argv[1], () => process.stdout.write('ready'))",
      crashedPath,
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  await new Promise<void>((resolve) => crashed.stdout.once("data", () => resolve()));
  const exited = new Promise((resolve) => crashed.once("exit", resolve));
  crashed.kill("SIGKILL");
  await exited;
  expect(statSync(crashedPath).isSocket()).toBe(true);
  await hostWith(provider, { socketPath: crashedPath });
  await worker(crashedPath);

  const notSocket = join(scratchDirectory(), "plain-directory");
  mkdirSync(notSocket);
  await expect(claimSocketPath(notSocket)).rejects.toThrow("not a socket");
  await expect(claimSocketPath(`/tmp/${"x".repeat(120)}.sock`)).rejects.toThrow("too long");
});

test("a failed close keeps the session hosted so it can be retried", async () => {
  const provider = controllableSession();
  let failures = 1;
  const port: HostedSessionPort = {
    ...provider.port,
    async close() {
      if (failures-- > 0) throw new Error("provider still exiting");
      await provider.port.close();
    },
  };
  const { socketPath } = await hostWith(provider, { openSession: async () => port });
  const client = await worker(socketPath);
  const session = await client.open({ sessionId: "agent-1", provider: "fake", config: {} });
  await expect(session.call({ method: "close" })).rejects.toThrow("provider still exiting");
  const again = await worker(socketPath);
  const reattached = await again.attach({ sessionId: "agent-1", afterSeq: 0 });
  await reattached.call({ method: "close" });
  expect(provider.counts.closed).toBe(1);
  await expect(again.attach({ sessionId: "agent-1", afterSeq: 0 })).rejects.toMatchObject({
    code: "not_found",
  });
});

test("a provider result that breaks the call contract is refused", async () => {
  const provider = controllableSession();
  const port: HostedSessionPort = {
    ...provider.port,
    call: async () => ({ turnId: 42 }),
  };
  const { socketPath } = await hostWith(provider, { openSession: async () => port });
  const client = await worker(socketPath);
  const session = await client.open({ sessionId: "agent-1", provider: "fake", config: {} });
  await expect(session.call({ method: "startTurn", prompt: "go" })).rejects.toMatchObject({
    code: "failed",
  });
});

test("the host directory and token are private, and every host start rotates the token", async () => {
  const home = scratchDirectory();
  const paths = sessionHostPaths(home);
  mkdirSync(paths.directory, { mode: 0o755 });
  chmodSync(paths.directory, 0o755);

  const firstToken = await rotateSessionHostToken(paths);
  expect(statSync(paths.directory).mode & 0o777).toBe(0o700);
  expect(statSync(paths.tokenPath).mode & 0o777).toBe(0o600);
  expect(await readSessionHostToken(paths)).toBe(firstToken);

  const provider = controllableSession();
  const firstHost = await hostWith(provider, { socketPath: paths.socketPath, token: firstToken });
  await worker(paths.socketPath, await readSessionHostToken(paths));
  await firstHost.host.close();

  const secondToken = await rotateSessionHostToken(paths);
  expect(secondToken).not.toBe(firstToken);
  await hostWith(provider, { socketPath: paths.socketPath, token: secondToken });
  await expect(
    connectSessionHost({ socketPath: paths.socketPath, token: firstToken }),
  ).rejects.toMatchObject({ code: "unauthorized" });
  await worker(paths.socketPath, await readSessionHostToken(paths));

  chmodSync(paths.tokenPath, 0o644);
  await expect(readSessionHostToken(paths)).rejects.toThrow("not private");

  const elsewhere = scratchDirectory();
  const linked = join(scratchDirectory(), "linked");
  symlinkSync(elsewhere, linked);
  await expect(preparePrivateDirectory(linked)).rejects.toThrow("not a real directory");
});

test("the audit log records attach, fencing and rejections without secrets", async () => {
  const home = scratchDirectory();
  const paths = sessionHostPaths(home);
  const hostToken = await rotateSessionHostToken(paths);
  const audit = createSessionHostAuditLog({ path: paths.auditLogPath });
  const provider = controllableSession();
  await hostWith(provider, { socketPath: paths.socketPath, token: hostToken, audit });

  await expect(
    connectSessionHost({ socketPath: paths.socketPath, token: "guessed-token" }),
  ).rejects.toMatchObject({ code: "unauthorized" });
  const first = await worker(paths.socketPath, hostToken);
  await first.open({
    sessionId: "agent-1",
    provider: "fake",
    config: { env: { ANTHROPIC_API_KEY: "sk-secret-value" } },
  });
  const second = await worker(paths.socketPath, hostToken);
  await second.attach({ sessionId: "agent-1", afterSeq: 0 });
  first.close();

  await expect
    .poll(() => readFileSync(paths.auditLogPath, "utf8"))
    .toContain('"event":"disconnected"');
  const text = readFileSync(paths.auditLogPath, "utf8");
  const events = text
    .trim()
    .split("\n")
    .map((line) => (JSON.parse(line) as { event: string }).event);
  expect(events).toEqual(
    expect.arrayContaining([
      "host_started",
      "hello_rejected",
      "hello_accepted",
      "open",
      "attach",
      "fenced",
      "disconnected",
    ]),
  );
  expect(text).not.toContain(hostToken);
  expect(text).not.toContain("guessed-token");
  expect(text).not.toContain("sk-secret-value");
  expect(statSync(paths.auditLogPath).mode & 0o777).toBe(0o600);
});

test("the audit log rotates at its size bound", () => {
  const dir = scratchDirectory();
  const auditPath = join(dir, "audit.log");
  const audit = createSessionHostAuditLog({ path: auditPath, maxBytes: 400 });
  for (let index = 0; index < 20; index += 1) audit({ event: "attach", sessionId: `s-${index}` });
  expect(statSync(auditPath).size).toBeLessThanOrEqual(400);
  expect(statSync(`${auditPath}.1`).size).toBeGreaterThan(0);
});

test("a session that skips a seq detaches alone; the connection's other sessions keep going", async () => {
  // A deliberately broken host, since the real one never skips.
  const socketPath = join(scratchDirectory(), "broken.sock");
  const broken = net.createServer((socket) => {
    let buffered = "";
    socket.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      let newline = buffered.indexOf("\n");
      while (newline !== -1) {
        const frame = JSON.parse(buffered.slice(0, newline)) as Record<string, unknown>;
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf("\n");
        const write = (reply: unknown) => socket.write(`${JSON.stringify(reply)}\n`);
        if (frame.type === "hello")
          write({
            type: "hello",
            protocolVersion: SESSION_HOST_PROTOCOL_VERSION,
            host: { id: "broken-host", pid: process.pid, startedAt: new Date().toISOString() },
            mcpToken: "broken-host-mcp-token",
          });
        if (frame.type === "attach") {
          const sessionId = frame.sessionId as string;
          write({
            type: "result",
            requestId: frame.requestId,
            value: { provider: "fake", lastSeq: 0, snapshot: null },
          });
          const seqs = sessionId === "skipping" ? [1, 3] : [1, 2];
          for (const seq of seqs) write({ type: "event", sessionId, seq, event: { seq } });
        }
      }
    });
  });
  await new Promise<void>((resolve) => broken.listen(socketPath, resolve));
  cleanups.push(() => new Promise<void>((resolve) => broken.close(() => resolve())));

  const client = await connectSessionHost({ socketPath, token });
  cleanups.push(() => client.close());
  const skipping = await client.attach({ sessionId: "skipping", afterSeq: 0 });
  const reasons: string[] = [];
  skipping.onDetached((reason) => reasons.push(reason));
  const skippingSeen = record(skipping);
  const healthy = await client.attach({ sessionId: "healthy", afterSeq: 0 });
  const healthySeen = record(healthy);
  await expect.poll(() => healthySeen.seqs).toEqual([1, 2]);
  expect(reasons).toEqual(["gap"]);
  expect(skippingSeen.seqs).toEqual([1]);
  expect(skipping.lastSeq()).toBe(1);
});

test("the current worker cannot acknowledge events that do not exist yet", async () => {
  const provider = controllableSession();
  const audit: SessionHostAuditRecord[] = [];
  const { socketPath } = await hostWith(provider, { audit: (entry) => audit.push(entry) });
  const first = await worker(socketPath);
  const session = await first.open({ sessionId: "agent-1", provider: "fake", config: {} });
  const seen = record(session);
  provider.emit({ type: "text", text: "one" });
  await expect.poll(() => seen.seqs).toEqual([1]);
  session.acknowledge(6);
  await expect.poll(() => audit.map((entry) => entry.event)).toContain("ack_refused");
  first.close();
  const second = await worker(socketPath);
  expect(record(await second.attach({ sessionId: "agent-1", afterSeq: 0 })).seqs).toEqual([1]);
});

test("connections past the cap, and peers that keep getting refused, are dropped", async () => {
  const provider = controllableSession();
  const audit: SessionHostAuditRecord[] = [];
  const { socketPath } = await hostWith(provider, {
    limits: { maxConnections: 2, maxRefusals: 3 },
    audit: (entry) => audit.push(entry),
  });
  const current = await worker(socketPath);
  await current.open({ sessionId: "agent-1", provider: "fake", config: {} });
  const fenced = await rawPeer(socketPath);
  fenced.hello();
  await expect.poll(() => fenced.frames.length).toBe(1);

  const extra = await rawPeer(socketPath);
  await extra.closed;
  expect(extra.frames).toEqual([]);
  expect(audit).toContainEqual(expect.objectContaining({ event: "connection_refused" }));

  for (let index = 0; index < 5; index += 1)
    fenced.send({ type: "ack", sessionId: "agent-1", seq: 0 });
  await fenced.closed;
  expect(audit).toContainEqual(expect.objectContaining({ event: "refusal_limit", refusals: 4 }));
});

test("past the host-wide retention bound the oldest events go first", async () => {
  const older = controllableSession();
  const newer = controllableSession();
  const ports = [older.port, newer.port];
  const event = (text: string) => ({ type: "text", text: `${text}${"r".repeat(1_000)}` });
  const { socketPath } = await hostWith(older, {
    limits: { maxTotalRetainedBytes: 5_000 },
    openSession: async () => ports.shift()!,
  });
  const opener = await worker(socketPath);
  await opener.open({ sessionId: "older", provider: "fake", config: {} });
  await opener.open({ sessionId: "newer", provider: "fake", config: {} });
  opener.close();
  for (const text of ["a", "b", "c"]) older.emit(event(text));
  for (const text of ["d", "e"]) newer.emit(event(text));
  const next = await worker(socketPath);
  await expect(next.attach({ sessionId: "older", afterSeq: 0 })).rejects.toMatchObject({
    code: "replay_unavailable",
  });
  expect(record(await next.attach({ sessionId: "newer", afterSeq: 0 })).seqs).toEqual([1, 2]);
});

test("a stale lock from an exited host is taken over; a live one is refused", async () => {
  const provider = controllableSession();
  const socketPath = join(scratchDirectory(), "host.sock");
  const exited = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const deadPid = exited.pid!;
  await new Promise((resolve) => exited.once("exit", resolve));
  writeFileSync(`${socketPath}.lock`, `${deadPid}\n`, { mode: 0o600 });
  const { host } = await hostWith(provider, { socketPath });
  expect(readFileSync(`${socketPath}.lock`, "utf8").trim()).toBe(String(process.pid));
  await expect(
    startSessionHost({
      socketPath,
      token,
      mcpToken: "test-mcp-token",
      openSession: async () => provider.port,
    }),
  ).rejects.toBeInstanceOf(SessionHostAlreadyRunningError);
  await host.close();
  expect(existsSync(`${socketPath}.lock`)).toBe(false);
});

test("host shutdown is bounded when a provider session cannot close", async () => {
  const provider = controllableSession();
  const audit: SessionHostAuditRecord[] = [];
  const stuck: HostedSessionPort = { ...provider.port, close: () => new Promise(() => {}) };
  const { socketPath, host } = await hostWith(provider, {
    limits: { closeTimeoutMs: 50 },
    openSession: async () => stuck,
    audit: (entry) => audit.push(entry),
  });
  const client = await worker(socketPath);
  await client.open({ sessionId: "agent-1", provider: "fake", config: {} });
  await host.close();
  expect(audit).toContainEqual(expect.objectContaining({ event: "close_timeout" }));
  expect(audit.at(-1)).toMatchObject({ event: "host_stopped" });
});

test("connecting when no host is listening reports the host as unavailable", async () => {
  const socketPath = join(scratchDirectory(), "absent.sock");
  await expect(connectSessionHost({ socketPath, token })).rejects.toMatchObject({
    code: "unavailable",
  });
});

test("the audit log tightens files left with wider permissions", () => {
  const dir = scratchDirectory();
  const auditPath = join(dir, "audit.log");
  writeFileSync(auditPath, "", { mode: 0o644 });
  writeFileSync(`${auditPath}.1`, "", { mode: 0o644 });
  chmodSync(auditPath, 0o644);
  chmodSync(`${auditPath}.1`, 0o644);
  createSessionHostAuditLog({ path: auditPath });
  expect(statSync(auditPath).mode & 0o777).toBe(0o600);
  expect(statSync(`${auditPath}.1`).mode & 0o777).toBe(0o600);
});

test("acknowledged events stay retained, and history pages them to the attachment only", async () => {
  const provider = controllableSession();
  const { socketPath } = await hostWith(provider);
  const first = await worker(socketPath);
  const session = await first.open({ sessionId: "agent-1", provider: "fake", config: {} });
  const seen = record(session);
  const big = "h".repeat(3 * 1024 * 1024);
  for (const text of ["a", big, big, "d"]) provider.emit({ type: "text", text });
  await expect.poll(() => seen.seqs).toEqual([1, 2, 3, 4]);
  session.acknowledge(4);

  const outsider = await worker(socketPath);
  await expect(
    (await outsider.attach({ sessionId: "agent-1", afterSeq: null })).history({
      afterSeq: 0,
      throughSeq: 4,
    }),
  ).resolves.toMatchObject({ truncatedThrough: 0 });
  // The outsider took the attachment; the fenced first worker may no longer read history.
  await expect(session.history({ afterSeq: 0, throughSeq: 4 })).rejects.toMatchObject({
    code: "not_attached",
  });

  const next = await worker(socketPath);
  const current = await next.attach({ sessionId: "agent-1", afterSeq: 4 });
  const pages = [];
  let afterSeq = 0;
  for (;;) {
    const page = await current.history({ afterSeq, throughSeq: 3 });
    pages.push(page.events.map((entry) => entry.seq));
    if (!page.more) break;
    afterSeq = page.nextAfterSeq;
  }
  expect(pages.flat()).toEqual([1, 2, 3]);
  expect(pages.length).toBeGreaterThan(1);
});

test("hello carries the host tool token and list reports every hosted session", async () => {
  const provider = controllableSession();
  const { socketPath } = await hostWith(provider);
  const client = await worker(socketPath);
  expect(client.mcpToken).toBe("test-mcp-token");
  await client.open({ sessionId: "agent-1", provider: "fake", config: {} });
  provider.requestPermission("perm-1");
  await expect.poll(async () => (await client.list())[0]?.lastSeq).toBe(1);
  expect(await client.list()).toEqual([
    {
      sessionId: "agent-1",
      provider: "fake",
      lastSeq: 1,
      attached: true,
      snapshot: {
        pendingPermissions: [{ permissionId: "perm-1", tool: "Bash", command: "npm test" }],
      },
    },
  ]);
});

test("the session list leaves out snapshots that would not fit one frame", async () => {
  const provider = controllableSession();
  const bulky: HostedSessionPort = {
    ...provider.port,
    snapshot: () => ({ blob: "x".repeat(40_000) }),
  };
  const { socketPath } = await hostWith(provider, {
    limits: { maxFrameBytes: 128 * 1024 },
    openSession: async () => bulky,
  });
  const client = await worker(socketPath);
  await client.open({ sessionId: "agent-1", provider: "fake", config: {} });
  await client.open({ sessionId: "agent-2", provider: "fake", config: {} });
  const sessions = await client.list();
  expect(sessions.map((session) => session.snapshot === null)).toEqual([false, true]);
});

test("the private mask covers only the socket bind, so providers keep the usual mask", async () => {
  const previous = process.umask(0o022);
  try {
    const hosts = await Promise.all([
      hostWith(controllableSession()),
      hostWith(controllableSession()),
    ]);
    // Concurrent binds must not leave the private mask behind for the providers they start.
    expect(process.umask(0o022)).toBe(0o022);
    for (const { socketPath } of hosts) expect(statSync(socketPath).mode & 0o777).toBe(0o600);
  } finally {
    process.umask(previous);
  }
});

test("a version refusal records the peer's protocol version", async () => {
  const records: SessionHostAuditRecord[] = [];
  const { socketPath } = await hostWith(controllableSession(), {
    audit: (entry) => records.push(entry),
  });
  const futureWorker = await rawPeer(socketPath);
  futureWorker.send({ type: "hello", protocolVersion: 99, token, client: { pid: 1 } });
  await futureWorker.closed;
  expect(records).toContainEqual(
    expect.objectContaining({ event: "hello_rejected", reason: "version", protocolVersion: 99 }),
  );
});

test("a host that loses the race to start never produces its token", async () => {
  const { socketPath } = await hostWith(controllableSession(), { token: async () => token });
  let produced = false;
  await expect(
    startSessionHost({
      socketPath,
      token: async () => {
        produced = true;
        return "replacement-token";
      },
      mcpToken: "test-mcp-token",
      openSession: async () => controllableSession().port,
    }),
  ).rejects.toBeInstanceOf(SessionHostAlreadyRunningError);
  expect(produced).toBe(false);
  // The running host still answers with the token it resolved at start.
  const client = await worker(socketPath);
  expect(client.closed).toBe(false);
});

test("the watchdog's self-probe is answered but left out of the audit log", async () => {
  const records: SessionHostAuditRecord[] = [];
  const { socketPath } = await hostWith(controllableSession(), {
    audit: (entry) => records.push(entry),
  });
  const probe = await rawPeer(socketPath);
  probe.send({
    type: "hello",
    protocolVersion: SESSION_HOST_PROTOCOL_VERSION,
    token,
    client: { pid: process.pid, release: SELF_PROBE_RELEASE },
  });
  await expect.poll(() => probe.frames.length).toBe(1);
  expect(probe.frames[0]).toMatchObject({ type: "hello" });
  probe.socket.destroy();
  await probe.closed;

  // A real worker in the same process is still audited, as before.
  const client = await worker(socketPath);
  client.close();
  await expect.poll(() => records.some((entry) => entry.event === "disconnected")).toBe(true);
  expect(records.filter((entry) => entry.event === "hello_accepted")).toHaveLength(1);
  expect(records.filter((entry) => entry.event === "disconnected")).toHaveLength(1);
});

test("a rotating appender keeps one predecessor at its size bound", () => {
  const logPath = join(scratchDirectory(), "host.log");
  const append = createRotatingAppender({ path: logPath, maxBytes: 100 });
  for (let index = 0; index < 20; index += 1) append(`line ${index} of the host log\n`);
  expect(statSync(logPath).size).toBeLessThanOrEqual(100);
  expect(readFileSync(`${logPath}.1`, "utf8")).toContain("line");
  expect(statSync(logPath).mode & 0o777).toBe(0o600);
});

test("the host lock reads as gone only when it is absent or its holder has exited", async () => {
  const socketPath = join(scratchDirectory(), "host.sock");
  const lockPath = `${socketPath}.lock`;
  expect(await readSessionHostLock(socketPath)).toEqual({ state: "gone", pid: null });
  writeFileSync(lockPath, `${process.pid}\n`);
  expect(await readSessionHostLock(socketPath)).toEqual({ state: "alive", pid: process.pid });
  const exited = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise((resolve) => exited.once("exit", resolve));
  writeFileSync(lockPath, `${exited.pid}\n`);
  expect(await readSessionHostLock(socketPath)).toEqual({ state: "gone", pid: exited.pid });
  // A lock being written, or one this process cannot read, proves nothing: wait, never act.
  writeFileSync(lockPath, "");
  expect(await readSessionHostLock(socketPath)).toEqual({ state: "alive", pid: null });
  if (process.getuid?.() !== 0) {
    writeFileSync(lockPath, `${process.pid}\n`);
    chmodSync(lockPath, 0o000);
    expect(await readSessionHostLock(socketPath)).toEqual({ state: "alive", pid: null });
    chmodSync(lockPath, 0o600);
  }
});
