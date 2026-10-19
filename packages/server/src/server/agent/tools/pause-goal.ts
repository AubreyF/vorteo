import { z } from "zod";
import { AgentGoalStateSchema } from "@getpaseo/protocol/agent-goals";
import type { AgentManager } from "../agent-manager.js";
import type { PaseoToolDefinition } from "./types.js";

export function createPauseGoalTool(
  manager: Pick<AgentManager, "readAgentGoal" | "setAgentGoal">,
  callerAgentId: string,
): PaseoToolDefinition {
  return {
    name: "pause_goal",
    title: "Pause your goal",
    description:
      "Pause automatic continuation of your own goal when the user asks you to stop, pause, or hand off the goal. " +
      "Call this before acknowledging that you have stopped, including when an automatic continuation arrives after a user stop request. " +
      "Saying you have stopped does not pause the goal. Use this tool even if the native update_goal tool cannot pause goals. " +
      "Only use it for a user request to stop goal work, not a request to stop one command or change approach. " +
      "The current turn remains available to finish a requested handoff. This does not mark the objective complete or resume it.",
    inputSchema: z.object({}).strict(),
    outputSchema: { state: AgentGoalStateSchema },
    handler: async () => {
      const current = await manager.readAgentGoal(callerAgentId);
      if (current.status !== "ready") {
        throw new Error("Could not confirm the current goal. Do not claim it is paused.");
      }
      const shouldPause =
        current.goal?.status === "active" ||
        current.goal?.status === "blocked" ||
        current.goal?.status === "paused";
      // Reassert an existing pause so the manager releases any message-queue
      // hold that would otherwise resume the goal when queued work finishes.
      const state = shouldPause
        ? await manager.setAgentGoal(callerAgentId, { status: "paused" })
        : current;
      const stillContinuable = state.goal?.status === "active" || state.goal?.status === "blocked";
      if (state.status !== "ready" || stillContinuable) {
        throw new Error("Goal pause could not be confirmed. Do not claim it is paused.");
      }
      return { content: [], structuredContent: { state } };
    },
  };
}
