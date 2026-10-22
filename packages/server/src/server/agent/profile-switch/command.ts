import type {
  AgentProfileSwitchRequestMessage,
  MutableDaemonConfig,
} from "@getpaseo/protocol/messages";
import type { AgentSessionConfig } from "../agent-sdk-types.js";
import { ensureUnarchivedAgentLoaded } from "../agent-loading.js";
import {
  resolveProfileSwitchConfig,
  type CreateAgentCommandDependencies,
} from "../create-agent/create.js";
import { formatSwitchInstructions } from "./context.js";

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
  dependencies: CreateAgentCommandDependencies,
  target: ProfileSwitchTarget,
): Promise<void> {
  const { agentManager, agentStorage, logger } = dependencies;
  const agent = await ensureUnarchivedAgentLoaded(target.agentId, {
    agentManager,
    agentStorage,
    logger,
  });
  const context = await agentManager.readSwitchContext(agent.id);
  const settings = dependencies.getSharedProviderConfig?.();
  const config: AgentSessionConfig = {
    provider: target.provider,
    cwd: agent.cwd,
    title: agent.config.title,
    mcpServers: agent.config.mcpServers,
    systemPrompt: formatSwitchInstructions({
      from: describeAccount(
        settings,
        agent.provider,
        agent.runtimeInfo?.model ?? agent.config.model,
      ),
      to: describeAccount(settings, target.provider, target.model),
      context,
    }),
    ...(target.profileId ? { profileId: target.profileId } : {}),
    ...(target.model ? { model: target.model } : {}),
    ...(target.thinkingOptionId ? { thinkingOptionId: target.thinkingOptionId } : {}),
  };
  await agentManager.switchAgentProfile(agent.id, {
    config: await resolveProfileSwitchConfig(dependencies, config),
    reason: target.reason ?? "manual",
    carriedContextChars: context.length,
  });
}
