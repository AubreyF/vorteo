import type { AgentProfile } from "@getpaseo/protocol/agent-profile";

/** null is an explicit uncapped policy, never an omitted/default limit. */
export function managedWorkerLimit(profile: AgentProfile): number | null {
  return profile.uncappedWorkers === true ? null : (profile.maxWorkers ?? 2);
}
