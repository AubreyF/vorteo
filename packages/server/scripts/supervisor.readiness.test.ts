import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, vi } from "vitest";
import { createMaintenanceRestartChannel } from "../src/server/maintenance-restart-channel.js";
import { createWorkerShutdown } from "../src/server/worker-shutdown.js";

test("worker shutdown consumes the absolute budget without a second shutdown grace", async () => {
  vi.useFakeTimers();
  try {
    const stop = vi.fn(() => new Promise<void>(() => {}));
    const forceExit = vi.fn();
    const shutdown = createWorkerShutdown({ stop, forceExit, now: Date.now });
    const result = shutdown.begin(Date.now() + 1500);
    const expired = expect(result).rejects.toThrow("cleanup is incomplete");
    await vi.advanceTimersByTimeAsync(1000);
    expect(shutdown.begin(Date.now() + 60_000)).toBe(result);
    await vi.advanceTimersByTimeAsync(500);
    await expired;
    expect(stop).toHaveBeenCalledTimes(1);
    expect(forceExit).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});

test("worker shutdown permits reviewed grace beyond legacy ten seconds and can only shorten it", async () => {
  vi.useFakeTimers();
  try {
    const forceExit = vi.fn();
    const shutdown = createWorkerShutdown({
      stop: () => new Promise<void>(() => {}),
      forceExit,
      now: Date.now,
    });
    const result = shutdown.begin(Date.now() + 60_000);
    const expired = expect(result).rejects.toThrow("deadline expired");
    await vi.advanceTimersByTimeAsync(10_001);
    expect(forceExit).not.toHaveBeenCalled();
    expect(shutdown.begin(Date.now() + 100)).toBe(result);
    await vi.advanceTimersByTimeAsync(100);
    await expired;
    expect(forceExit).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});

test("successful worker cleanup clears its deadline and invalid budgets never invoke cleanup", async () => {
  vi.useFakeTimers();
  try {
    const stop = vi.fn(async () => {});
    const forceExit = vi.fn();
    const shutdown = createWorkerShutdown({ stop, forceExit, now: Date.now });
    await expect(shutdown.begin(Date.now() + 300_001)).rejects.toThrow("Invalid");
    expect(stop).not.toHaveBeenCalled();
    await expect(shutdown.begin()).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(forceExit).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

test("legacy worker shutdown keeps ten seconds and late cleanup cannot turn timeout into success", async () => {
  vi.useFakeTimers();
  try {
    let finish = () => {};
    const stopped = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const forceExit = vi.fn();
    const shutdown = createWorkerShutdown({ stop: () => stopped, forceExit, now: Date.now });
    const result = shutdown.begin();
    const expired = expect(result).rejects.toThrow("cleanup is incomplete");
    await vi.advanceTimersByTimeAsync(9999);
    expect(forceExit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expired;
    finish();
    await expect(shutdown.begin()).rejects.toThrow("cleanup is incomplete");
    expect(forceExit).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});

function restartChannelFixture() {
  const native = { parent: 20, connected: true };
  const send = vi.fn();
  const channel = createMaintenanceRestartChannel({
    workerPid: 10,
    parentPid: 20,
    currentParentPid: () => native.parent,
    connected: () => native.connected,
    send,
    now: () => Date.now(),
  });
  const intent = {
    requestId: "f55bf9cf-321c-4b74-8c8c-a1a09b38d782",
    generation: "5d698f4a-5404-47ef-a867-2c34c541b511",
    workerPid: 10,
    terminateAt: Date.now() + 10_000,
  };
  const handshake = () =>
    channel.observe({ type: "paseo:supervisor-heartbeat", maintenanceRestartProtocol: 1 });
  return { native, send, channel, intent, handshake };
}

test("maintenance channel requires the running supervisor handshake and parent", async () => {
  const f = restartChannelFixture();
  f.channel.observe({ type: "paseo:supervisor-heartbeat" });
  await expect(f.channel.request(f.intent)).rejects.toThrow("lacks maintenance restart support");
  expect(f.send).not.toHaveBeenCalled();
  f.handshake();
  expect(f.channel.supported()).toBe(true);
  f.native.parent++;
  await expect(f.channel.request(f.intent)).rejects.toThrow("lacks maintenance restart support");
  f.native.parent--;
  f.native.connected = false;
  expect(f.channel.supported()).toBe(false);
  expect(f.send).not.toHaveBeenCalled();
});

test("maintenance acceptance binds the complete intent and refuses replay", async () => {
  const f = restartChannelFixture();
  f.handshake();
  const result = f.channel.request(f.intent);
  f.channel.observe({
    ...f.intent,
    type: "paseo:maintenance-restart-accepted",
    generation: "b8342f1f-5cca-41c3-bde1-595672157276",
    accepted: true,
  });
  f.channel.observe({ ...f.intent, type: "paseo:maintenance-restart-accepted", accepted: true });
  await expect(result).resolves.toEqual({ ...f.intent, accepted: true });
  await expect(f.channel.request(f.intent)).rejects.toThrow("observe without replay");
  expect(f.send).toHaveBeenCalledTimes(1);
});

test("an exact refusal permits a different tracked generation without resending the old one", async () => {
  const f = restartChannelFixture();
  f.handshake();
  const result = f.channel.request(f.intent);
  const refused = expect(result).rejects.toThrow("Supervisor refused");
  f.channel.observe({ ...f.intent, type: "paseo:maintenance-restart-accepted", accepted: false });
  await refused;
  await expect(f.channel.request(f.intent)).rejects.toThrow("generation was already attempted");
  const next = { ...f.intent, generation: "b8342f1f-5cca-41c3-bde1-595672157276" };
  const accepted = f.channel.request(next);
  f.channel.observe({ ...next, type: "paseo:maintenance-restart-accepted", accepted: true });
  await expect(accepted).resolves.toEqual({ ...next, accepted: true });
  expect(f.send).toHaveBeenCalledTimes(2);
});

test("lost or failed sends retain uncertainty and ignore late supervisor acceptance", async () => {
  vi.useFakeTimers();
  try {
    const f = restartChannelFixture();
    f.handshake();
    const result = f.channel.request(f.intent);
    const timedOut = expect(result).rejects.toThrow("acceptance is unconfirmed");
    await vi.advanceTimersByTimeAsync(5000);
    await timedOut;
    f.channel.observe({ ...f.intent, type: "paseo:maintenance-restart-accepted", accepted: true });
    await expect(f.channel.request(f.intent)).rejects.toThrow("observe without replay");
    expect(f.send).toHaveBeenCalledTimes(1);
    const failed = restartChannelFixture();
    failed.handshake();
    failed.send.mockImplementation(() => {
      throw new Error("IPC reply lost");
    });
    await expect(failed.channel.request(failed.intent)).rejects.toThrow("send is unconfirmed");
    await expect(failed.channel.request(failed.intent)).rejects.toThrow("observe without replay");
    expect(failed.send).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});

async function runWorker(worker: string, publicationDelay = 0) {
  const home = await mkdtemp(path.join(tmpdir(), "paseo-readiness-"));
  const workerPath = path.join(home, "worker.mjs");
  const runnerPath = path.join(home, "runner.mjs");
  const eventsPath = path.join(home, "events.jsonl");
  const supervisor = new URL("./supervisor.ts", import.meta.url).href;
  await writeFile(workerPath, worker);
  await writeFile(
    runnerPath,
    `
    import { appendFile } from "node:fs/promises";
    import { runSupervisor } from ${JSON.stringify(supervisor)};
    const record = (event) => appendFile(${JSON.stringify(eventsPath)}, JSON.stringify(event) + "\\n");
    runSupervisor({
      name: "ReadinessTest", startupMessage: "starting", restartOnCrash: true,
      resolveWorkerEntry: () => ${JSON.stringify(workerPath)}, workerArgs: [], workerExecArgv: [],
      onWorkerReady: async ({ listen }) => {
        await new Promise(resolve => setTimeout(resolve, ${publicationDelay}));
        await record(listen);
      },
      onWorkerExit: () => record(null),
    });
  `,
  );
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("PASEO_")),
  );
  const child = spawn(process.execPath, ["--import", "tsx", runnerPath], {
    cwd: fileURLToPath(new URL("../../../", import.meta.url)),
    env: { ...env, HOME: home, PASEO_HOME: home },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(output));
      }, 5_000);
      child.once("error", reject);
      child.once("close", (exitCode) => {
        clearTimeout(timer);
        resolve(exitCode);
      });
    });
    const events = await readFile(eventsPath, "utf8").catch(() => "");
    return {
      code,
      output,
      events: events
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    };
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test("a worker that exits before ready fails the supervisor without respawning", async () => {
  const result = await runWorker(`
    import { existsSync, writeFileSync } from "node:fs";
    const marker = process.argv[1] + ".started";
    if (existsSync(marker)) process.exit(0);
    writeFileSync(marker, "started");
    process.exit(1);
  `);
  expect(result.code).toBe(1);
  expect(result.output).not.toContain("Restarting worker");
});

test("a replacement worker must independently reach ready", async () => {
  const result = await runWorker(`
    import { existsSync, writeFileSync } from "node:fs";
    const marker = process.argv[1] + ".started";
    if (existsSync(marker)) process.exit(0);
    writeFileSync(marker, "started");
    process.on("message", message => {
      if (message.type === "paseo:graceful-shutdown") process.exit(0);
    });
    process.send({ type: "paseo:ready", listen: "test-endpoint", serverId: "srv_test" });
    process.send({ type: "paseo:restart" });
  `);
  expect(result.code).toBe(1);
  expect(result.events, result.output).toEqual(["test-endpoint", null, null]);
});

test("exit clears publication after an in-flight ready write", async () => {
  const result = await runWorker(
    `
    process.send({ type: "paseo:ready", listen: "test-endpoint", serverId: "srv_test" }, () => process.exit(0));
  `,
    100,
  );
  expect(result.code).toBe(0);
  expect(result.events.at(-1)).toBeNull();
});

test("requested shutdown before first readiness exits successfully", async () => {
  const result = await runWorker(`
    process.on("message", message => {
      if (message.type === "paseo:graceful-shutdown") process.exit(0);
    });
    process.send({ type: "paseo:shutdown", reason: "cancelled_start" });
  `);
  expect(result.code).toBe(0);
  expect(result.events).toEqual([null]);
});

test("maintenance restart acknowledges the exact worker generation once and preserves its absolute deadline", async () => {
  const result = await runWorker(`
    import {existsSync,writeFileSync} from 'node:fs'; import {randomUUID} from 'node:crypto';
    const marker=process.argv[1]+'.started';
    setTimeout(()=>process.exit(1),4000).unref();
    if(existsSync(marker)) {
      process.send({type:'paseo:ready',listen:'replacement',serverId:'srv_test'},()=>process.exit(0));
    } else {
      writeFileSync(marker,'started');
      process.send({type:'paseo:ready',listen:'original',serverId:'srv_test'});
      let intent, sent=false;
      process.on('message',message=>{
        if(message.type==='paseo:supervisor-heartbeat' && !sent) {
          sent=true; if(message.maintenanceRestartProtocol!==1)throw Error('missing protocol');
          intent={type:'paseo:maintenance-restart',requestId:randomUUID(),generation:randomUUID(),workerPid:process.pid,terminateAt:Date.now()+1000};
          process.send(intent); process.send(intent);
        }
        if(message.type==='paseo:maintenance-restart-accepted') {
          if(!message.accepted || message.generation!==intent.generation || message.requestId!==intent.requestId || message.workerPid!==process.pid || message.terminateAt!==intent.terminateAt)throw Error('wrong acceptance');
          console.log('exact-maintenance-acceptance');
        }
        if(message.type==='paseo:graceful-shutdown') {
          if(message.terminateAt!==intent.terminateAt)throw Error('changed deadline');
          console.log('one-maintenance-shutdown'); setTimeout(()=>process.exit(0),30);
        }
      });
    }
  `);
  expect(result.code, result.output).toBe(0);
  expect(result.output.match(/exact-maintenance-acceptance/g)).toHaveLength(2);
  expect(result.output.match(/one-maintenance-shutdown/g)).toHaveLength(1);
  expect(result.events).toEqual(["original", null, "replacement", null]);
});

test.each(["wrong-worker", "expired-deadline"] as const)(
  "maintenance restart refuses %s before shutdown",
  async (mode) => {
    const result = await runWorker(`
    import {randomUUID} from 'node:crypto';
    setTimeout(()=>process.exit(1),4000).unref();
    process.send({type:'paseo:ready',listen:'original',serverId:'srv_test'});
    let sent=false;
    process.on('message',message=>{
      if(message.type==='paseo:supervisor-heartbeat' && !sent) {
        sent=true; process.send({type:'paseo:maintenance-restart',requestId:randomUUID(),generation:randomUUID(),workerPid:process.pid+${mode === "wrong-worker" ? 1 : 0},terminateAt:Date.now()+${mode === "expired-deadline" ? -1 : 1000}});
      }
      if(message.type==='paseo:maintenance-restart-accepted') {
        if(message.accepted)throw Error('unexpected acceptance');
        console.log('maintenance-refused'); process.send({type:'paseo:shutdown',reason:'fixture_complete'});
      }
      if(message.type==='paseo:graceful-shutdown') {
        if(message.terminateAt!==undefined)throw Error('refused maintenance dispatched');
        process.exit(0);
      }
    });
  `);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain("maintenance-refused");
    expect(result.output).not.toContain("Maintenance restart accepted");
    expect(result.events).toEqual(["original", null]);
  },
);

test("maintenance restart uses one absolute termination budget without adding legacy grace", async () => {
  const result = await runWorker(`
    import {existsSync,writeFileSync} from 'node:fs'; import {randomUUID} from 'node:crypto';
    const marker=process.argv[1]+'.started';
    setTimeout(()=>process.exit(1),4000).unref();
    if(existsSync(marker)) {
      process.send({type:'paseo:ready',listen:'replacement',serverId:'srv_test'},()=>process.exit(0));
    } else {
      writeFileSync(marker,'started');
      process.send({type:'paseo:ready',listen:'original',serverId:'srv_test'});
      let sent=false;
      process.on('message',message=>{
        if(message.type==='paseo:supervisor-heartbeat' && !sent) {
          sent=true; process.send({type:'paseo:maintenance-restart',requestId:randomUUID(),generation:randomUUID(),workerPid:process.pid,terminateAt:Date.now()+100});
        }
        if(message.type==='paseo:graceful-shutdown')console.log('checkpoint-incomplete-fixture');
      });
    }
  `);
  expect(result.code, result.output).toBe(0);
  expect(result.output).toContain("checkpoint-incomplete-fixture");
  expect(result.output).toContain("(SIGKILL)");
  expect(result.events).toEqual(["original", null, "replacement", null]);
});

test("shutdown during accepted maintenance cannot extend its termination deadline", async () => {
  const result = await runWorker(`
    import {randomUUID} from 'node:crypto';
    setTimeout(()=>process.exit(1),4000).unref();
    process.send({type:'paseo:ready',listen:'original',serverId:'srv_test'});
    let sent=false, intent, acknowledgements=0;
    process.on('message',message=>{
      if(message.type==='paseo:supervisor-heartbeat' && !sent) {
        sent=true; intent={type:'paseo:maintenance-restart',requestId:randomUUID(),generation:randomUUID(),workerPid:process.pid,terminateAt:Date.now()+100}; process.send(intent);
      }
      if(message.type==='paseo:maintenance-restart-accepted') {
        if(!message.accepted)throw Error('accepted intent became refused');
        console.log('monotonic-maintenance-acceptance');
        if(++acknowledgements===1) {
          process.send({type:'paseo:shutdown',reason:'fixture_stop_during_maintenance'});
          process.send(intent);
        }
      }
    });
  `);
  expect(result.code, result.output).toBe(0);
  expect(result.output).toContain("(SIGKILL)");
  expect(result.output.match(/monotonic-maintenance-acceptance/g)).toHaveLength(2);
  expect(result.events).toEqual(["original", null]);
});
