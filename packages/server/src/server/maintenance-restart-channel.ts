/** IPC transport only. Queue authority, exact held-worker admission and native
 * readiness remain mandatory outside this channel. */
export interface MaintenanceRestartIntent {
  requestId: string;
  generation: string;
  workerPid: number;
  terminateAt: number;
}
export interface MaintenanceRestartAcceptance extends MaintenanceRestartIntent {
  accepted: true;
}
interface ChannelPorts {
  workerPid: number;
  parentPid: number;
  currentParentPid(): number;
  connected(): boolean;
  send(message: MaintenanceRestartIntent & { type: "paseo:maintenance-restart" }): void;
  now(): number;
}

export function createMaintenanceRestartChannel(ports: ChannelPorts) {
  let protocol = false;
  let consumed = false;
  const attemptedGenerations = new Set<string>();
  let pending: {
    intent: MaintenanceRestartIntent;
    resolve(value: MaintenanceRestartAcceptance): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  const supported = () =>
    protocol && ports.connected() && ports.currentParentPid() === ports.parentPid;

  function observe(value: unknown): void {
    if (typeof value !== "object" || value === null) return;
    const message = value as Record<string, unknown>;
    if (message.type === "paseo:supervisor-heartbeat") {
      protocol = message.maintenanceRestartProtocol === 1;
      return;
    }
    if (message.type !== "paseo:maintenance-restart-accepted" || !pending || !supported()) return;
    const { intent } = pending;
    if (
      message.requestId !== intent.requestId ||
      message.generation !== intent.generation ||
      message.workerPid !== intent.workerPid ||
      message.terminateAt !== intent.terminateAt ||
      typeof message.accepted !== "boolean"
    )
      return;
    const current = pending;
    pending = null;
    clearTimeout(current.timer);
    if (!message.accepted) {
      // An exact refusal proves that this supervisor did not dispatch. A new
      // tracked generation may proceed; the refused generation cannot be resent.
      consumed = false;
      current.reject(new Error("Supervisor refused the exact maintenance restart"));
    } else current.resolve({ ...intent, accepted: true });
  }

  function request(intent: MaintenanceRestartIntent): Promise<MaintenanceRestartAcceptance> {
    if (!supported())
      return Promise.reject(new Error("Running supervisor lacks maintenance restart support"));
    if (consumed)
      return Promise.reject(
        new Error("Maintenance restart was already attempted; observe without replay"),
      );
    if (attemptedGenerations.has(intent.generation))
      return Promise.reject(
        new Error("Maintenance generation was already attempted; do not resend"),
      );
    const remaining = intent.terminateAt - ports.now();
    if (
      intent.workerPid !== ports.workerPid ||
      !Number.isSafeInteger(intent.terminateAt) ||
      remaining <= 0 ||
      remaining > 300_000
    )
      return Promise.reject(
        new Error("Maintenance restart differs from the current worker or deadline"),
      );
    consumed = true;
    attemptedGenerations.add(intent.generation);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => {
          pending = null;
          reject(new Error("Supervisor acceptance is unconfirmed; observe without replay"));
        },
        Math.min(5000, remaining),
      );
      pending = { intent: { ...intent }, resolve, reject, timer };
      try {
        ports.send({ ...intent, type: "paseo:maintenance-restart" });
      } catch (error) {
        clearTimeout(timer);
        pending = null;
        reject(
          new Error("Maintenance restart send is unconfirmed; observe without replay", {
            cause: error,
          }),
        );
      }
    });
  }
  return { supported, observe, request };
}
