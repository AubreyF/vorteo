import type { AgentJournalEntry } from "@getpaseo/protocol/agent-journal";

export function journalViewKey(serverId: string, agentId: string): string {
  return `journal-cleared-through:${JSON.stringify([serverId, agentId])}`;
}

export function parseClearedThrough(value: string | null): number {
  const sequence = Number(value);
  return Number.isSafeInteger(sequence) && sequence >= 0 ? sequence : 0;
}

export function latestJournalSequence(entries: AgentJournalEntry[]): number {
  return entries.reduce((latest, entry) => Math.max(latest, entry.sequence), 0);
}

export function visibleJournalEntries(entries: AgentJournalEntry[], clearedThrough: number) {
  return entries.filter((entry) => entry.sequence > clearedThrough);
}
