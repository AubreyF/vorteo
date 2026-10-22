import { expect, it } from "vitest";
import { submitAgentInput, type AgentInputSubmitActionInput } from "./submit";

function fixture(queueMessage: () => Promise<void>) {
  const state = {
    text: "Keep this",
    attachments: ["image"],
    processing: false,
    error: null as string | null,
  };
  const input: AgentInputSubmitActionInput<string> = {
    message: state.text,
    attachments: state.attachments,
    isAgentRunning: true,
    canSubmit: true,
    queueMessage,
    submitMessage: async () => {
      throw new Error("Unexpected immediate send");
    },
    clearDraft: () => {
      throw new Error("Unexpected sent draft");
    },
    setUserInput: (text) => {
      state.text = text;
    },
    setAttachments: (attachments) => {
      state.attachments = attachments;
    },
    setIsProcessing: (processing) => {
      state.processing = processing;
    },
    setSendError: (error) => {
      state.error = error;
    },
    reportConnectionError: () => {
      throw new Error("Unexpected connection error");
    },
  };
  return { state, input };
}

it("keeps the composer until the outbox confirms local persistence", async () => {
  let commit!: () => void;
  const pending = new Promise<void>((resolve) => {
    commit = resolve;
  });
  const { state, input } = fixture(() => pending);
  const result = submitAgentInput(input);
  expect(state).toEqual({
    text: "Keep this",
    attachments: ["image"],
    processing: true,
    error: null,
  });
  commit();
  expect(await result).toBe("queued");
  expect(state).toEqual({ text: "", attachments: [], processing: false, error: null });
});

it("retains the draft and exposes a failed local save", async () => {
  const { state, input } = fixture(async () => {
    throw new Error("Storage full");
  });
  expect(await submitAgentInput(input)).toBe("failed");
  expect(state).toEqual({
    text: "Keep this",
    attachments: ["image"],
    processing: false,
    error: "Storage full",
  });
});
