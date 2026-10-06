import type { SubmitModifier } from "./submit-modifier";
import type { ComposerInputMode } from "@/composer/input-mode";

export type PrimaryActionKind = "send" | "active" | "none";

export function resolvePrimaryAction(input: {
  hasSendableContent: boolean;
  allowEmptySubmit: boolean;
  isAgentRunning: boolean;
  isSubmitLoading: boolean;
  isSubmitDisabled: boolean;

  inputMode: ComposerInputMode;
  readOnly: boolean;
}): { kind: PrimaryActionKind; isSubmitDisabled: boolean } {
  const showEmptySubmit = input.inputMode === "chat" && !input.readOnly;
  const hasSubmission = input.hasSendableContent || input.allowEmptySubmit;
  const disableEmptySubmit = showEmptySubmit && !hasSubmission && !input.isSubmitLoading;
  const isSubmitDisabled = input.isSubmitDisabled || disableEmptySubmit;
  if (hasSubmission) return { kind: "send", isSubmitDisabled };
  if (input.isAgentRunning) {
    return { kind: "active", isSubmitDisabled };
  }
  if (input.isSubmitLoading || showEmptySubmit) return { kind: "send", isSubmitDisabled };
  return { kind: "none", isSubmitDisabled };
}

export function supportsSubmitModifiers(input: {
  isWeb: boolean;
  inputMode: ComposerInputMode;
  readOnly: boolean;
  isSubmitLoading: boolean;
}): boolean {
  return input.isWeb && input.inputMode === "chat" && !input.readOnly && !input.isSubmitLoading;
}

export function resolveSubmitAction(input: {
  enabled: boolean;
  modifier: SubmitModifier;
  isCompact: boolean;
  isAgentRunning: boolean;
  canQueue: boolean;
  defaultActionQueues: boolean;
  separateQueueAction?: boolean;
}) {
  // Touch composers expose Queue separately, so their primary button always sends.
  if (input.separateQueueAction) return { action: "send", queues: false } as const;
  if (!input.enabled) return { action: "default", queues: false } as const;
  if (input.modifier === "newline") return { action: "newline", queues: false } as const;
  const alternate =
    input.modifier === "alternate" && !input.isCompact && input.isAgentRunning && input.canQueue;
  if (alternate) return { action: "alternate", queues: !input.defaultActionQueues } as const;
  return { action: "default", queues: input.defaultActionQueues && input.canQueue } as const;
}
