import { createHash } from "node:crypto";
import path from "node:path";
import {
  InitialHostMigrationClaimSchema,
  InitialHostMigrationIntentSchema,
  InitialHostSupervisorMigrationPlanSchema,
  initialHostPublicationRecords,
} from "./host-supervisor-contract.js";

/** Captured by a protected reader. Only an independently conclusive missing-file
 * result may use absent; permission errors and unstable reads are inconclusive. */
export type HostRecoveryFileImage = { path: string } & (
  | { state: "present"; bytes: Uint8Array }
  | { state: "absent" }
  | { state: "inconclusive" }
);

/** Resolution is supplied by the caller's retained reader, never performed here. */
export type HostRecoverySelectorImage = { path: string } & (
  | { state: "present"; text: string; resolvedTarget: string }
  | { state: "absent" }
  | { state: "inconclusive" }
);

export interface InitialHostRecoveryImage {
  enrollmentStateDirectory: string;
  plan: HostRecoveryFileImage;
  intent: HostRecoveryFileImage;
  claim: HostRecoveryFileImage;
  launcher: HostRecoveryFileImage;
  phase: HostRecoveryFileImage;
  launcherAttempt: HostRecoveryFileImage;
  selectorAttempt: HostRecoveryFileImage;
  selector: HostRecoverySelectorImage;
}

function requireImage(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`Unproven initial Host publication image: ${message}`);
}

function sha256(bytes: Uint8Array | string) {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertPath(file: string) {
  requireImage(
    typeof file === "string" &&
      path.isAbsolute(file) &&
      path.normalize(file) === file &&
      !file.includes("\0") &&
      file !== "/",
    "noncanonical path",
  );
}

function assertFields(value: object, fields: string[]) {
  const keys = Object.keys(value);
  requireImage(
    keys.length === fields.length && keys.every((key) => fields.includes(key)),
    "ambiguous observation fields",
  );
}

function captureFile(image: HostRecoveryFileImage) {
  assertPath(image.path);
  requireImage(image.state !== "inconclusive", `inconclusive read: ${image.path}`);
  if (image.state === "absent") {
    assertFields(image, ["path", "state"]);
    return { path: image.path, state: "absent" as const };
  }
  requireImage(image.state === "present" && image.bytes instanceof Uint8Array, "invalid file read");
  assertFields(image, ["path", "state", "bytes"]);
  const bytes = Buffer.from(image.bytes);
  return {
    path: image.path,
    state: "present" as const,
    bytesBase64: bytes.toString("base64"),
    sha256: sha256(bytes),
  };
}

type CapturedFile = ReturnType<typeof captureFile>;

/** JSON.parse validates grammar first. This second pass rejects duplicate keys
 * (including escaped spellings) without restricting whitespace or key order. */
function parseUnambiguousJson(text: string): unknown {
  const value: unknown = JSON.parse(text);
  const tokens = text.match(/"(?:[^"\\]|\\.)*"|[{}[\]:,]/g) ?? [];
  const scopes: (Set<string> | null)[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === "{") scopes.push(new Set());
    else if (token === "[") scopes.push(null);
    else if (token === "}" || token === "]") scopes.pop();
    else if (token.startsWith('"') && tokens[index + 1] === ":") {
      const scope = scopes.at(-1);
      const key: string = JSON.parse(token);
      requireImage(scope && !scope.has(key), "duplicate JSON key");
      scope.add(key);
    }
  }
  return value;
}

function readRecord<T>(file: CapturedFile, parse: (value: unknown) => T, canonical = true): T {
  requireImage(file.state === "present", `missing original record: ${file.path}`);
  const bytes = Buffer.from(file.bytesBase64, "base64");
  const record = parse(
    parseUnambiguousJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
  );
  // Intent and claim writers guarantee this exact format. Addressed plans may
  // use any unambiguous JSON formatting; their actual bytes remain in snapshot.
  requireImage(
    !canonical || bytes.equals(Buffer.from(JSON.stringify(record))),
    "noncanonical original record",
  );
  return record;
}

function matchesRecord(file: CapturedFile, expected: { file: string; record: unknown }) {
  requireImage(file.path === expected.file, "addressed record path changed");
  if (file.state === "absent") return false;
  requireImage(
    file.bytesBase64 === Buffer.from(JSON.stringify(expected.record)).toString("base64"),
    "addressed record bytes changed",
  );
  return true;
}

function freeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Pure image classification, not custody or effect admission. The caller must
 * retain protected file custody separately and compare this exact snapshot under
 * its eventual CAS. Neither child exit, target absence, readiness, restoration
 * authority nor actual selector resolution follows from this result.
 *
 * There is no restoration attempt namespace in the original publication
 * contract. A fallback-shaped image therefore refuses instead of attributing a
 * restoration to this claim. No collector failure selects another image class.
 */
export function classifyInitialHostPublication(input: InitialHostRecoveryImage) {
  const planFile = captureFile(input.plan);
  const intentFile = captureFile(input.intent);
  const claimFile = captureFile(input.claim);
  const plan = readRecord(
    planFile,
    (value) => InitialHostSupervisorMigrationPlanSchema.parse(value),
    false,
  );
  const intent = readRecord(intentFile, (value) => InitialHostMigrationIntentSchema.parse(value));
  const claim = readRecord(claimFile, (value) => InitialHostMigrationClaimSchema.parse(value));
  const records = initialHostPublicationRecords({
    plan,
    intent,
    claim,
    enrollmentStateDirectory: input.enrollmentStateDirectory,
  });
  requireImage(
    planFile.path ===
      path.join(
        plan.precondition.identity.installationRoot,
        "initial-host-migrations",
        "plans",
        `${intent.planSha256}.json`,
      ) &&
      intentFile.path ===
        path.join(
          input.enrollmentStateDirectory,
          `initial-host-${intent.stepId}-${intent.generation}.json`,
        ) &&
      claimFile.path ===
        path.join(
          input.enrollmentStateDirectory,
          `initial-host-claim-${claim.stepId}-${claim.generation}.json`,
        ),
    "original plan, intent or claim path changed",
  );
  const launcher = captureFile(input.launcher);
  const phase = captureFile(input.phase);
  const launcherAttempt = captureFile(input.launcherAttempt);
  const selectorAttempt = captureFile(input.selectorAttempt);
  const hasLauncherAttempt = matchesRecord(launcherAttempt, records.launcherAttempt);
  const hasPhase = matchesRecord(phase, records.phase);
  const hasSelectorAttempt = matchesRecord(selectorAttempt, records.selectorAttempt);
  requireImage(
    launcher.path === records.launcher.path && launcher.state === "present",
    "missing or changed launcher path",
  );
  requireImage(
    records.launcher.original !== records.launcher.candidate &&
      new Set([records.selector.original, records.selector.candidate, records.selector.fallback])
        .size === 3,
    "ambiguous original, candidate or fallback image",
  );
  const originalLauncher = launcher.sha256 === records.launcher.original;
  const candidateLauncher = launcher.sha256 === records.launcher.candidate;
  requireImage(originalLauncher || candidateLauncher, "unknown launcher bytes");
  assertPath(input.selector.path);
  requireImage(
    input.selector.path === records.selector.path && input.selector.state === "present",
    "missing or inconclusive selector",
  );
  assertFields(input.selector, ["path", "state", "text", "resolvedTarget"]);
  const selector = {
    path: input.selector.path,
    state: "present" as const,
    text: input.selector.text,
    resolvedTarget: input.selector.resolvedTarget,
  };
  const capturedPaths = [
    planFile,
    intentFile,
    claimFile,
    launcher,
    phase,
    launcherAttempt,
    selectorAttempt,
    selector,
  ].map((file) => file.path);
  requireImage(new Set(capturedPaths).size === capturedPaths.length, "overlapping artifact paths");
  requireImage(
    typeof selector.text === "string" && selector.text.length > 0 && !selector.text.includes("\0"),
    "invalid selector text",
  );
  assertPath(selector.resolvedTarget);
  const originalSelector = selector.resolvedTarget === records.selector.original;
  const candidateSelector = selector.resolvedTarget === records.selector.candidate;
  requireImage(originalSelector || candidateSelector, "unknown or unproven fallback selector");
  requireImage(!candidateLauncher || hasLauncherAttempt, "candidate launcher precedes its attempt");
  requireImage(!hasPhase || candidateLauncher, "phase precedes candidate launcher");
  requireImage(!hasSelectorAttempt || hasPhase, "selector attempt precedes phase");
  requireImage(
    !candidateSelector ||
      (selector.text === records.selector.candidate &&
        candidateLauncher &&
        hasLauncherAttempt &&
        hasPhase &&
        hasSelectorAttempt),
    "candidate selector precedes complete publication records",
  );
  let classification: "completed-candidate" | "launcher-first-partial" | "unchanged-original" =
    "unchanged-original";
  if (candidateSelector) classification = "completed-candidate";
  else if (candidateLauncher) classification = "launcher-first-partial";
  const snapshot = freeze({
    version: 1 as const,
    classification,
    enrollmentStateDirectory: input.enrollmentStateDirectory,
    binding: {
      intentId: intent.id,
      stepId: claim.stepId,
      generation: claim.generation,
      planSha256: claim.planSha256,
      intentSha256: claim.intentSha256,
      claimSha256: claimFile.sha256,
    },
    plan: planFile,
    intent: intentFile,
    claim: claimFile,
    launcher,
    phase,
    launcherAttempt,
    selectorAttempt,
    selector,
  });
  return freeze({ classification, snapshot, snapshotSha256: sha256(JSON.stringify(snapshot)) });
}
