export const JOURNAL_SEEN_DWELL_MS = 800;

export function journalSeenKey(serverId: string, agentId: string): string {
  return `journal-seen:${JSON.stringify([serverId, agentId])}`;
}

export function parseSeenEntries(value: string | null): string[] {
  if (value === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    if (error instanceof SyntaxError) return [];
    throw error;
  }
  if (!Array.isArray(parsed) || !parsed.every((id): id is string => typeof id === "string")) {
    return [];
  }
  return parsed;
}

export function rememberSeenEntries(
  previous: readonly string[],
  entries: readonly string[],
): string[] {
  return [...new Set([...previous, ...entries])];
}

/** Visibility losses reset the dwell; each observer lifetime reports an entry at most once. */
export function createSeenDwell(onSeen: (id: string) => void) {
  const started = new Map<string, number>();
  const reported = new Set<string>();
  return {
    update(id: string, visible: boolean, now: number) {
      if (reported.has(id)) return;
      if (!visible) {
        started.delete(id);
        return;
      }
      const since = started.get(id);
      if (since === undefined) {
        started.set(id, now);
        return;
      }
      if (now - since < JOURNAL_SEEN_DWELL_MS) return;
      reported.add(id);
      started.delete(id);
      onSeen(id);
    },
  };
}
