import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  AgentGoalSchema,
  AgentGoalSetInputSchema,
  type AgentGoal,
  type AgentGoalSetInput,
  type AgentGoalState,
} from "@getpaseo/protocol/agent-goals";

const GoalResponseSchema = z.object({ goal: AgentGoalSchema.nullable() });
const GoalUpdatedSchema = z.object({ threadId: z.string(), goal: AgentGoalSchema });
const GoalClearedSchema = z.object({ threadId: z.string() });

interface CodexGoalsOptions {
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  onChange: (state: AgentGoalState) => void;
}

/** Native notifications can overtake RPC responses, including a read started
 * before a clear. Revisions describe observation order, not native timestamps:
 * Codex timestamps have insufficient resolution to order concurrent updates. */
export class CodexGoals {
  private threadId: string | null = null;
  private revision = 0;
  private editRevision = randomUUID();
  private mutationTail: Promise<unknown> = Promise.resolve();
  private current: AgentGoalState = { status: "loading", goal: null };

  constructor(private readonly options: CodexGoalsOptions) {}

  get state(): AgentGoalState {
    return this.current;
  }

  bind(threadId: string | null): void {
    if (threadId === this.threadId) return;
    this.threadId = threadId;
    this.revision += 1;
    this.publish({ status: "loading", goal: null });
  }

  invalidate(message: string): void {
    this.revision += 1;
    this.publish({ status: "error", goal: this.current.goal, message });
  }

  async read(): Promise<AgentGoalState> {
    // A read started during a write can observe the previous native state. It
    // must not overtake the write and make its successful response look stale.
    await this.mutationTail;
    return this.readCurrent();
  }

  // Called inside mutations too, so it must not wait on mutationTail.
  private async readCurrent(): Promise<AgentGoalState> {
    const threadId = this.threadId;
    if (!threadId) {
      this.accept(null);
      return this.current;
    }
    const revision = this.revision;
    try {
      const response = GoalResponseSchema.parse(
        await this.options.request("thread/goal/get", { threadId }),
      );
      if (response.goal && response.goal.threadId !== threadId) {
        throw new Error("Codex returned a goal for a different thread");
      }
      if (this.revision === revision) this.accept(response.goal);
    } catch (error) {
      if (this.revision === revision) {
        const message = error instanceof Error ? error.message : "Could not read the goal";
        this.invalidate(message);
      }
      throw error;
    }
    return this.current;
  }

  set(input: AgentGoalSetInput): Promise<AgentGoalState> {
    const parsed = AgentGoalSetInputSchema.parse(input);
    if (parsed.objective !== undefined && !parsed.objective.trim()) {
      return Promise.reject(new Error("The goal objective cannot be blank"));
    }
    return this.mutate("thread/goal/set", parsed);
  }

  clear(): Promise<AgentGoalState> {
    return this.mutate("thread/goal/clear", {});
  }

  handleNotification(method: string, params: unknown): boolean {
    if (method === "thread/goal/updated") {
      const notification = GoalUpdatedSchema.parse(params);
      if (notification.threadId === this.threadId) {
        if (notification.goal.threadId !== this.threadId) {
          throw new Error("Codex goal notification has mismatched thread identities");
        }
        this.accept(notification.goal);
      }
      return true;
    }
    if (method === "thread/goal/cleared") {
      const notification = GoalClearedSchema.parse(params);
      if (notification.threadId === this.threadId) this.accept(null);
      return true;
    }
    return false;
  }

  private mutate(method: string, input: Record<string, unknown>): Promise<AgentGoalState> {
    const threadId = this.threadId;
    const operation = this.mutationTail.then(async () => {
      if (!threadId || this.threadId !== threadId) {
        throw new Error("The goal's native session is no longer available");
      }
      // Invalidate reads started before this mutation. Overlapping native
      // notifications need a post-write read to establish the final state.
      const revision = ++this.revision;
      // Even a same-value owner write invalidates an earlier edit observation.
      this.editRevision = randomUUID();
      try {
        const raw = await this.options.request(method, { threadId, ...input });
        let goal: AgentGoal | null = null;
        if (method === "thread/goal/set") {
          goal = z.object({ goal: AgentGoalSchema }).parse(raw).goal;
          if (goal.threadId !== threadId) throw new Error("Codex returned the wrong goal thread");
        } else {
          z.object({ cleared: z.boolean() }).parse(raw);
        }
        if (this.revision === revision) this.accept(goal);
        else if (this.threadId === threadId) {
          // Usage notifications can report the pre-write status while a native
          // pause succeeds. Confirm after the write instead of guessing which
          // overlapping notification or response represents the final state.
          await this.readCurrent();
        }
        return this.current;
      } catch (error) {
        if (this.revision === revision) {
          this.invalidate("Goal update could not be confirmed. Refresh before trying again.");
        }
        throw error;
      }
    });
    // Keep the queue usable after a failed operation, without replaying it.
    this.mutationTail = operation.catch(() => {});
    return operation;
  }

  private accept(goal: AgentGoal | null): void {
    this.revision += 1;
    const previous = this.current.goal;
    if (
      this.current.status !== "ready" ||
      !previous ||
      !goal ||
      (["threadId", "objective", "status", "tokenBudget", "createdAt"] as const).some(
        (key) => previous[key] !== goal[key],
      )
    )
      this.editRevision = randomUUID();
    this.publish({
      status: "ready",
      goal,
      observedAt: new Date().toISOString(),
      editRevision: this.editRevision,
    });
  }

  private publish(state: AgentGoalState): void {
    this.current = state;
    this.options.onChange(state);
  }
}
