import { createHash } from "node:crypto";
import { accessSync, constants } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import type { EngineRestartConfiguration } from "@getpaseo/protocol/execution-installation";
import {
  assertFactoryVerifyScript,
  defaultRun,
  runFactoryVerify as runFactoryCheck,
  type EngineCommand,
} from "./factory-verify.js";

export type { EngineCommand } from "./factory-verify.js";

const DEFAULT_DEADLINE_SECONDS = 600;
const COMMAND_TIMEOUT_MS = 30_000;

export interface EngineRestartDependencies {
  run?: EngineCommand;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

interface ContainerState {
  id: string;
  running: boolean;
  startedAt: string;
  health: string;
}

/** What preflight observed; readiness compares against it. */
export interface EngineRestartPreflight {
  startedAt: Record<keyof EngineRestartConfiguration["containers"], string>;
  factoryEpoch: number | null;
  factorySupervisorPid: number | null;
}

const CONTAINER_LABELS: Record<keyof EngineRestartConfiguration["containers"], string> = {
  dev: "Dev container",
  gatewayTailscale: "gateway Tailscale container",
  gatewayCaddy: "gateway Caddy container",
};

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value);
}

/**
 * The digest owners approve: the exact plan, with its executables checked. A missing
 * Docker binary or changed Factory script withholds the capability instead.
 */
export function engineRestartPlanDigest(
  plan: EngineRestartConfiguration | undefined,
): string | undefined {
  if (!plan) return undefined;
  try {
    accessSync(plan.docker, constants.X_OK);
    if (plan.factoryVerify) assertFactoryVerifyScript(plan.factoryVerify);
    return createHash("sha256").update(canonicalJson(plan)).digest("hex");
  } catch {
    return undefined;
  }
}

function dockerArgs(plan: EngineRestartConfiguration, args: string[]): string[] {
  return ["--host", `unix://${plan.socket}`, ...args];
}

async function inspectContainer(
  plan: EngineRestartConfiguration,
  run: EngineCommand,
  id: string,
): Promise<ContainerState> {
  const { stdout } = await run(
    plan.docker,
    dockerArgs(plan, [
      "inspect",
      "--type",
      "container",
      "--format",
      "{{.Id}}|{{.State.Running}}|{{.State.StartedAt}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}",
      id,
    ]),
    COMMAND_TIMEOUT_MS,
  );
  const [observed = "", running = "", startedAt = "", health = ""] = stdout.trim().split("|");
  return { id: observed, running: running === "true", startedAt, health };
}

async function engineAnswers(plan: EngineRestartConfiguration, run: EngineCommand) {
  await run(
    plan.docker,
    dockerArgs(plan, ["info", "--format", "{{.ServerVersion}}"]),
    COMMAND_TIMEOUT_MS,
  );
}

function runFactoryVerify(plan: EngineRestartConfiguration, run: EngineCommand) {
  return runFactoryCheck(
    {
      docker: plan.docker,
      socket: plan.socket,
      container: plan.containers.dev,
      verify: plan.factoryVerify!,
    },
    run,
  );
}

/** Read-only. Refuses before any effect unless everything the restart must restore is healthy now. */
export async function engineRestartPreflight(
  plan: EngineRestartConfiguration,
  dependencies: EngineRestartDependencies = {},
): Promise<EngineRestartPreflight> {
  const run = dependencies.run ?? defaultRun;
  const refuse = (detail: string): never => {
    throw new Error(`Docker restart preflight failed: ${detail}. Nothing was restarted.`);
  };
  try {
    await engineAnswers(plan, run);
  } catch {
    refuse("the Docker engine did not answer");
  }
  const startedAt = {} as EngineRestartPreflight["startedAt"];
  for (const key of Object.keys(CONTAINER_LABELS) as (keyof typeof CONTAINER_LABELS)[]) {
    let state: ContainerState;
    try {
      state = await inspectContainer(plan, run, plan.containers[key]);
    } catch {
      return refuse(`the ${CONTAINER_LABELS[key]} was not found`);
    }
    if (state.id !== plan.containers[key]) refuse(`the ${CONTAINER_LABELS[key]} ID changed`);
    if (!state.running) refuse(`the ${CONTAINER_LABELS[key]} is not running`);
    if (key === "dev" && state.health !== "healthy") refuse("the Dev container is not healthy");
    startedAt[key] = state.startedAt;
  }
  let factoryEpoch: number | null = null;
  let factorySupervisorPid: number | null = null;
  if (plan.factoryVerify) {
    const result = await runFactoryVerify(plan, run);
    if (!result.ok) refuse(`Factory lock acceptance check "${result.check}" failed`);
    factoryEpoch = result.epoch ?? null;
    factorySupervisorPid = result.supervisorPid ?? null;
  }
  return { startedAt, factoryEpoch, factorySupervisorPid };
}

/** The only effect. Docker Desktop restarts its VM; containers return through their restart policy. */
export async function restartDockerEngine(
  plan: EngineRestartConfiguration,
  dependencies: EngineRestartDependencies = {},
): Promise<void> {
  const run = dependencies.run ?? defaultRun;
  const seconds = plan.deadlineSeconds ?? DEFAULT_DEADLINE_SECONDS;
  try {
    await run(
      plan.docker,
      ["desktop", "restart", "--timeout", String(seconds)],
      seconds * 1000 + 5000,
    );
  } catch {
    throw new Error(
      "Docker Desktop did not confirm its restart. Inspect Docker Desktop before any new request; nothing will be retried.",
    );
  }
}

/**
 * Bounded and read-only. Each pinned container must run again under its same ID with a
 * new start time, and Dev must be healthy, which covers its Tailscale and daemon.
 */
export async function awaitEngineReadiness(
  plan: EngineRestartConfiguration,
  preflight: EngineRestartPreflight,
  dependencies: EngineRestartDependencies = {},
): Promise<string[]> {
  const run = dependencies.run ?? defaultRun;
  const sleep = dependencies.sleep ?? ((ms: number) => delay(ms));
  const now = dependencies.now ?? Date.now;
  const seconds = plan.deadlineSeconds ?? DEFAULT_DEADLINE_SECONDS;
  const deadline = now() + seconds * 1000;
  let unmet = "the Docker engine answers";
  while (now() < deadline) {
    unmet = await readinessGap(plan, preflight, run);
    if (!unmet)
      return [
        "Docker engine answered",
        ...Object.values(CONTAINER_LABELS).map((label) => `${label} restarted under its pinned ID`),
        "Dev container healthy",
      ];
    await sleep(5000);
  }
  throw new Error(
    `Docker restarted, but ${unmet} was not met within ${seconds} s. Dev turns stay held until Dev answers; nothing will be retried.`,
  );
}

async function readinessGap(
  plan: EngineRestartConfiguration,
  preflight: EngineRestartPreflight,
  run: EngineCommand,
): Promise<string> {
  try {
    await engineAnswers(plan, run);
  } catch {
    return "the Docker engine answers";
  }
  for (const key of Object.keys(CONTAINER_LABELS) as (keyof typeof CONTAINER_LABELS)[]) {
    const label = CONTAINER_LABELS[key];
    let state: ContainerState;
    try {
      state = await inspectContainer(plan, run, plan.containers[key]);
    } catch {
      return `the ${label} exists`;
    }
    if (state.id !== plan.containers[key] || !state.running) return `the ${label} runs`;
    if (state.startedAt === preflight.startedAt[key]) return `the ${label} restarted`;
    if (key === "dev" && state.health !== "healthy") return "the Dev container is healthy";
  }
  return "";
}

/** After Dev answers: Factory's launcher accepted its lock on this boot, with a newer epoch. */
export async function verifyFactoryAfterRestart(
  plan: EngineRestartConfiguration,
  preflight: EngineRestartPreflight,
  dependencies: EngineRestartDependencies = {},
): Promise<string | null> {
  if (!plan.factoryVerify) return null;
  const result = await runFactoryVerify(plan, dependencies.run ?? defaultRun);
  if (!result.ok)
    throw new Error(
      `Docker restarted and Dev answers, but Factory lock acceptance check "${result.check}" failed. Factory recovery is required; nothing will be retried.`,
    );
  if (
    preflight.factoryEpoch !== null &&
    (result.epoch === undefined || result.epoch <= preflight.factoryEpoch)
  )
    throw new Error(
      "Docker restarted, but Factory's controller epoch did not advance. Factory recovery is required; nothing will be retried.",
    );
  // The container entry re-ran, so Factory's supervisor must be a new process.
  if (
    preflight.factorySupervisorPid !== null &&
    result.supervisorPid === preflight.factorySupervisorPid
  )
    throw new Error(
      "Docker restarted, but Factory's supervisor did not change. Factory recovery is required; nothing will be retried.",
    );
  return `Factory accepted its lock (epoch ${result.epoch ?? "unknown"})`;
}
