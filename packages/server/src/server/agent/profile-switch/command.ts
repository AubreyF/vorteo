import type {
  AgentProfileSwitchRequestMessage,
  MutableDaemonConfig,
} from "@getpaseo/protocol/messages";
import { ProfileSwitchError } from "../agent-manager.js";
import type { AgentSessionConfig } from "../agent-sdk-types.js";
import { buildConfigOverrides } from "../../persistence-hooks.js";
import type { ProviderSnapshotManager } from "../provider-snapshot-manager.js";
import {
  resolveProfileSwitchConfig,
  type CreateAgentCommandDependencies,
} from "../create-agent/create.js";
import { formatSwitchInstructions, readRecordedContext } from "./context.js";

export type ProfileSwitchTarget = Pick<
  AgentProfileSwitchRequestMessage,
  "agentId" | "provider" | "profileId" | "model" | "thinkingOptionId" | "reason"
>;

function describeAccount(
  settings: MutableDaemonConfig | undefined,
  provider: string,
  model: string | null | undefined,
): string {
  const label = settings?.providers?.[provider]?.label;
  const account = typeof label === "string" && label ? label : provider;
  return model ? `${account} (${model})` : account;
}

export async function switchAgentProfileCommand(
  dependencies: CreateAgentCommandDependencies & {
    providerSnapshotManager: Pick<
      ProviderSnapshotManager,
      "resolveCreateConfig" | "readSessionHistory"
    >;
  },
  target: ProfileSwitchTarget,
): Promise<void> {
  const { agentManager, agentStorage, providerSnapshotManager } = dependencies;
  await agentManager.waitForAgentClose(target.agentId);
  const record = await agentStorage.get(target.agentId);
  if (!record) throw new Error(`Agent not found: ${target.agentId}`);
  if (record.archivedAt)
    throw new ProfileSwitchError("Restore this thread before switching accounts.");
  if (record.internal || record.config?.controllerExecutionId)
    throw new ProfileSwitchError("This thread is managed by Vorteo and cannot switch accounts.");
  const live = agentManager.getAgent(target.agentId);
  const sourceConfig = live?.config ?? {
    ...buildConfigOverrides(record),
    provider: record.provider,
    cwd: record.cwd,
    title: record.title ?? undefined,
  };
  const history = record.persistence
    ? providerSnapshotManager.readSessionHistory(record.persistence, sourceConfig)
    : (async function* () {})();
  const storedSource = live
    ? undefined
    : {
        record,
        rows: await agentManager.readStoredSwitchHistory(record, history),
      };
  const context = storedSource
    ? readRecordedContext(storedSource.rows.map((row) => row.item))
    : await agentManager.readSwitchContext(target.agentId);
  const settings = dependencies.getSharedProviderConfig?.();
  const config: AgentSessionConfig = {
    provider: target.provider,
    cwd: record.cwd,
    title: sourceConfig.title,
    mcpServers: sourceConfig.mcpServers,
    systemPrompt: formatSwitchInstructions({
      from: describeAccount(
        settings,
        record.provider,
        live?.runtimeInfo?.model ?? sourceConfig.model,
      ),
      to: describeAccount(settings, target.provider, target.model),
      context,
    }),
    ...(target.profileId ? { profileId: target.profileId } : {}),
    ...(target.model ? { model: target.model } : {}),
    ...(target.thinkingOptionId ? { thinkingOptionId: target.thinkingOptionId } : {}),
  };
  await agentManager.switchAgentProfile(target.agentId, {
    storedSource,
    config: await resolveProfileSwitchConfig(dependencies, config),
    reason: target.reason ?? "manual",
    carriedContextChars: context.length,
  });
}
