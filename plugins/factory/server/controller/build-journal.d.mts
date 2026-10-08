/** Envelope only. The adopted coordinator validates each retained entry. */
export interface BuildJournalState {
  version: 1;
  repository: string;
  revision: number;
  active: Record<string, unknown> | null;
  requests: unknown[];
  releases: unknown[];
  externalReleases?: unknown[];
  failedReleases?: unknown[];
  retiredSourceReviews?: unknown[];
  [key: string]: unknown;
}

export interface BuildJournal {
  /** Explicit installation only; refuses an existing queue. */
  initialize(): Promise<void>;
  inspect(): Promise<BuildJournalState>;
  transact<Result>(
    effect: (
      state: BuildJournalState,
    ) =>
      | { state: BuildJournalState; result: Result }
      | Promise<{ state: BuildJournalState; result: Result }>,
  ): Promise<Result>;
}

export function openBuildJournal(input: {
  root: string;
  repository: string;
  authority: { assertCurrent(): void };
}): Promise<BuildJournal>;
