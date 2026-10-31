import { promises as fs } from "node:fs";
import type { Logger } from "pino";
import { z } from "zod";
import type { MutableDaemonConfig, ProviderUsage } from "@getpaseo/protocol/messages";
import { resolveProviderType, sharedProfileId } from "@getpaseo/protocol/provider-preferences";
import type { ScheduleCadence } from "@getpaseo/protocol/schedule/types";

import { writeJsonFileAtomic } from "../atomic-file.js";
import type { ProviderSnapshotEntry } from "../agent/agent-sdk-types.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import type { BoundCreateAgentCommand } from "../agent/create-agent/create.js";
import type { ProviderSnapshotManager } from "../agent/provider-snapshot-manager.js";
import type { ScheduleService } from "../schedule/service.js";
import type { WorkspaceRegistry } from "../workspace-registry.js";
import {
  OPTIMIZER_FIRST_REVIEW_PROMPT,
  OPTIMIZER_REVIEW_PROMPT,
  optimizerCharter,
} from "./optimizer-charter.js";
import {
  OPTIMIZER_ROLE,
  rolesForEnvironment,
  systemPaths,
  type SystemEnvironment,
} from "./manifest.js";

/** Marks the agent the daemon created, so a lost state file never leads to a second one. */
export const OPTIMIZER_AGENT_LABEL = "vorteo.system-agent";
export const OPTIMIZER_AGENT_TITLE = "Optimizer";
export const OPTIMIZER_SCHEDULE_NAME = "Optimizer review";
/** Daily at 09:00 in the daemon's time zone. */
export const OPTIMIZER_REVIEW_CRON = "0 9 * * *";
// Provider snapshots change in bursts while catalogs load; evaluate once they settle.
const EVALUATE_DEBOUNCE_MS = 2_000;

const OptimizerStateSchema = z
  .object({
    optimizer: z
      .object({
        agentId: z.string().min(1),
        createdAt: z.string(),
        scheduleId: z.string().min(1).optional(),
      })
      .optional(),
  })
  .passthrough();
type OptimizerState = z.infer<typeof OptimizerStateSchema>;

export interface OptimizerAgentInput {
  paseoHome: string;
  environment: SystemEnvironment;
  workspaceRegistry: Pick<WorkspaceRegistry, "list">;
  agentStorage: Pick<AgentStorage, "list" | "get">;
  providers: Pick<ProviderSnapshotManager, "listProviders" | "on" | "off">;
  readUsage: (options: { forceRefresh: boolean }) => Promise<{ providers: ProviderUsage[] }>;
  getSettings: () => MutableDaemonConfig;
  onSettingsChange: (handler: () => void) => () => void;
  createAgent: BoundCreateAgentCommand;
  schedules: Pick<ScheduleService, "create">;
  logger: Logger;
  timeZone?: string;
}

interface Launch {
  provider: string;
  profileId?: string;
}

/**
 * Creates the one Optimizer agent in the Optimizer workspace once a provider is usable,
 * then gives it a daily review heartbeat. Runs on daemons whose manifest has the
 * Optimizer role (Host and single installs). The daemon records the agent in
 * `system/state.json` and never creates another, even after the owner archives or
 * deletes it. Without a usable provider it waits quietly for provider or settings changes.
 */
export function startOptimizerAgent(input: OptimizerAgentInput): { stop: () => void } {
  if (!rolesForEnvironment(input.environment).some((role) => role.role === OPTIMIZER_ROLE)) {
    return { stop: () => {} };
  }
  const logger = input.logger.child({ module: "system-optimizer" });
  let stopped = false;
  let running: Promise<void> | null = null;
  let rerun = false;
  let timer: NodeJS.Timeout | null = null;
  let lastReady = "";
  let firstRun = true;

  const stop = () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    input.providers.off("change", onProvidersChange);
    stopSettings();
  };

  const evaluate = async (): Promise<void> => {
    const done = await ensureOptimizerAgent(input, logger, {
      wait: firstRun,
      // A new ready set usually means a new connection, whose sign in the cached usage predates.
      refreshUsage: (ready) => {
        const changed = !firstRun && ready !== lastReady;
        lastReady = ready;
        return changed;
      },
    });
    firstRun = false;
    if (done) stop();
  };

  const run = () => {
    if (stopped) return;
    if (running) {
      rerun = true;
      return;
    }
    running = evaluate()
      .catch((error) => logger.warn({ err: error }, "Optimizer agent setup will retry later"))
      .finally(() => {
        running = null;
        if (rerun && !stopped) {
          rerun = false;
          run();
        }
      });
  };

  const schedule = () => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(run, EVALUATE_DEBOUNCE_MS);
    timer.unref?.();
  };
  const onProvidersChange = () => schedule();

  input.providers.on("change", onProvidersChange);
  const stopSettings = input.onSettingsChange(schedule);
  run();
  return { stop };
}

/** One pass. Returns true once nothing is left to do on this daemon. */
async function ensureOptimizerAgent(
  input: OptimizerAgentInput,
  logger: Logger,
  options: { wait: boolean; refreshUsage: (readyKey: string) => boolean },
): Promise<boolean> {
  const statePath = systemPaths(input.paseoHome).state;
  const state = await readState(statePath, logger);
  if (state === null) return true;
  if (state.optimizer) return ensureSchedule(input, statePath, state, logger);

  const workspace = (await input.workspaceRegistry.list()).find(
    (candidate) => candidate.systemMembership?.role === OPTIMIZER_ROLE && !candidate.archivedAt,
  );
  if (!workspace) return false;

  const labelled = (await input.agentStorage.list()).find(
    (record) => record.labels?.[OPTIMIZER_AGENT_LABEL] === OPTIMIZER_ROLE,
  );
  if (labelled) {
    const next = { ...state, optimizer: { agentId: labelled.id, createdAt: labelled.createdAt } };
    await writeJsonFileAtomic(statePath, next);
    return ensureSchedule(input, statePath, next, logger);
  }

  const entries = await input.providers.listProviders({ wait: options.wait });
  const ready = entries.filter((entry) => entry.enabled && entry.status === "ready");
  if (ready.length === 0) return false;
  const usage = await input.readUsage({
    forceRefresh: options.refreshUsage(ready.map((entry) => entry.provider).join(",")),
  });
  const settings = input.getSettings();
  const providers = usableProviders(ready, usage.providers, settings);
  if (providers.length === 0) return false;

  const agentId = await createOptimizerAgent(input, logger, {
    workspace,
    launch: selectLaunch(providers[0]!, settings),
    statePath,
    state,
  });
  if (!agentId) return false;
  return ensureSchedule(input, statePath, await readState(statePath, logger), logger);
}

/**
 * Providers that can run the Optimizer, best first. A Claude or Codex connection whose
 * usage reading shows a working sign in comes first; a ready provider the daemon reads no
 * usage for comes next; a ready one whose reading shows no sign in is left out. The
 * installation's default provider leads within each group.
 */
function usableProviders(
  ready: readonly ProviderSnapshotEntry[],
  usage: readonly ProviderUsage[],
  settings: MutableDaemonConfig,
): string[] {
  const signedIn: string[] = [];
  const unmetered: string[] = [];
  for (const entry of ready) {
    const reading = usage.find((item) => item.providerId === entry.provider);
    if (!reading) unmetered.push(entry.provider);
    else if (reading.status === "available" && !reading.authRecovery) signedIn.push(entry.provider);
  }
  const preferred = settings.sharedProviderPreferences?.defaultProvider;
  const byDefault = (left: string, right: string) =>
    Number(right === preferred) - Number(left === preferred);
  return [...signedIn.sort(byDefault), ...unmetered.sort(byDefault)];
}

/**
 * The account's default workflow when its provider type has one, then the default local
 * profile for that provider, then the provider's own defaults.
 */
function selectLaunch(provider: string, settings: MutableDaemonConfig): Launch {
  const providerType = safeProviderType(provider, settings);
  const workflowId =
    settings.sharedProviderPreferences?.providers[providerType]?.defaultWorkflowId ?? null;
  if (workflowId) return { provider, profileId: sharedProfileId(providerType, workflowId) };
  const profile = settings.agentProfiles?.find(
    (candidate) => candidate.isDefault && candidate.provider === provider,
  );
  return profile ? { provider, profileId: profile.id } : { provider };
}

function safeProviderType(provider: string, settings: MutableDaemonConfig): string {
  try {
    return resolveProviderType(provider, settings.providers ?? {});
  } catch {
    return provider;
  }
}

async function createOptimizerAgent(
  input: OptimizerAgentInput,
  logger: Logger,
  target: {
    workspace: { workspaceId: string; cwd: string };
    launch: Launch;
    statePath: string;
    state: OptimizerState;
  },
): Promise<string | null> {
  const attempts: Launch[] = target.launch.profileId
    ? [target.launch, { provider: target.launch.provider }]
    : [target.launch];
  for (const launch of attempts) {
    // An object, so the narrowing after the awaited callback stays honest.
    const created: { id: string | null } = { id: null };
    try {
      await input.createAgent({
        kind: "mcp",
        provider: launch.provider,
        ...(launch.profileId ? { profileId: launch.profileId } : {}),
        title: OPTIMIZER_AGENT_TITLE,
        cwd: target.workspace.cwd,
        workspaceId: target.workspace.workspaceId,
        config: { systemPrompt: optimizerCharter({ paseoHome: input.paseoHome }) },
        labels: { [OPTIMIZER_AGENT_LABEL]: OPTIMIZER_ROLE },
        initialPrompt: OPTIMIZER_FIRST_REVIEW_PROMPT,
        promptFailure: "log",
        background: true,
        notifyOnFinish: false,
        // Recorded before the first prompt runs, so no later failure can lead to a second agent.
        onCreated: async ({ agentId }) => {
          created.id = agentId;
          await writeJsonFileAtomic(target.statePath, {
            ...target.state,
            optimizer: { agentId, createdAt: new Date().toISOString() },
          });
        },
      });
    } catch (error) {
      if (created.id) return created.id;
      logger.warn(
        { err: error, provider: launch.provider, profileId: launch.profileId },
        "Could not create the Optimizer agent with this launch",
      );
      continue;
    }
    if (created.id) {
      logger.info(
        { agentId: created.id, provider: launch.provider, profileId: launch.profileId },
        "Created the Optimizer agent",
      );
      return created.id;
    }
  }
  return null;
}

/** Gives the recorded agent its review heartbeat once, while the agent is still active. */
async function ensureSchedule(
  input: OptimizerAgentInput,
  statePath: string,
  state: OptimizerState | null,
  logger: Logger,
): Promise<boolean> {
  const optimizer = state?.optimizer;
  if (!state || !optimizer || optimizer.scheduleId) return true;
  const agent = await input.agentStorage.get(optimizer.agentId);
  // Archived or deleted by the owner: leave it that way.
  if (!agent || agent.archivedAt) return true;
  const schedule = await input.schedules.create({
    name: OPTIMIZER_SCHEDULE_NAME,
    prompt: OPTIMIZER_REVIEW_PROMPT,
    cadence: reviewCadence(input.timeZone),
    target: { type: "agent", agentId: optimizer.agentId },
  });
  await writeJsonFileAtomic(statePath, {
    ...state,
    optimizer: { ...optimizer, scheduleId: schedule.id },
  });
  logger.info(
    { agentId: optimizer.agentId, scheduleId: schedule.id, cron: OPTIMIZER_REVIEW_CRON },
    "Scheduled the Optimizer review",
  );
  return true;
}

function reviewCadence(timeZone: string | undefined): ScheduleCadence {
  const zone = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  return {
    type: "cron",
    expression: OPTIMIZER_REVIEW_CRON,
    ...(zone ? { timezone: zone } : {}),
  };
}

/** The recorded state, `{}` when there is none, or null when the file is damaged. */
async function readState(filePath: string, logger: Logger): Promise<OptimizerState | null> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  let parsed: ReturnType<typeof OptimizerStateSchema.safeParse>;
  try {
    parsed = OptimizerStateSchema.safeParse(JSON.parse(raw));
  } catch {
    parsed = OptimizerStateSchema.safeParse(null);
  }
  if (parsed.success) return parsed.data;
  // Overwriting it could forget an agent the daemon already created, so stop instead.
  logger.warn({ filePath }, "Vorteo System state is damaged; the Optimizer agent is not created");
  return null;
}
