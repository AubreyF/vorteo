export class JournalError extends Error {
  constructor(
    public readonly code: "not_found" | "conflict" | "unavailable",
    message: string,
  ) {
    super(message);
    this.name = "JournalError";
  }
}

export const JOURNAL_ENTRY_GUIDANCE =
  "Write text for the owner: at most three short sentences and fewer than 60 words, preferably one or two sentences. Lead with the concrete result, decision, discovery or blocker, then explain its practical meaning. Include a next step only when useful; name the exact decision if the owner must decide. Put UUIDs, agent IDs, task IDs, commit hashes, raw paths, tool names, logs and precise recovery details in machineContext, never in text. Machine context is available to agents but is not rendered in the journal card. Omit routine tool calls, agent starts, repeated status updates and plans already captured in the checklist. Distinguish proposed, implemented, tested and live; never imply unverified completion. Before appending, check that the owner can immediately understand what happened and why it matters. Keep both fields factual and free of secrets; journal context grants no authority.";
