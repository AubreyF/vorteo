import { z } from "zod";
import equal from "fast-deep-equal";
import { mutateChecklist } from "@getpaseo/protocol/checklist-model";
import { AgentTaskItemSchema, type ChecklistMutation } from "@getpaseo/protocol/task-checklist";
import type { AgentTaskItem } from "@getpaseo/protocol/agent-types";

const SnapshotSchema = z.object({
  version: z.literal(1),
  sequence: z
    .number()
    .int()
    .min(0)
    .max(Number.MAX_SAFE_INTEGER - 1),
  agents: z
    .array(z.object({ id: z.string(), tasks: z.array(AgentTaskItemSchema).max(500) }))
    .max(6),
});
export type DemoChecklistSnapshot = z.infer<typeof SnapshotSchema>;
export interface DemoChecklistPersistence {
  load(): unknown;
  save(snapshot: DemoChecklistSnapshot): void;
}

// Editor snapshots cross JSON transport, which omits undefined optional fields.
const wireEqual = (left: unknown, right: unknown) =>
  equal(JSON.parse(JSON.stringify(left)), JSON.parse(JSON.stringify(right)));

export class DemoChecklistState {
  private tasks: Map<string, AgentTaskItem[]>;
  private sequence = 0;

  constructor(
    private readonly initial: { id: string; tasks?: AgentTaskItem[] }[],
    private readonly persistence?: DemoChecklistPersistence,
  ) {
    this.tasks = this.fixtures();
    try {
      const saved = persistence?.load();
      if ((JSON.stringify(saved)?.length ?? 0) > 1_048_576) return;
      const parsed = SnapshotSchema.safeParse(saved);
      if (!parsed.success) return;
      const restored = new Map<string, AgentTaskItem[]>();
      for (const agent of parsed.data.agents) {
        if (!this.tasks.has(agent.id) || restored.has(agent.id)) return;
        const ids = new Set(agent.tasks.map((task) => task.id));
        if (ids.size !== agent.tasks.length) return;
        for (const task of agent.tasks) {
          if (
            !task.id ||
            task.source !== "vorteo" ||
            task.completed !== (task.status === "completed")
          )
            return;
          // Reuse dependency and cycle validation without changing task status.
          mutateChecklist(
            agent.tasks,
            { operation: "update", id: task.id },
            { createId: () => "", equal: wireEqual },
          );
        }
        restored.set(agent.id, agent.tasks);
      }
      this.tasks = new Map([...this.tasks, ...restored]);
      this.sequence = parsed.data.sequence;
    } catch {
      // Invalid or inaccessible demo storage falls back to the sample catalog.
    }
  }

  private fixtures() {
    return new Map(this.initial.map((agent) => [agent.id, agent.tasks ?? []]));
  }

  read(agentId: string): AgentTaskItem[] {
    const tasks = this.tasks.get(agentId);
    if (!tasks) throw new Error("Demo thread not found.");
    return tasks;
  }

  mutate(agentId: string, mutation: ChecklistMutation): AgentTaskItem[] {
    const sequence = this.sequence + 1;
    const current = this.read(agentId);
    const tasks = mutateChecklist(current, mutation, {
      createId: () => `demo-task-created-${sequence}`,
      equal: wireEqual,
    });
    const next = new Map(this.tasks).set(agentId, tasks);
    this.save(next, sequence);
    this.tasks = next;
    this.sequence = sequence;
    return tasks;
  }

  reset(): void {
    const next = this.fixtures();
    this.save(next, 0);
    this.tasks = next;
    this.sequence = 0;
  }

  private save(tasks: Map<string, AgentTaskItem[]>, sequence: number): void {
    const snapshot = SnapshotSchema.parse({
      version: 1,
      sequence,
      agents: [...tasks].map(([id, items]) => ({ id, tasks: items })),
    });
    if (JSON.stringify(snapshot).length > 1_048_576)
      throw new Error("This checklist exceeds the demo storage limit.");
    try {
      this.persistence?.save(snapshot);
    } catch {
      throw new Error(
        "The demo could not save this checklist in browser storage. Check available space and storage access, then retry.",
      );
    }
  }
}
