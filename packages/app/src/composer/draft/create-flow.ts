import { useCallback, useMemo, useReducer } from "react";
import { useTranslation } from "react-i18next";
import type { ComposerAttachment } from "@/attachments/types";
import {
  resolveComposerAttachmentSubmitFormat,
  splitComposerAttachmentsForSubmit,
} from "@/composer/attachments/submit";
import { isActiveCreateFlowForDraft, useCreateFlowStore } from "@/stores/create-flow-store";
import { handoffCreatedAgentMessageSubmission } from "@/composer/submission/writer";
import { useSessionStore } from "@/stores/session-store";
import {
  createUserMessage,
  type StreamItem,
  type UserMessageImageAttachment,
} from "@/types/stream";
import type { AgentAttachment } from "@getpaseo/protocol/messages";
import type { PendingMessageSubmission } from "@/composer/submission/model";
import { toErrorMessage } from "@/utils/error-messages";

const EMPTY_STREAM_ITEMS: StreamItem[] = [];

interface CreateAttempt {
  goal?: import("@getpaseo/protocol/agent-goals").AgentGoalSetInput;
  clientMessageId: string;
  text: string;
  timestamp: Date;
  images?: UserMessageImageAttachment[];
  attachments?: AgentAttachment[];
}

// A validation error belongs to the inputs it was raised for, so it disappears once they change.
type DraftAgentMachineState<TDraftAgent> =
  | { tag: "draft"; errorMessage: string; errorInputsKey: string }
  | { tag: "creating"; attempt: CreateAttempt; draftAgent: TDraftAgent };

type DraftAgentMachineEvent<TDraftAgent> =
  | { type: "DRAFT_SET_ERROR"; message: string; inputsKey: string }
  | { type: "SUBMIT"; attempt: CreateAttempt; draftAgent: TDraftAgent }
  | { type: "CREATE_FAILED" };

function assertNever(value: never): never {
  throw new Error(`Unhandled state: ${JSON.stringify(value)}`);
}

function reducer<TDraftAgent>(
  state: DraftAgentMachineState<TDraftAgent>,
  event: DraftAgentMachineEvent<TDraftAgent>,
): DraftAgentMachineState<TDraftAgent> {
  switch (event.type) {
    case "DRAFT_SET_ERROR": {
      if (state.tag !== "draft") {
        return state;
      }
      return { ...state, errorMessage: event.message, errorInputsKey: event.inputsKey };
    }
    case "SUBMIT": {
      return { tag: "creating", attempt: event.attempt, draftAgent: event.draftAgent };
    }
    case "CREATE_FAILED": {
      if (state.tag !== "creating") {
        return state;
      }
      return { tag: "draft", errorMessage: "", errorInputsKey: "" };
    }
    default:
      return assertNever(event);
  }
}

function prepareCreateAttempt<TDraftAgent>(input: {
  attempt: CreateAttempt;
  buildDraftAgent: (attempt: CreateAttempt) => TDraftAgent;
  inputsKey: string;
}): DraftAgentMachineState<TDraftAgent> {
  const { attempt, buildDraftAgent, inputsKey } = input;
  try {
    return { tag: "creating", attempt, draftAgent: buildDraftAgent(attempt) };
  } catch (error) {
    return { tag: "draft", errorMessage: toErrorMessage(error), errorInputsKey: inputsKey };
  }
}

interface CreateRequestResult<TCreateResult> {
  agentId: string | null;
  result: TCreateResult;
}

interface SubmitContext {
  goal?: import("@getpaseo/protocol/agent-goals").AgentGoalSetInput;
  text: string;
  attachments: ComposerAttachment[];
  cwd: string;
}

interface CreateRequestContext {
  attempt: CreateAttempt;
  text: string;
  images?: UserMessageImageAttachment[];
  attachments?: AgentAttachment[];
  cwd: string;
}

interface UseDraftAgentCreateFlowOptions<TDraftAgent, TCreateResult> {
  draftId: string;
  getPendingServerId: () => string | null;
  /** Identifies the form inputs; a validation error clears when this changes. */
  formInputsKey: string;
  initialAttempt?: CreateAttempt | null;
  allowEmptyText?: boolean;
  validateBeforeSubmit?: (ctx: SubmitContext) => string | null;
  onBeforeSubmit?: (ctx: CreateRequestContext) => Promise<void> | void;
  onCreateStart?: () => void;
  createRequest: (ctx: CreateRequestContext) => Promise<CreateRequestResult<TCreateResult>>;
  buildDraftAgent: (attempt: CreateAttempt) => TDraftAgent;
  onCreateSuccess: (ctx: { result: TCreateResult; attempt: CreateAttempt }) => Promise<void> | void;
  /** Reports a failed create request. The form keeps only validation errors inline. */
  onCreateError: (error: unknown) => void;
}

export function useDraftAgentCreateFlow<TDraftAgent, TCreateResult>({
  draftId,
  getPendingServerId,
  formInputsKey,
  initialAttempt = null,
  allowEmptyText = false,
  validateBeforeSubmit,
  onBeforeSubmit,
  onCreateStart,
  createRequest,
  buildDraftAgent,
  onCreateSuccess,
  onCreateError,
}: UseDraftAgentCreateFlowOptions<TDraftAgent, TCreateResult>) {
  const { t } = useTranslation();
  const [localMachine, dispatch] = useReducer(
    reducer<TDraftAgent>,
    initialAttempt,
    (attempt): DraftAgentMachineState<TDraftAgent> =>
      attempt
        ? prepareCreateAttempt({ attempt, buildDraftAgent, inputsKey: formInputsKey })
        : {
            tag: "draft",
            errorMessage: "",
            errorInputsKey: "",
          },
  );

  const pending = useCreateFlowStore((state) => state.pendingByDraftId[draftId]);
  // Remounts can precede model hydration. Rebuild the preview when its inputs
  // arrive, and observe the original request's failure through shared state.
  const machine = useMemo<DraftAgentMachineState<TDraftAgent>>(() => {
    if (pending?.lifecycle === "abandoned") {
      return { tag: "draft", errorMessage: "", errorInputsKey: "" };
    }
    if (pending?.lifecycle === "active" && localMachine.tag === "draft" && initialAttempt) {
      return prepareCreateAttempt({
        attempt: initialAttempt,
        buildDraftAgent,
        inputsKey: formInputsKey,
      });
    }
    return localMachine;
  }, [pending, localMachine, initialAttempt, buildDraftAgent, formInputsKey]);

  const setPendingCreateAttempt = useCreateFlowStore((state) => state.setPending);
  const updatePendingAgentId = useCreateFlowStore((state) => state.updateAgentId);
  const markPendingCreateLifecycle = useCreateFlowStore((state) => state.markLifecycle);
  const formErrorMessage =
    machine.tag === "draft" && machine.errorInputsKey === formInputsKey ? machine.errorMessage : "";
  const isSubmitting = machine.tag === "creating";

  const submittedStreamItems = useMemo<StreamItem[]>(() => {
    if (machine.tag !== "creating") {
      return EMPTY_STREAM_ITEMS;
    }

    if (
      !machine.attempt.text &&
      (!machine.attempt.images || machine.attempt.images.length === 0) &&
      (!machine.attempt.attachments || machine.attempt.attachments.length === 0)
    ) {
      return EMPTY_STREAM_ITEMS;
    }

    return [
      createUserMessage({
        clientMessageId: machine.attempt.clientMessageId,
        text: machine.attempt.text,
        intent: machine.attempt.goal ? "goal" : undefined,
        timestamp: machine.attempt.timestamp,
        images: machine.attempt.images,
        attachments: machine.attempt.attachments,
      }),
    ];
  }, [machine]);
  const pendingMessageSubmissions = useMemo<readonly PendingMessageSubmission[]>(() => {
    if (machine.tag !== "creating") return [];
    return [
      {
        clientMessageId: machine.attempt.clientMessageId,
      },
    ];
  }, [machine]);

  const draftAgent = machine.tag === "creating" ? machine.draftAgent : null;
  const startCreateAttempt = useCallback(
    (attempt: CreateAttempt) => {
      const prepared = prepareCreateAttempt({ attempt, buildDraftAgent, inputsKey: formInputsKey });
      if (prepared.tag === "draft") {
        dispatch({
          type: "DRAFT_SET_ERROR",
          message: prepared.errorMessage,
          inputsKey: formInputsKey,
        });
        throw new Error(prepared.errorMessage);
      }
      dispatch({ type: "SUBMIT", attempt, draftAgent: prepared.draftAgent });
    },
    [buildDraftAgent, formInputsKey],
  );

  const runCreateAttempt = useCallback(
    async ({ attempt, cwd }: { attempt: CreateAttempt; cwd: string }) => {
      const pendingServerId = getPendingServerId();
      if (!pendingServerId) {
        const error = new Error(t("composer.errors.noHostSelected"));
        dispatch({ type: "DRAFT_SET_ERROR", message: error.message, inputsKey: formInputsKey });
        throw error;
      }

      try {
        await onBeforeSubmit?.({
          attempt,
          text: attempt.text,
          images: attempt.images,
          attachments: attempt.attachments,
          cwd,
        });
        const createResult = await createRequest({
          attempt,
          text: attempt.text,
          images: attempt.images,
          attachments: attempt.attachments,
          cwd,
        });

        if (createResult.agentId) {
          updatePendingAgentId({ draftId, agentId: createResult.agentId });
          handoffCreatedAgentMessageSubmission(
            pendingServerId,
            createResult.agentId,
            createUserMessage({
              clientMessageId: attempt.clientMessageId,
              text: attempt.text,
              intent: attempt.goal ? "goal" : undefined,
              timestamp: attempt.timestamp,
              images: attempt.images,
              attachments: attempt.attachments,
            }),
          );
          markPendingCreateLifecycle({ draftId, lifecycle: "sent" });
        }

        await onCreateSuccess({ result: createResult.result, attempt });
      } catch (error) {
        dispatch({ type: "CREATE_FAILED" });
        markPendingCreateLifecycle({ draftId, lifecycle: "abandoned" });
        onCreateError(
          error instanceof Error ? error : new Error(t("composer.errors.failedToCreateAgent")),
        );
        throw error;
      }
    },
    [
      createRequest,
      draftId,
      formInputsKey,
      getPendingServerId,
      markPendingCreateLifecycle,
      onBeforeSubmit,
      onCreateError,
      onCreateSuccess,
      t,
      updatePendingAgentId,
    ],
  );

  const handleCreateFromInput = useCallback(
    async ({ text, attachments, cwd, goal }: SubmitContext) => {
      const existing = useCreateFlowStore.getState().pendingByDraftId[draftId];
      if (
        isSubmitting ||
        isActiveCreateFlowForDraft({ pending: existing, serverId: getPendingServerId(), draftId })
      ) {
        throw new Error(t("composer.errors.alreadyLoading"));
      }

      dispatch({ type: "DRAFT_SET_ERROR", message: "", inputsKey: formInputsKey });
      const trimmedPrompt = text.trim();
      const pendingServerId = getPendingServerId();
      if (!pendingServerId) {
        const error = new Error(t("composer.errors.noHostSelected"));
        dispatch({ type: "DRAFT_SET_ERROR", message: error.message, inputsKey: formInputsKey });
        throw error;
      }
      const supportsForgeSearch =
        useSessionStore.getState().sessions[pendingServerId]?.serverInfo?.features?.forgeSearch ===
        true;
      const wirePayload = splitComposerAttachmentsForSubmit(attachments, {
        format: resolveComposerAttachmentSubmitFormat({
          supportsForgeAttachments: supportsForgeSearch,
        }),
      });
      const images = wirePayload.images;

      const hasAttachmentContent = images.length > 0 || wirePayload.attachments.length > 0;
      if (!trimmedPrompt && !hasAttachmentContent && !allowEmptyText) {
        const error = new Error(t("composer.errors.initialPromptRequired"));
        dispatch({ type: "DRAFT_SET_ERROR", message: error.message, inputsKey: formInputsKey });
        throw error;
      }

      const validationError = validateBeforeSubmit?.({
        text: trimmedPrompt,
        attachments,
        cwd,
      });
      if (validationError) {
        const error = new Error(validationError);
        dispatch({ type: "DRAFT_SET_ERROR", message: validationError, inputsKey: formInputsKey });
        throw error;
      }

      const attempt: CreateAttempt = {
        goal,
        clientMessageId: `${draftId}:initial-message`,
        text: trimmedPrompt,
        timestamp: new Date(),
        ...(images.length > 0 ? { images } : {}),
        ...(wirePayload.attachments.length > 0 ? { attachments: wirePayload.attachments } : {}),
      };

      startCreateAttempt(attempt);
      setPendingCreateAttempt({
        draftId,
        serverId: pendingServerId,
        agentId: null,
        clientMessageId: attempt.clientMessageId,
        text: attempt.text,
        goal: attempt.goal,
        timestamp: attempt.timestamp.getTime(),
        ...(attempt.images && attempt.images.length > 0 ? { images: attempt.images } : {}),
        ...(attempt.attachments && attempt.attachments.length > 0
          ? { attachments: attempt.attachments }
          : {}),
      });

      onCreateStart?.();
      await runCreateAttempt({ attempt, cwd });
    },
    [
      allowEmptyText,
      draftId,
      formInputsKey,
      getPendingServerId,
      isSubmitting,
      onCreateStart,
      runCreateAttempt,
      setPendingCreateAttempt,
      startCreateAttempt,
      t,
      validateBeforeSubmit,
    ],
  );

  const continueCreateFromAttempt = useCallback(
    async ({ attempt, cwd }: { attempt: CreateAttempt; cwd: string }) => {
      if (!isSubmitting) {
        startCreateAttempt(attempt);
      }
      await runCreateAttempt({ attempt, cwd });
    },
    [isSubmitting, runCreateAttempt, startCreateAttempt],
  );

  return {
    machine,
    formErrorMessage,
    isSubmitting,
    submittedStreamItems,
    pendingMessageSubmissions,
    draftAgent,
    handleCreateFromInput,
    continueCreateFromAttempt,
  };
}

export type { CreateAttempt as DraftCreateAttempt };
