import { ChildProcess } from "node:child_process";
import { PassThrough, Writable } from "node:stream";
import { expect, test, vi } from "vitest";
import { createRetainedNativeChild, type NativeGatedChildSpawn } from "./native-gated-child.js";

function fixture() {
  // Only inert Node event emitters and streams. These tests never spawn an OS child.
  const child = new ChildProcess(),
    stdout = new PassThrough(),
    stderr = new PassThrough();
  const writes: Buffer[] = [];
  let hold = false;
  const gate = new Writable({
    write(bytes, _encoding, done) {
      writes.push(Buffer.from(bytes));
      if (!hold) done();
    },
  });
  Object.defineProperties(child, {
    pid: { value: 12345 },
    stdout: { value: stdout },
    stderr: { value: stderr },
    stdio: { value: [null, stdout, stderr, gate] },
  });
  const input = {
    file: "/protected/node",
    argv: ["/protected/child.js"],
    env: { PATH: "/usr/bin:/bin" },
    cwd: "/protected",
  };
  const spawn = vi.fn<NativeGatedChildSpawn>(() => child);
  const retained = createRetainedNativeChild(input, spawn);
  return {
    child,
    stdout,
    stderr,
    gate,
    writes,
    input,
    spawn,
    retained,
    hold() {
      hold = true;
    },
  };
}

test("native gated child separates synchronous birth attempt from confirmation and byte release", async () => {
  const f = fixture();
  f.spawn.mockImplementation(() => {
    expect(f.retained.snapshot().launchAttempted).toBe(true);
    return f.child;
  });
  expect(f.retained.attemptSpawn()).toBeUndefined();
  expect(f.spawn).toHaveBeenCalledExactlyOnceWith("/protected/node", ["/protected/child.js"], {
    stdio: ["ignore", "pipe", "pipe", "pipe"],
    env: { PATH: "/usr/bin:/bin" },
    cwd: "/protected",
  });
  expect(f.retained.snapshot().spawnObserved).toBe(false);
  expect(f.child.listenerCount("error")).toBe(1);
  expect(f.child.listenerCount("exit")).toBe(1);
  expect(f.child.listenerCount("close")).toBe(1);
  expect(f.gate.listenerCount("error")).toBe(1);
  f.child.emit("spawn");
  expect(await f.retained.waitForSpawn()).toEqual({ pid: 12345 });
  f.retained.queueRelease();
  expect(f.writes).toEqual([Buffer.from([1])]);
  expect(f.gate.writableEnded).toBe(true);
  expect(() => f.retained.queueRelease()).toThrow("already attempted");
  expect(() => f.retained.attemptSpawn()).toThrow("already attempted");
  expect(f.retained.snapshot().delivery).toBe("unknown");
  expect(f.retained.snapshot()).not.toHaveProperty("settled");
});

test("native gated child captures launch data without inheriting later caller mutations", async () => {
  const f = fixture();
  f.input.file = "/foreign/node";
  f.input.argv[0] = "/foreign/child.js";
  f.input.env.PATH = "/foreign";
  f.input.cwd = "/foreign";
  f.retained.attemptSpawn();
  expect(f.spawn).toHaveBeenCalledExactlyOnceWith("/protected/node", ["/protected/child.js"], {
    stdio: ["ignore", "pipe", "pipe", "pipe"],
    env: { PATH: "/usr/bin:/bin" },
    cwd: "/protected",
  });
  f.child.emit("spawn");
  await f.retained.waitForSpawn();
});

test("native gated child synchronous spawn failure permanently consumes the local attempt", () => {
  const f = fixture();
  f.spawn.mockImplementation(() => {
    expect(f.retained.snapshot().launchAttempted).toBe(true);
    throw Error("Birth uncertain");
  });
  expect(() => f.retained.attemptSpawn()).toThrow("Birth uncertain");
  expect(() => f.retained.attemptSpawn()).toThrow("already attempted");
  expect(f.spawn).toHaveBeenCalledTimes(1);
  expect(f.retained.snapshot()).toMatchObject({
    launchAttempted: true,
    pid: null,
    delivery: "unknown",
  });
});

test.each(["error", "exit", "close"] as const)(
  "native gated child retains early %s without a waiter or relaunch",
  async (event) => {
    const f = fixture();
    f.retained.attemptSpawn();
    f.child.emit(event, Error("Unconfirmed"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    await expect(f.retained.waitForSpawn()).rejects.toThrow();
    expect(() => f.retained.attemptSpawn()).toThrow("already attempted");
    expect(f.spawn).toHaveBeenCalledTimes(1);
    expect(f.writes).toEqual([]);
  },
);

test("native gated child keeps draining both streams after bounded prefixes fill", async () => {
  const f = fixture();
  f.retained.attemptSpawn();
  f.stdout.write(Buffer.alloc(8192, 65));
  f.stdout.write("discarded");
  f.stderr.write(Buffer.alloc(9000, 66));
  f.child.emit("spawn");
  await f.retained.waitForSpawn();
  const snapshot = f.retained.snapshot();
  expect(snapshot.stdout).toBe("A".repeat(8192));
  expect(snapshot.stderr).toBe("B".repeat(8192));
  expect(snapshot.truncated).toEqual({ stdout: true, stderr: true });
  snapshot.truncated.stdout = false;
  snapshot.errors.push("foreign");
  f.stdout.write("still drained");
  f.stderr.write("still drained");
  expect(f.stdout.listenerCount("data")).toBe(1);
  expect(f.stderr.listenerCount("data")).toBe(1);
  expect(f.retained.snapshot().errors).toEqual([]);
  expect(f.retained.snapshot().truncated.stdout).toBe(true);
});

test.each(["stdout", "stderr", "gate", "finish", "gate-close", "exit", "close"] as const)(
  "native gated child %s failure blocks release without treating it as settlement",
  async (event) => {
    const f = fixture();
    f.retained.attemptSpawn();
    f.child.emit("spawn");
    await f.retained.waitForSpawn();
    if (event === "stdout") f.stdout.emit("error", Error("Stream failure"));
    else if (event === "stderr") f.stderr.emit("error", Error("Stream failure"));
    else if (event === "gate") f.gate.emit("error", Error("Gate failure"));
    else if (event === "finish") f.gate.emit("finish");
    else if (event === "gate-close") f.gate.emit("close");
    else f.child.emit(event);
    expect(() => f.retained.queueRelease()).toThrow("unavailable");
    expect(f.retained.snapshot().releaseAttempted).toBe(true);
    expect(() => f.retained.queueRelease()).toThrow("already attempted");
    expect(f.writes).toEqual([]);
    expect(f.retained.snapshot().delivery).toBe("unknown");
    expect(f.retained.snapshot()).not.toHaveProperty("settled");
  },
);

test("native gated child pending write is one queue attempt with no delivery evidence", async () => {
  const f = fixture();
  f.retained.attemptSpawn();
  f.child.emit("spawn");
  await f.retained.waitForSpawn();
  f.hold();
  expect(f.retained.queueRelease()).toBeUndefined();
  expect(f.retained.snapshot()).toMatchObject({
    releaseAttempted: true,
    queueCallback: false,
    delivery: "unknown",
  });
  expect(f.writes).toEqual([Buffer.from([1])]);
  expect(() => f.retained.queueRelease()).toThrow("already attempted");
});

test("native gated child callback and later exit retain uncertainty", async () => {
  const f = fixture();
  f.retained.attemptSpawn();
  f.child.emit("spawn");
  await f.retained.waitForSpawn();
  f.retained.queueRelease();
  await new Promise<void>((resolve) => setImmediate(resolve));
  f.gate.emit("error", Error("Late gate failure"));
  f.child.emit("exit", 0, null);
  expect(f.retained.snapshot()).toMatchObject({
    queueCallback: true,
    childExited: true,
    errors: ["gate"],
    delivery: "unknown",
  });
});
