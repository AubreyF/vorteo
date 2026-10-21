import { randomUUID } from "node:crypto";
import { expect, test, vi } from "vitest";
import {
  WorkerLaunchSchema,
  type WorkerLaunchRequest,
} from "@getpaseo/protocol/execution-installation";
import {
  createSupervisorWorkerLaunch,
  type SupervisorWorkerIdentity,
  type SupervisorWorkerIpc,
  type SupervisorCustodyObservation,
  type SupervisorLaunchReceipt,
  type SupervisorWorkerLaunchPorts,
} from "./supervisor-worker-launch.js";
import { runSupervisor } from "./supervisor.js";

const hash = "a".repeat(64);
function fixture() {
  const supervisor: SupervisorWorkerIdentity = {
    pid: process.pid,
    parentPid: 1,
    uid: 1000,
    bootId: randomUUID(),
    startTicks: "100",
  };
  const wrapper = {
    ...supervisor,
    pid: process.pid + 10,
    parentPid: supervisor.pid,
    startTicks: "101",
  };
  const custodian = {
    ...supervisor,
    pid: process.pid + 11,
    parentPid: 9,
    uid: 0,
    startTicks: "102",
  };
  const worker = {
    ...supervisor,
    pid: process.pid + 12,
    parentPid: custodian.pid,
    startTicks: "103",
  };
  const cause: WorkerLaunchRequest["cause"] = {
    kind: "startup",
    registrationGeneration: randomUUID(),
  };
  const requestId = randomUUID();
  const launch = WorkerLaunchSchema.parse({
    phase: "consumed",
    reservedAt: "2026-10-17T00:00:00.000Z",
    consumedAt: "2026-10-17T00:00:01.000Z",
    binding: {
      requestId,
      approvalRevision: randomUUID(),
      generation: randomUUID(),
      grantId: randomUUID(),
      grantRevision: randomUUID(),
      manifestSha256: hash,
      profileSha256: hash,
      targetIdentitySha256: hash,
      sourceCommit: "a".repeat(40),
      artifactSha256: hash,
      publicationSha256: hash,
      cause: { ...cause, registrationSha256: hash },
      supervisor,
    },
  });
  let receipt: SupervisorLaunchReceipt = {
    id: requestId,
    revision: launch.binding.approvalRevision,
    status: "running",
    detail: "retained",
    workerLaunch: launch,
  };
  let listener: ((value: unknown, sender: SupervisorWorkerIdentity) => void) | null = null;
  const sent: unknown[] = [];
  const channel: SupervisorWorkerIpc = {
    generation: launch.binding.generation,
    wrapper,
    worker,
    subscribe: (callback) => {
      listener = callback;
      return () => {
        listener = null;
      };
    },
    send: (value) => {
      sent.push(value);
    },
  };
  let observation: SupervisorCustodyObservation = {
    state: "running",
    binding: launch.binding,
    worker,
    custodian,
    ipc: channel,
  };
  const requests: WorkerLaunchRequest[] = [];
  const events: string[] = [];
  const fds: Array<number | undefined> = [];
  let requestLost = false;
  let supported = true;
  let observations = 0;
  const ports: SupervisorWorkerLaunchPorts = {
    capabilities: async () => ({ workerLaunch: { available: supported } }),
    request: async (hints) => {
      requests.push(hints);
      if (requestLost) throw new Error("reply lost");
      return receipt;
    },
    status: async () => receipt,
    resolve: async () => receipt,
    observe: async (_record, fd) => {
      observations += 1;
      fds.push(fd);
      return observation;
    },
  };
  const callbacks = {
    restartOnCrash: true,
    controllerLifetimeFd: 47,
    onReady: () => {
      events.push("ready");
    },
    onWorkerExit: () => {
      events.push("worker-exit");
    },
    onExit: (code: number) => {
      events.push(`supervisor-exit:${code}`);
    },
    report: (message: string) => {
      events.push(`report:${message}`);
    },
  };
  const options = { supervisor, profileSha256: hash, startupCause: cause, ports };
  const adapter = createSupervisorWorkerLaunch(options, callbacks);
  function emit(value: unknown, sender = worker) {
    listener?.(value, sender);
  }
  function exitOnly() {
    observation = {
      state: "worker-exited",
      binding: launch.binding,
      worker,
      custodian,
      code: 1,
      signal: null,
    };
  }
  function settlement() {
    const terminal = WorkerLaunchSchema.parse({
      ...launch,
      phase: "settled",
      observedAt: "2026-10-17T00:00:02.000Z",
      observationSha256: hash,
    });
    if (terminal.phase !== "settled") throw new Error("Missing terminal fixture");
    observation = {
      state: "settled",
      binding: launch.binding,
      worker,
      custodian,
      code: 1,
      signal: null,
      launch: terminal,
    };
  }
  return {
    adapter,
    options,
    callbacks,
    ports,
    launch,
    supervisor,
    wrapper,
    custodian,
    worker,
    channel,
    requests,
    sent,
    events,
    fds,
    emit,
    exitOnly,
    settlement,
    observations: () => observations,
    setObservation: (value: SupervisorCustodyObservation) => {
      observation = value;
    },
    setReceipt: (value: SupervisorLaunchReceipt) => {
      receipt = value;
    },
    receipt: () => receipt,
    loseRequest: () => {
      requestLost = true;
    },
    unsupported: () => {
      supported = false;
    },
  };
}

test("startup requester uses exact registered cause and separates wrapper, worker and custodian", async () => {
  const f = fixture();
  await f.adapter.reopen();
  expect(f.requests).toEqual([
    { profileSha256: hash, supervisorPid: f.supervisor.pid, cause: f.options.startupCause },
  ]);
  expect(f.adapter.snapshot()).toMatchObject({
    wrapper: f.wrapper,
    worker: f.worker,
    custodian: f.custodian,
  });
  expect(f.custodian.parentPid).not.toBe(f.supervisor.pid);
  expect(f.fds).toEqual([47]); // Borrowed descriptor contract only, no transfer proof.
});

test("lost request reply reopens one retained generation without submitting again", async () => {
  const f = fixture();
  f.loseRequest();
  await expect(f.adapter.reopen()).rejects.toThrow("reply lost");
  const cursor = f.adapter.snapshot();
  expect(cursor.attempted).toBe(true);
  expect(cursor.receipt).toBeNull();
  const reopened = createSupervisorWorkerLaunch(
    { ...f.options, resume: { hints: cursor.hints, attempted: true, receipt: null } },
    f.callbacks,
  );
  await reopened.reopen();
  await reopened.reopen();
  expect(f.requests).toHaveLength(1);
  expect(reopened.snapshot().receipt?.workerLaunch?.binding.generation).toBe(
    f.launch.binding.generation,
  );
});

test("unknown same-cause resolution never permits another request", async () => {
  const f = fixture();
  f.loseRequest();
  await expect(f.adapter.reopen()).rejects.toThrow("reply lost");
  f.ports.resolve = async () => null;
  await f.adapter.reopen();
  await f.adapter.reopen();
  expect(f.requests).toHaveLength(1);
  expect(f.adapter.snapshot().receipt).toBeNull();
});

test("reopening rejects changed request and generation without replay", async () => {
  const f = fixture();
  await f.adapter.reopen();
  f.setReceipt({ ...f.receipt(), id: randomUUID() });
  await expect(f.adapter.reopen()).rejects.toThrow("request changed");
  f.setReceipt({
    ...f.receipt(),
    id: f.launch.binding.requestId,
    workerLaunch: { ...f.launch, binding: { ...f.launch.binding, generation: randomUUID() } },
  });
  await expect(f.adapter.reopen()).rejects.toThrow("generation changed");
  expect(f.requests).toHaveLength(1);
});

test("authenticated inner sender alone publishes readiness and can request shutdown", async () => {
  const f = fixture();
  await f.adapter.reopen();
  f.emit({ type: "paseo:ready", listen: "tcp", serverId: "wrong" }, f.wrapper);
  f.emit({ type: "paseo:shutdown" }, f.wrapper);
  expect(f.events).toEqual([]);
  expect(f.sent).toEqual([]);
  f.emit({ type: "paseo:ready", listen: "tcp", serverId: "exact" });
  await Promise.resolve();
  expect(f.events).toEqual(["ready"]);
  f.emit({ type: "paseo:shutdown" });
  expect(f.sent).toContainEqual({
    type: "paseo:graceful-shutdown",
    reason: "worker_requested_shutdown",
  });
});

test("wrong IPC worker or wrapper ancestry cannot attach", async () => {
  const f = fixture();
  f.channel.worker = f.wrapper;
  await expect(f.adapter.reopen()).rejects.toThrow("IPC attachment differs");
  expect(f.requests).toHaveLength(1);
});

test("worker exit withdraws readiness but unknown custody cannot launch replacement", async () => {
  const f = fixture();
  await f.adapter.reopen();
  f.emit({ type: "paseo:ready", listen: "tcp", serverId: "exact" });
  f.exitOnly();
  await f.adapter.reopen();
  expect(f.events).toEqual(["ready", "worker-exit"]);
  expect(f.adapter.snapshot().settlementObserved).toBe(false);
  f.setObservation({ state: "unknown" });
  await f.adapter.reopen();
  expect(f.requests).toHaveLength(1);
});

test("only exact native settlement permits crash successor request with predecessor cause", async () => {
  const f = fixture();
  await f.adapter.reopen();
  f.emit({ type: "paseo:ready", listen: "tcp", serverId: "exact" });
  f.exitOnly();
  await f.adapter.reopen();
  f.settlement();
  f.ports.request = async (hints) => {
    f.requests.push(hints);
    throw new Error("successor reply lost");
  };
  await expect(f.adapter.reopen()).rejects.toThrow("successor reply lost");
  expect(f.requests[1].cause).toEqual({
    kind: "predecessor",
    generation: f.launch.binding.generation,
  });
  expect(f.requests).toHaveLength(2);
  f.ports.resolve = async () => null;
  await f.adapter.reopen();
  expect(f.requests).toHaveLength(2);
});

test("shutdown does not kill the wrapper or exit supervisor before native settlement", async () => {
  const f = fixture();
  await f.adapter.reopen();
  f.adapter.shutdown("stop");
  f.exitOnly();
  await f.adapter.reopen();
  expect(f.events).toEqual(["worker-exit"]);
  f.settlement();
  await f.adapter.reopen();
  await f.adapter.reopen();
  expect(f.events).toEqual(["worker-exit", "supervisor-exit:0"]);
  expect(f.requests).toHaveLength(1);
});

test("native observation from another generation or worker lifetime is refused", async () => {
  const f = fixture();
  await f.adapter.reopen();
  f.setObservation({
    state: "worker-exited",
    binding: f.launch.binding,
    worker: { ...f.worker, startTicks: "104" },
    custodian: f.custodian,
    code: 1,
    signal: null,
  });
  await expect(f.adapter.reopen()).rejects.toThrow("lifetime changed");
  expect(f.adapter.snapshot().workerExitObserved).toBe(false);
});

test("maintenance protocol remains unsupported and inner intent gets exact refusal", async () => {
  const f = fixture();
  await f.adapter.reopen();
  f.adapter.heartbeat();
  expect(f.sent[0]).toEqual({ type: "paseo:supervisor-heartbeat", maintenanceRestartProtocol: 0 });
  const intent = {
    type: "paseo:maintenance-restart",
    requestId: randomUUID(),
    generation: randomUUID(),
    workerPid: f.worker.pid,
    terminateAt: 123,
  };
  f.emit(intent, f.wrapper);
  expect(f.sent).toHaveLength(1);
  f.emit(intent);
  expect(f.sent[1]).toEqual({
    ...intent,
    type: "paseo:maintenance-restart-accepted",
    accepted: false,
  });
});

test("unadvertised and incomplete injection fail closed without a local launch", async () => {
  const f = fixture();
  f.unsupported();
  await expect(f.adapter.reopen()).rejects.toThrow("not advertised");
  expect(f.requests).toHaveLength(0);
  Reflect.deleteProperty(f.ports, "resolve");
  expect(() => createSupervisorWorkerLaunch(f.options, f.callbacks)).toThrow("requires resolve");
});

test("runSupervisor injected branch never resolves a local worker entry", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.unsupported();
  const originalInterrupt = new Set(process.listeners("SIGINT"));
  const originalTerminate = new Set(process.listeners("SIGTERM"));
  const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const error = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    const controller = runSupervisor({
      name: "unit",
      startupMessage: "unit",
      workerLaunch: f.options,
      resolveWorkerEntry: () => {
        throw new Error("Local spawn must not be reached");
      },
    });
    await expect(controller.reopenWorkerLaunch?.()).rejects.toThrow("not advertised");
    expect(controller.workerLaunchState?.().attempted).toBe(false);
    expect(f.requests).toHaveLength(0);
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
    output.mockRestore();
    error.mockRestore();
    for (const listener of process.listeners("SIGINT"))
      if (!originalInterrupt.has(listener)) process.removeListener("SIGINT", listener);
    for (const listener of process.listeners("SIGTERM"))
      if (!originalTerminate.has(listener)) process.removeListener("SIGTERM", listener);
  }
});

test("shutdown while capability collection is suspended cannot submit a launch request", async () => {
  const f = fixture();
  let complete = (_value: { workerLaunch: { available: boolean } }) => {};
  f.ports.capabilities = () =>
    new Promise((resolve) => {
      complete = resolve;
    });
  const opening = f.adapter.reopen();
  f.adapter.shutdown("cancel-before-request");
  complete({ workerLaunch: { available: true } });
  await opening;
  expect(f.requests).toHaveLength(0);
  expect(f.adapter.snapshot().attempted).toBe(false);
});

test("failed endpoint withdrawal remains a barrier across repeated settled observations", async () => {
  const f = fixture();
  let withdrawals = 0;
  f.callbacks.onWorkerExit = () => {
    withdrawals += 1;
    throw new Error("withdrawal failed");
  };
  await f.adapter.reopen();
  f.emit({ type: "paseo:ready", listen: "tcp", serverId: "exact" });
  f.exitOnly();
  await expect(f.adapter.reopen()).rejects.toThrow("withdrawal failed");
  f.settlement();
  await expect(f.adapter.reopen()).rejects.toThrow("withdrawal failed");
  await expect(f.adapter.reopen()).rejects.toThrow("withdrawal failed");
  expect(withdrawals).toBe(1);
  expect(f.requests).toHaveLength(1);
  expect(f.events.some((event) => event.startsWith("supervisor-exit:"))).toBe(false);
  expect(f.adapter.snapshot().settlementObserved).toBe(false);
});

test("shutdown cannot republish readiness from a later inner-worker message", async () => {
  const f = fixture();
  await f.adapter.reopen();
  f.adapter.shutdown("stop");
  f.emit({ type: "paseo:ready", listen: "tcp", serverId: "late" });
  await Promise.resolve();
  expect(f.events).toEqual([]);
});

test("terminal exit before readiness remains startup failure even with exit code zero", async () => {
  const f = fixture();
  await f.adapter.reopen();
  const terminal = WorkerLaunchSchema.parse({
    ...f.launch,
    phase: "settled",
    observedAt: "2026-10-17T00:00:02.000Z",
    observationSha256: hash,
  });
  if (terminal.phase !== "settled") throw new Error("Missing terminal fixture");
  f.setObservation({
    state: "settled",
    binding: f.launch.binding,
    worker: f.worker,
    custodian: f.custodian,
    code: 0,
    signal: null,
    launch: terminal,
  });
  await f.adapter.reopen();
  expect(f.events).toEqual(["worker-exit", "supervisor-exit:1"]);
  expect(f.requests).toHaveLength(1);
});

test("settled crash recovery attaches the successor inner worker through the same requester", async () => {
  const f = fixture();
  await f.adapter.reopen();
  f.emit({ type: "paseo:ready", listen: "old", serverId: "exact" });
  f.settlement();
  const nextId = randomUUID();
  const nextGeneration = randomUUID();
  const successor = WorkerLaunchSchema.parse({
    ...f.launch,
    binding: {
      ...f.launch.binding,
      requestId: nextId,
      generation: nextGeneration,
      cause: {
        kind: "predecessor",
        generation: f.launch.binding.generation,
        settlementSha256: hash,
      },
    },
  });
  const nextCustodian = { ...f.custodian, pid: f.custodian.pid + 100, startTicks: "202" };
  const nextWorker = {
    ...f.worker,
    pid: f.worker.pid + 100,
    parentPid: nextCustodian.pid,
    startTicks: "203",
  };
  const nextWrapper = { ...f.wrapper, pid: f.wrapper.pid + 100, startTicks: "201" };
  let receive = (_value: unknown, _sender: SupervisorWorkerIdentity): void => {
    throw new Error("Missing successor attachment");
  };
  const nextChannel: SupervisorWorkerIpc = {
    generation: nextGeneration,
    wrapper: nextWrapper,
    worker: nextWorker,
    subscribe: (listener) => {
      receive = listener;
      return () => {};
    },
    send: () => {},
  };
  f.ports.request = async (hints) => {
    f.requests.push(hints);
    f.setObservation({
      state: "running",
      binding: successor.binding,
      worker: nextWorker,
      custodian: nextCustodian,
      ipc: nextChannel,
    });
    return {
      id: nextId,
      revision: successor.binding.approvalRevision,
      status: "running",
      detail: "successor",
      workerLaunch: successor,
    };
  };
  await f.adapter.reopen();
  expect(f.adapter.snapshot()).toMatchObject({
    worker: nextWorker,
    wrapper: nextWrapper,
    custodian: nextCustodian,
    receipt: { id: nextId, workerLaunch: { binding: { generation: nextGeneration } } },
  });
  expect(f.events).toEqual(["ready", "worker-exit"]);
  f.emit({ type: "paseo:ready", listen: "stale", serverId: "old" });
  receive({ type: "paseo:ready", listen: "new", serverId: "exact" }, nextWorker);
  await Promise.resolve();
  expect(f.events).toEqual(["ready", "worker-exit", "ready"]);
  expect(f.requests).toHaveLength(2);
});
