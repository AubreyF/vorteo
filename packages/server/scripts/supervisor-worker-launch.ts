import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  WorkerLaunchSchema,
  WorkerLaunchRequestSchema,
  WorkerLaunchNativeIdentitySchema,
  type WorkerLaunch,
  type WorkerLaunchBinding,
  type WorkerLaunchRequest,
} from "@getpaseo/protocol/execution-installation";

export type SupervisorWorkerIdentity = z.infer<typeof WorkerLaunchNativeIdentitySchema>;
const ReceiptSchema = z.strictObject({
  id: z.uuid(),
  revision: z.uuid(),
  status: z.enum(["pending", "approved", "running", "succeeded", "failed", "rejected"]),
  detail: z.string(),
  workerLaunch: WorkerLaunchSchema.nullable(),
});
export type SupervisorLaunchReceipt = z.infer<typeof ReceiptSchema>;

export interface SupervisorWorkerIpc {
  generation: string;
  wrapper: SupervisorWorkerIdentity;
  worker: SupervisorWorkerIdentity;
  /** The injected attachment authenticates the sender; payload PID is never evidence. */
  subscribe(listener: (message: unknown, sender: SupervisorWorkerIdentity) => void): () => void;
  send(message: unknown): void;
}
interface ObservedWorker {
  binding: WorkerLaunchBinding;
  worker: SupervisorWorkerIdentity;
  custodian: SupervisorWorkerIdentity;
}
export type SupervisorCustodyObservation =
  | { state: "unknown" }
  | (ObservedWorker & { state: "running"; ipc: SupervisorWorkerIpc })
  | (ObservedWorker & { state: "worker-exited"; code: number | null; signal: string | null })
  | (ObservedWorker & {
      state: "settled";
      code: number | null;
      signal: string | null;
      launch: Extract<WorkerLaunch, { phase: "settled" }>;
    });

export interface SupervisorWorkerLaunchPorts {
  capabilities(): Promise<{ workerLaunch: { available: boolean } }>;
  /** Existing installation requester only. No command, environment or credential input. */
  request(hints: WorkerLaunchRequest): Promise<SupervisorLaunchReceipt>;
  status(id: string): Promise<SupervisorLaunchReceipt>;
  /** Missing production interface: read-only resolution when the request reply is lost. */
  resolve(hints: WorkerLaunchRequest): Promise<SupervisorLaunchReceipt | null>;
  /** Missing production interface: protected native proof plus exact IPC attachment.
   * The optional descriptor is borrowed, never reopened/unlocked/closed here.
   * Passing it to this port does not prove that descriptor transfer occurred. */
  observe(
    launch: WorkerLaunch,
    controllerLifetimeFd: number | undefined,
  ): Promise<SupervisorCustodyObservation>;
}
export interface SupervisorWorkerLaunchCursor {
  hints: WorkerLaunchRequest;
  attempted: boolean;
  receipt: SupervisorLaunchReceipt | null;
}
export interface SupervisorWorkerLaunchOptions {
  supervisor: SupervisorWorkerIdentity;
  profileSha256: string;
  startupCause: WorkerLaunchRequest["cause"];
  ports: SupervisorWorkerLaunchPorts;
  /** Recovered from the existing lifecycle owner, never another supervisor store. */
  resume?: SupervisorWorkerLaunchCursor;
}
export interface SupervisorWorkerLaunchCallbacks {
  controllerLifetimeFd?: number;
  restartOnCrash: boolean;
  onReady(message: { listen: string; serverId: string }): Promise<void> | void;
  onWorkerExit(): Promise<void> | void;
  onExit(code: number): Promise<void> | void;
  report(message: string): void;
}
export interface SupervisorWorkerLaunchState extends SupervisorWorkerLaunchCursor {
  worker: SupervisorWorkerIdentity | null;
  custodian: SupervisorWorkerIdentity | null;
  wrapper: SupervisorWorkerIdentity | null;
  workerExitObserved: boolean;
  settlementObserved: boolean;
}

function causeHint(cause: WorkerLaunchBinding["cause"]): WorkerLaunchRequest["cause"] {
  return cause.kind === "startup"
    ? { kind: "startup", registrationGeneration: cause.registrationGeneration }
    : { kind: "predecessor", generation: cause.generation };
}
function requirePorts(ports: SupervisorWorkerLaunchPorts): void {
  for (const name of ["capabilities", "request", "status", "resolve", "observe"] as const)
    if (typeof ports[name] !== "function")
      throw new Error(`Worker launch injection requires ${name}`);
}
function assertReceipt(
  receipt: SupervisorLaunchReceipt,
  state: SupervisorWorkerLaunchState,
  supervisor: SupervisorWorkerIdentity,
): void {
  const retained = state.receipt;
  if (retained && receipt.id !== retained.id)
    throw new Error("Worker launch request changed during reopening");
  const launch = receipt.workerLaunch;
  if (!launch) {
    if (retained?.workerLaunch) throw new Error("Retained worker launch disappeared");
    return;
  }
  const binding = launch.binding;
  if (
    binding.requestId !== receipt.id ||
    binding.profileSha256 !== state.hints.profileSha256 ||
    !isDeepStrictEqual(binding.supervisor, supervisor) ||
    !isDeepStrictEqual(causeHint(binding.cause), state.hints.cause)
  )
    throw new Error("Worker launch receipt differs from the exact supervisor cause");
  const prior = retained?.workerLaunch;
  if (
    prior &&
    (!isDeepStrictEqual(prior.binding, binding) || prior.reservedAt !== launch.reservedAt)
  )
    throw new Error("Retained worker launch generation changed");
  if (prior && prior.phase !== "reserved") {
    if (launch.phase === "reserved" || prior.consumedAt !== launch.consumedAt)
      throw new Error("Consumed worker launch cannot reopen as reserved or change consumption");
    if (prior.phase === "settled" && !isDeepStrictEqual(prior, launch))
      throw new Error("Terminal worker settlement cannot change");
  }
}
function assertObservation(
  observed: ObservedWorker,
  state: SupervisorWorkerLaunchState,
  launch: WorkerLaunch,
): void {
  if (!isDeepStrictEqual(observed.binding, launch.binding))
    throw new Error("Native observation belongs to another worker launch");
  WorkerLaunchNativeIdentitySchema.parse(observed.worker);
  WorkerLaunchNativeIdentitySchema.parse(observed.custodian);
  if (
    observed.worker.parentPid !== observed.custodian.pid ||
    observed.worker.bootId !== observed.custodian.bootId ||
    observed.worker.pid === observed.custodian.pid
  )
    throw new Error(
      "Native worker and custodian identities do not form the actual child relationship",
    );
  if (
    (state.worker && !isDeepStrictEqual(state.worker, observed.worker)) ||
    (state.custodian && !isDeepStrictEqual(state.custodian, observed.custodian))
  )
    throw new Error("Authenticated worker or custodian lifetime changed");
}

/** Disabled without explicit injection. This owns no launch, signal, credential,
 * store or native verifier; the existing lifecycle owner retains all authority. */
export function createSupervisorWorkerLaunch(
  options: SupervisorWorkerLaunchOptions,
  callbacks: SupervisorWorkerLaunchCallbacks,
) {
  requirePorts(options.ports);
  const supervisor = WorkerLaunchNativeIdentitySchema.parse(options.supervisor);
  const hints = WorkerLaunchRequestSchema.parse({
    profileSha256: options.profileSha256,
    supervisorPid: supervisor.pid,
    cause: options.startupCause,
  });
  const initial = options.resume;
  if (initial && !isDeepStrictEqual(initial.hints, hints))
    throw new Error("Reopened supervisor cause changed");
  let state: SupervisorWorkerLaunchState = {
    hints,
    attempted: false,
    receipt: null,
    worker: null,
    custodian: null,
    wrapper: null,
    workerExitObserved: false,
    settlementObserved: false,
  };
  if (initial) {
    if (initial.receipt) assertReceipt(ReceiptSchema.parse(initial.receipt), state, supervisor);
    if (initial.receipt && !initial.attempted)
      throw new Error("A retained request cannot reopen as unattempted");
    state = {
      ...state,
      hints: structuredClone(initial.hints),
      attempted: initial.attempted,
      receipt: initial.receipt ? ReceiptSchema.parse(initial.receipt) : null,
    };
  }
  let ipc: SupervisorWorkerIpc | null = null;
  let unsubscribe: (() => void) | null = null;
  let operation: Promise<void> | null = null;
  let publication = Promise.resolve();
  let publicationFailed = false;
  let withdrawal: Promise<void> | null = null;
  let ready = false;
  let restarting = false;
  let shuttingDown = false;
  let exited = false;

  function snapshot(): SupervisorWorkerLaunchState {
    return structuredClone(state);
  }
  function report(error: unknown): void {
    callbacks.report(error instanceof Error ? error.message : String(error));
  }
  function send(packet: unknown): void {
    try {
      ipc?.send(packet);
    } catch (error) {
      report(error);
    }
  }
  function shutdown(reason: string): void {
    shuttingDown = true;
    restarting = false;
    send({ type: "paseo:graceful-shutdown", reason });
    // No timer or ChildProcess.kill: only native observation can settle custody.
  }
  function message(
    value: unknown,
    sender: SupervisorWorkerIdentity,
    attachment: SupervisorWorkerIpc,
  ): void {
    if (ipc !== attachment || state.workerExitObserved || !isDeepStrictEqual(state.worker, sender))
      return;
    if (typeof value !== "object" || value === null || !("type" in value)) return;
    if (
      !shuttingDown &&
      value.type === "paseo:ready" &&
      "listen" in value &&
      "serverId" in value &&
      typeof value.listen === "string" &&
      value.listen.length > 0 &&
      typeof value.serverId === "string" &&
      value.serverId.length > 0
    ) {
      const notification = { listen: value.listen, serverId: value.serverId };
      ready = true;
      publication = publication
        .then(() => callbacks.onReady(notification))
        .catch((error) => {
          publicationFailed = true;
          report(error);
          shutdown("endpoint_publication_failed");
        });
    }
    if (value.type === "paseo:shutdown") shutdown("worker_requested_shutdown");
    if (value.type === "paseo:restart" && !shuttingDown) {
      restarting = true;
      send({ type: "paseo:graceful-shutdown", reason: "worker_requested_restart" });
    }
    if (value.type === "paseo:maintenance-restart") {
      // Root cleanup/control is not implemented. Never advertise or accept it
      // merely because authenticated workload IPC exists.
      send({ ...value, type: "paseo:maintenance-restart-accepted", accepted: false });
    }
  }
  function attach(observed: Extract<SupervisorCustodyObservation, { state: "running" }>): void {
    const channel = observed.ipc;
    const wrapper = WorkerLaunchNativeIdentitySchema.parse(channel.wrapper);
    if (
      channel.generation !== observed.binding.generation ||
      !isDeepStrictEqual(channel.worker, observed.worker) ||
      wrapper.parentPid !== supervisor.pid ||
      wrapper.bootId !== supervisor.bootId ||
      wrapper.uid !== supervisor.uid ||
      wrapper.pid === observed.worker.pid ||
      wrapper.pid === observed.custodian.pid
    )
      throw new Error("IPC attachment differs from the authenticated inner worker");
    if (state.wrapper && !isDeepStrictEqual(state.wrapper, wrapper))
      throw new Error("Transport wrapper lifetime changed");
    state.wrapper = wrapper;
    if (ipc === channel) return;
    unsubscribe?.();
    ipc = channel;
    unsubscribe = channel.subscribe((value, sender) => message(value, sender, channel));
    if (shuttingDown)
      send({ type: "paseo:graceful-shutdown", reason: "supervisor_shutdown_pending" });
  }
  async function workerExited(): Promise<void> {
    if (!withdrawal) {
      state.workerExitObserved = true;
      unsubscribe?.();
      unsubscribe = null;
      ipc = null;
      withdrawal = publication
        .then(() => callbacks.onWorkerExit())
        .catch((error) => {
          publicationFailed = true;
          report(error);
          throw error;
        });
    }
    // A failed withdrawal remains a failed barrier on every reopening.
    await withdrawal;
  }
  async function settled(
    observed: Extract<SupervisorCustodyObservation, { state: "settled" }>,
  ): Promise<void> {
    const settledLaunch = WorkerLaunchSchema.parse(observed.launch);
    if (
      settledLaunch.phase !== "settled" ||
      !isDeepStrictEqual(settledLaunch.binding, observed.binding)
    )
      throw new Error("Native terminal settlement differs from retained launch");
    const receipt = { ...state.receipt!, workerLaunch: settledLaunch };
    assertReceipt(receipt, state, supervisor);
    state.receipt = receipt;
    state.settlementObserved = true;
    await workerExited();
    const crashed =
      callbacks.restartOnCrash &&
      ((observed.code !== null && observed.code !== 0) ||
        (observed.signal !== null && observed.signal !== "SIGTERM"));
    if (!shuttingDown && ready && (restarting || crashed)) {
      const nextHints = WorkerLaunchRequestSchema.parse({
        ...state.hints,
        cause: { kind: "predecessor", generation: observed.binding.generation },
      });
      state = {
        hints: nextHints,
        attempted: false,
        receipt: null,
        worker: null,
        custodian: null,
        wrapper: null,
        workerExitObserved: false,
        settlementObserved: false,
      };
      ready = false;
      restarting = false;
      withdrawal = null;
      await requestOnce();
      return;
    }
    if (!exited) {
      exited = true;
      let exitCode = observed.code ?? 1;
      if (shuttingDown) exitCode = 0;
      if (publicationFailed || (!ready && !shuttingDown)) exitCode = 1;
      await callbacks.onExit(exitCode);
    }
  }
  async function observe(): Promise<void> {
    const launch = state.receipt?.workerLaunch;
    if (!launch || launch.phase === "reserved" || state.settlementObserved) return;
    const observed = await options.ports.observe(
      structuredClone(launch),
      callbacks.controllerLifetimeFd,
    );
    if (observed.state === "unknown") return;
    assertObservation(observed, state, launch);
    state.worker = structuredClone(observed.worker);
    state.custodian = structuredClone(observed.custodian);
    if (observed.state === "running") {
      if (state.workerExitObserved) throw new Error("Exited worker cannot become running again");
      attach(observed);
      return;
    }
    await workerExited();
    if (observed.state === "settled") await settled(observed);
  }
  async function retain(receipt: SupervisorLaunchReceipt): Promise<void> {
    const parsed = ReceiptSchema.parse(receipt);
    assertReceipt(parsed, state, supervisor);
    state.receipt = parsed;
    await observe();
  }
  async function requestOnce(): Promise<void> {
    if (state.attempted || shuttingDown || exited) return;
    const capability = await options.ports.capabilities();
    if (capability.workerLaunch.available !== true)
      throw new Error("Custody worker launch is not advertised; no local fallback");
    if (shuttingDown || exited) return;
    state.attempted = true;
    await retain(await options.ports.request(structuredClone(state.hints)));
  }
  function reopen(): Promise<void> {
    if (operation) return operation;
    operation = (async () => {
      if (exited) return;
      if (!state.attempted) {
        await requestOnce();
        return;
      }
      const receipt = state.receipt
        ? await options.ports.status(state.receipt.id)
        : await options.ports.resolve(structuredClone(state.hints));
      if (receipt) await retain(receipt);
    })().finally(() => {
      operation = null;
    });
    return operation;
  }
  function heartbeat(): void {
    send({ type: "paseo:supervisor-heartbeat", maintenanceRestartProtocol: 0 });
  }
  return { reopen, shutdown, heartbeat, snapshot };
}
