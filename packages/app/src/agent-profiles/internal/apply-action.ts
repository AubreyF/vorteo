/**
 * What choosing a profile does. Drafts take the profile directly; legacy hosts can
 * only reconfigure the running provider. Launch-capable hosts start a successor task,
 * unless they can switch the thread's account in place.
 */
export type AgentProfileApplyAction = "draft" | "config" | "successor" | "switch";

export function agentProfileApplyAction(input: {
  target: "draft" | "agent";
  supportsLaunch: boolean;
  supportsSwitch: boolean;
}): AgentProfileApplyAction {
  if (input.target === "draft") return "draft";
  if (!input.supportsLaunch) return "config";
  return input.supportsSwitch ? "switch" : "successor";
}
