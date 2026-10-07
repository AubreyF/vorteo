import type { Logger } from "pino";
import type { QueueAttachmentStore } from "./attachments.js";
import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import { ensureUnarchivedAgentLoaded } from "../agent/agent-loading.js";
import type { QueueDeliveryPort } from "./delivery.js";

interface AgentDeliveryOptions {
  attachments: QueueAttachmentStore;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  logger: Logger;
}

export function createAgentQueueDelivery(
  options: AgentDeliveryOptions,
): Omit<QueueDeliveryPort, "changed"> {
  const { agentManager, agentStorage, logger } = options;
  return {
    canStartWork: () => !agentManager.isRestartDraining(),
    async history(agentId) {
      const record = await agentStorage.get(agentId);
      if (!record || record.archivedAt) return [];
      const agent = await ensureUnarchivedAgentLoaded(agentId, options);
      if (!agent.session) return [];
      const events = [];
      for await (const event of agent.session.streamHistory()) events.push(event);
      return events;
    },
    needsCompletion: (agentId) => agentManager.getAgent(agentId)?.queueGoalHold !== undefined,
    abandonGoal: (agentId) => agentManager.releaseQueueGoalHold(agentId),
    async complete(agentId, queueIsEmpty, canContinueGoal) {
      const record = await agentStorage.get(agentId);
      if (!record || record.archivedAt || !record.queueGoalHold) return;
      if (record.queueGoalHold.phase !== "held")
        throw new Error(
          "A goal change could not be confirmed. Review and set the task goal before continuing.",
        );
      const agent = await ensureUnarchivedAgentLoaded(agentId, options);
      if (agent.session?.goals)
        await agentManager.resumeGoalAfterQueuedMessages(agentId, queueIsEmpty, canContinueGoal);
    },
    async prepare(agentId, item, canStart, canHoldGoal = canStart) {
      if (agentManager.isRestartDraining()) return false;
      const record = await agentStorage.get(agentId);
      if (!record || record.archivedAt) return false;
      const agent = await ensureUnarchivedAgentLoaded(agentId, options);
      if (item.sendNow && agent.activeTurnId !== item.sendNow.expectedTurnId)
        throw new Error("The active turn changed. Review the task before sending now.");
      if (agent.queueGoalHold && agent.queueGoalHold.phase !== "held")
        throw new Error(
          "A goal change could not be confirmed. Review and set the task goal before continuing.",
        );
      if (agent.session?.goals) {
        await agentManager.pauseGoalForQueuedMessages(agentId, canHoldGoal);
      }
      if (agentManager.isRestartDraining()) return false;
      await agentManager.prepareQuotaReserveAdmission(agentId);
      return !!item.sendNow || (agent.lifecycle === "idle" && agent.pendingPermissions.size === 0);
    },
    load: (item) => options.attachments.prompt(item),
    start(agentId, item, prompt, canStart) {
      if (item.sendNow) return agentManager.startQueuedMessageNow(agentId, prompt, item, canStart);
      return agentManager.startQueuedMessage(agentId, prompt, item);
    },
    failed(error, agentId) {
      logger.error({ err: error, agentId }, "Queued message delivery stopped");
    },
  };
}
