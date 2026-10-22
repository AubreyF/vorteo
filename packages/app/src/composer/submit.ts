import { i18n } from "@/i18n/i18next";
import { isConnectionError, toErrorMessage } from "@/utils/error-messages";

export type AgentInputSubmitResult = "noop" | "queued" | "submitted" | "failed";

export interface AgentInputSubmitActionInput<TAttachment> {
  message: string;
  attachments: TAttachment[];
  hasExternalContent?: boolean;
  allowEmptySubmit?: boolean;
  submitBehavior?: "clear" | "preserve-and-lock";
  forceSend?: boolean;
  isAgentRunning: boolean;
  canSubmit: boolean;
  queueMessage: (input: { message: string; attachments: TAttachment[] }) => void | Promise<void>;
  submitMessage: (input: { message: string; attachments: TAttachment[] }) => Promise<void>;
  clearDraft: (lifecycle: "sent" | "abandoned") => void;
  setUserInput: (text: string) => void;
  setAttachments: (attachments: TAttachment[]) => void;
  setSendError: (message: string | null) => void;
  /** Reports a send that failed because the connection dropped; it leaves no inline error. */
  reportConnectionError: (error: unknown) => void;
  setIsProcessing: (isProcessing: boolean) => void;
  onSubmitError?: (error: unknown) => void;
  failedToSendMessage?: string;
}

export async function submitAgentInput<TAttachment>(
  input: AgentInputSubmitActionInput<TAttachment>,
): Promise<AgentInputSubmitResult> {
  const trimmedMessage = input.message.trim();
  const attachments = input.attachments;
  const shouldClearOnSubmit = input.submitBehavior !== "preserve-and-lock";

  if (
    !trimmedMessage &&
    attachments.length === 0 &&
    !input.hasExternalContent &&
    !input.allowEmptySubmit
  ) {
    return "noop";
  }

  if (!input.canSubmit) {
    return "noop";
  }

  if (input.isAgentRunning && !input.forceSend) {
    return queueAgentInput(input, trimmedMessage);
  }

  // Clear immediately so the submitted timeline row and composer state stay in sync.
  if (shouldClearOnSubmit) {
    input.setUserInput("");
    input.setAttachments([]);
  }
  input.setSendError(null);
  input.setIsProcessing(true);

  try {
    await input.submitMessage({ message: trimmedMessage, attachments });
    input.clearDraft("sent");
    input.setIsProcessing(false);
    return "submitted";
  } catch (error) {
    input.onSubmitError?.(error);
    if (shouldClearOnSubmit) {
      input.setUserInput(trimmedMessage);
      input.setAttachments(attachments);
    }
    reportSendFailure(input, error);
    input.setIsProcessing(false);
    return "failed";
  }
}

async function queueAgentInput<TAttachment>(
  input: AgentInputSubmitActionInput<TAttachment>,
  message: string,
): Promise<AgentInputSubmitResult> {
  input.setSendError(null);
  input.setIsProcessing(true);
  try {
    await input.queueMessage({ message, attachments: input.attachments });
    if (input.submitBehavior !== "preserve-and-lock") {
      input.setUserInput("");
      input.setAttachments([]);
    }
    return "queued";
  } catch (error) {
    input.onSubmitError?.(error);
    reportSendFailure(input, error);
    return "failed";
  } finally {
    input.setIsProcessing(false);
  }
}

// A dropped connection is transient, so it becomes a toast while the restored draft waits for
// a retry. The send action wraps an ambiguous drop in its own message with the transport error
// as the cause. Host rejections stay inline until the user edits the draft or reconnects.
function reportSendFailure<TAttachment>(
  input: AgentInputSubmitActionInput<TAttachment>,
  error: unknown,
): void {
  const isDroppedConnection =
    isConnectionError(error) || (error instanceof Error && isConnectionError(error.cause));
  if (isDroppedConnection) {
    input.reportConnectionError(error);
    return;
  }
  input.setSendError(
    error instanceof Error
      ? toErrorMessage(error)
      : (input.failedToSendMessage ?? i18n.t("composer.errors.failedToSend")),
  );
}
