import type { AgentTaskItem, AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import type {
  AgentSnapshotPayload,
  SessionOutboundMessage,
  WSOutboundMessage,
} from "@getpaseo/protocol/messages";

// COMPAT(checklistBlockedStatus): added in v0.11.0-beta.3.vorteo.254,
// remove after 2027-04-09 once the supported client floor accepts blocked tasks.
// Select actual checklist objects, never arbitrary tool results or plugin data.
export function serializeLegacyChecklistMessage(
  envelope: WSOutboundMessage,
  serialized?: string,
): string {
  const blocked = new Set<AgentTaskItem>();
  function tasks(items: readonly AgentTaskItem[] | null | undefined): void {
    for (const task of items ?? []) if (task.status === "blocked") blocked.add(task);
  }
  function agent(snapshot: AgentSnapshotPayload | null | undefined): void {
    tasks(snapshot?.tasks);
  }
  function timeline(item: AgentTimelineItem): void {
    if (item.type === "todo") tasks(item.items);
  }
  function snapshots(message: SessionOutboundMessage): void {
    switch (message.type) {
      case "status":
        if (
          message.payload.status === "agent_created" ||
          message.payload.status === "agent_resumed"
        )
          agent(message.payload.agent as AgentSnapshotPayload);
        break;
      case "agent_update":
        if (message.payload.kind === "upsert") agent(message.payload.agent);
        break;
      case "agent_status":
        agent(message.payload.info);
        break;
      case "clear_agent_attention_response":
        message.payload.agents.forEach(agent);
        break;
      case "fetch_agents_response":
      case "fetch_agent_history_response":
        message.payload.entries.forEach((entry) => agent(entry.agent));
        break;
      case "fetch_agent_response":
      case "cancel_agent_response":
      case "hub.execution.agent.create.response":
      case "hub.execution.agent.update":
      case "agent.create.update":
      case "workspace.create.update":
        agent(message.payload.agent);
        break;
    }
  }
  function lifecycle(message: SessionOutboundMessage): void {
    switch (message.type) {
      case "agent.create.response":
      case "workspace.create.response":
        agent(message.payload.agent);
        agent(message.payload.creation?.agent);
        break;
      case "creation.subscribe.response":
        agent(message.payload.snapshot?.agent);
        break;
      case "wait_for_finish_response":
        agent(message.payload.final);
        break;
    }
  }
  function checklists(message: SessionOutboundMessage): void {
    switch (message.type) {
      case "agent.checklist.get.response":
      case "agent.checklist.mutate.response":
        tasks(message.payload.tasks);
        break;
      case "fetch_agent_timeline_response":
        agent(message.payload.agent);
        message.payload.entries.forEach((entry) => timeline(entry.item));
        break;
      case "agent.provider_subagents.timeline.get.response":
        message.payload.rows.forEach((row) => timeline(row.item));
        break;
      case "agent.provider_subagents.update":
        if (message.payload.kind === "timeline") timeline(message.payload.item);
        break;
      case "agent_stream":
      case "hub.execution.agent.stream":
        if (message.payload.event.type === "timeline") timeline(message.payload.event.item);
        break;
    }
  }
  if (envelope.type === "session") {
    snapshots(envelope.message);
    lifecycle(envelope.message);
    checklists(envelope.message);
  }
  if (blocked.size === 0) return serialized ?? JSON.stringify(envelope);
  return JSON.stringify(envelope, (_key, value) =>
    blocked.has(value) ? { ...value, status: "pending", completed: false } : value,
  );
}
