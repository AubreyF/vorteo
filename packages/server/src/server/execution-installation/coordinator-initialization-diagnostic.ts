import { z } from "zod";
import { BootstrapRequestConflict } from "./coordinator-bootstrap.js";
import type { BootstrapReviewService } from "./coordinator-bootstrap-session.js";

export const INITIALIZATION_PHASES = [
  "preconditions",
  "runner_schema",
  "derive_renewal",
  "admission_schema",
  "verify_setup",
  "create_review_service",
  "renewal_fingerprint",
  "create_dispatch_service",
] as const;
export type InitializationPhase = (typeof INITIALIZATION_PHASES)[number];
const CODES = new Set([
  "ENOENT",
  "EACCES",
  "EPERM",
  "ENOTDIR",
  "EISDIR",
  "ELOOP",
  "EIO",
  "EMFILE",
  "ENFILE",
  "ENOSPC",
  "EROFS",
]);

/** Never serialize thrown values, schema paths, names, messages or stacks. */
export function initializationClassification(error: unknown): string {
  let kind = "unclassified";
  let code = "none";
  try {
    if (error instanceof z.ZodError) kind = "schema";
    else if (error instanceof BootstrapRequestConflict) kind = "conflict";
    else if (error instanceof TypeError) kind = "type";
    else if (error instanceof SyntaxError) kind = "syntax";
    else if (error instanceof RangeError) kind = "range";
    else if (error instanceof Error) kind = "error";
    if (error !== null && typeof error === "object") {
      // A getter or a custom error name must not become a diagnostic payload.
      const descriptor = Object.getOwnPropertyDescriptor(error, "code");
      if (
        descriptor &&
        "value" in descriptor &&
        typeof descriptor.value === "string" &&
        CODES.has(descriptor.value)
      )
        code = descriptor.value;
    }
  } catch {
    return "class=unclassified code=none";
  }
  return `class=${kind} code=${code}`;
}

export async function withInitializationDiagnostic(
  initialize: (
    phase: (value: InitializationPhase) => void,
  ) => Promise<BootstrapReviewService | undefined>,
): Promise<BootstrapReviewService | undefined> {
  let phase: InitializationPhase = "preconditions";
  try {
    return await initialize((value) => {
      phase = value;
    });
  } catch (error) {
    // All failures retain the same unavailable service and conflict refusals.
    // Even conflict messages may contain paths, so none are copied here.
    const description = `Coordinator maintenance is unavailable: initialization failed. Do not replay or rewrite history. [phase=${phase} ${initializationClassification(error)}]`;
    const unavailable = () => {
      throw new BootstrapRequestConflict(description);
    };
    return {
      unavailableReason: description,
      list: unavailable,
      prepare: async () => unavailable(),
      decide: async () => unavailable(),
    };
  }
}
