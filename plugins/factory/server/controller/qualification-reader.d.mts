import type {
  QualificationInputs,
  QualificationSnapshot,
  QualificationSource,
} from "./qualification.mjs";
export interface FactoryQualificationPolicy {
  config: { repository: string; baseBranch: "dev" };
  configSha256: string;
}
export interface FactoryQualificationInventoryEntry {
  path: string;
  blob: string;
  mode: "100644" | "100755";
}
export interface FactoryQualificationSelectedSource {
  path: string;
  reason: string;
}
export interface FactoryQualificationSelectionInput {
  repository: string;
  commit: string;
  /** Original GitHub JSON, not a grant of scope or readiness. */
  issue: unknown;
  inventory: FactoryQualificationInventoryEntry[];
  signal?: AbortSignal;
}
export interface FactoryQualificationScopeInput {
  repository: string;
  issue: unknown;
  sourceInputs: QualificationSource[];
}
export interface FactoryQualificationGitOptions {
  env: NodeJS.ProcessEnv;
  encoding: "buffer";
  timeout: number;
  maxBuffer: number;
  signal?: AbortSignal;
}
export interface FactoryQualificationGitResult {
  stdout: Buffer;
}
export interface FactoryQualificationReaderOptions {
  authority: { assertCurrent(): void };
  repositoryRoot: string;
  policy: FactoryQualificationPolicy;
  sourcePaths?: string[];
  resolveSourcePaths?(
    input: FactoryQualificationSelectionInput,
  ): Promise<FactoryQualificationSelectedSource[]>;
  selectorPolicySha256?: string;
  standingScope?: string;
  authorizeScope(input: FactoryQualificationScopeInput): Promise<boolean>;
  readyLabel?: string;
  request?(method: "GET", endpoint: string): Promise<unknown>;
  executeGit?(
    command: "git",
    args: string[],
    options: FactoryQualificationGitOptions,
  ): Promise<FactoryQualificationGitResult>;
}
export interface FactoryQualificationDocument {
  id: string;
  sha256: string;
  text: string;
}
export interface FactoryQualificationPacket {
  input: QualificationInputs;
  snapshot: QualificationSnapshot;
  documents: FactoryQualificationDocument[];
  sourceCommit: string;
  inputSha256: string;
}
export interface FactoryQualificationReader {
  capture(issueNumber: number, signal?: AbortSignal): Promise<FactoryQualificationPacket>;
  readInputs(snapshot: QualificationSnapshot): Promise<QualificationInputs>;
}
export function createFactoryQualificationReader(
  input: FactoryQualificationReaderOptions,
): FactoryQualificationReader;
