import type { QualificationDecision } from "./qualification.mjs";

export interface QualificationPublicationState {
  version: 1;
  decision: QualificationDecision;
  phase: "audit" | "label" | "complete";
  commentIntent: boolean;
  labelIntent: boolean;
  commentId: number | null;
}

export interface FactoryRecordAuthority {
  assertCurrent(): void;
}

export interface FactoryPrivateRecord<State> {
  inspect(): State | null;
  read(): Promise<State | null>;
  /** Requires a prior read and the same existing exclusive owner authority. */
  write(state: State): Promise<void>;
}

export interface FactoryPrivateRecordOptions<State> {
  root: string;
  name: string;
  authority: FactoryRecordAuthority;
  cap: number;
  validate(value: unknown): State;
}

export function openFactoryPrivateRecord<State>(
  input: FactoryPrivateRecordOptions<State>,
): FactoryPrivateRecord<State>;

export interface QualificationJournalOptions {
  root: string;
  receiptSha256: string;
  authority: FactoryRecordAuthority;
}

export function openQualificationJournal(
  input: QualificationJournalOptions,
): FactoryPrivateRecord<QualificationPublicationState>;
