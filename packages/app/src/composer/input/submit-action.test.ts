import { describe, expect, it } from "vitest";
import {
  resolvePrimaryAction,
  resolveSubmitAction,
  supportsSubmitModifiers,
} from "./submit-action";

const running = {
  enabled: true,
  modifier: "none",
  isCompact: false,
  isAgentRunning: true,
  canQueue: true,
  defaultActionQueues: false,
} as const;

describe("composer submit action", () => {
  it("shows queue for Command while running, and restores send after release", () => {
    expect(resolveSubmitAction({ ...running, modifier: "alternate" })).toEqual({
      action: "alternate",
      queues: true,
    });
    expect(resolveSubmitAction(running)).toEqual({ action: "default", queues: false });
  });
  it("shows send for Command when Enter already queues by default", () => {
    expect(resolveSubmitAction({ ...running, defaultActionQueues: true })).toEqual({
      action: "default",
      queues: true,
    });
    expect(
      resolveSubmitAction({ ...running, defaultActionQueues: true, modifier: "alternate" }),
    ).toEqual({ action: "alternate", queues: false });
  });
  it.each([{ isAgentRunning: false }, { canQueue: false }, { isCompact: true }])(
    "does not advertise unavailable Command queue behavior: %j",
    (override) => {
      expect(resolveSubmitAction({ ...running, modifier: "alternate", ...override })).toEqual({
        action: "default",
        queues: false,
      });
    },
  );
  it("always inserts a newline for Shift, including compact and idle composers", () => {
    expect(
      resolveSubmitAction({
        ...running,
        modifier: "newline",
        isCompact: true,
        isAgentRunning: false,
      }),
    ).toEqual({ action: "newline", queues: false });
  });
  it("preserves controls when modifiers are unavailable even with Shift held and default queue enabled", () => {
    expect(
      resolveSubmitAction({
        ...running,
        enabled: false,
        modifier: "newline",
        defaultActionQueues: true,
      }),
    ).toEqual({ action: "default", queues: false });
  });
  it.each([
    { isWeb: false },
    { inputMode: "terminal" as const },
    { readOnly: true },
    { isSubmitLoading: true },
  ])("preserves baseline controls outside editable Vorton web chats: %j", (override) => {
    expect(
      supportsSubmitModifiers({
        isWeb: true,
        inputMode: "chat",
        readOnly: false,
        isSubmitLoading: false,
        ...override,
      }),
    ).toBe(false);
  });
  it("enables modifier controls in editable Vorton web chats", () => {
    expect(
      supportsSubmitModifiers({
        isWeb: true,
        inputMode: "chat",
        readOnly: false,
        isSubmitLoading: false,
      }),
    ).toBe(true);
  });
});

const emptyComposer = {
  hasSendableContent: false,
  allowEmptySubmit: false,
  isAgentRunning: false,
  isSubmitLoading: false,
  isSubmitDisabled: false,
  inputMode: "chat",
  readOnly: false,
} as const;

describe("empty composer submit button", () => {
  it("keeps a disabled submit button in an empty Vorton chat", () => {
    expect(resolvePrimaryAction(emptyComposer)).toEqual({ kind: "send", isSubmitDisabled: true });
  });
  it("shows only stop while running with no content to send", () => {
    expect(resolvePrimaryAction({ ...emptyComposer, isAgentRunning: true })).toEqual({
      kind: "active",
      isSubmitDisabled: true,
    });
  });
  it("enables submit when text or attachments become sendable", () => {
    expect(resolvePrimaryAction({ ...emptyComposer, hasSendableContent: true })).toEqual({
      kind: "send",
      isSubmitDisabled: false,
    });
  });
  it("preserves intentional empty submissions and pending submissions", () => {
    expect(resolvePrimaryAction({ ...emptyComposer, allowEmptySubmit: true })).toEqual({
      kind: "send",
      isSubmitDisabled: false,
    });
    expect(resolvePrimaryAction({ ...emptyComposer, isSubmitLoading: true })).toEqual({
      kind: "send",
      isSubmitDisabled: false,
    });
  });
  it("keeps the caller's disabled state", () => {
    expect(
      resolvePrimaryAction({ ...emptyComposer, hasSendableContent: true, isSubmitDisabled: true }),
    ).toEqual({ kind: "send", isSubmitDisabled: true });
  });
  it.each([{ inputMode: "terminal" as const }, { readOnly: true }])(
    "preserves baseline controls outside editable Vorton chat: %j",
    (override) => {
      expect(resolvePrimaryAction({ ...emptyComposer, ...override })).toEqual({
        kind: "none",
        isSubmitDisabled: false,
      });
      expect(resolvePrimaryAction({ ...emptyComposer, ...override, isAgentRunning: true })).toEqual(
        { kind: "active", isSubmitDisabled: false },
      );
    },
  );
});

describe("separate mobile Queue and Send controls", () => {
  it.each([true, false])(
    "keeps primary Send with modifiers enabled=%s, including native",
    (enabled) => {
      for (const isAgentRunning of [true, false]) {
        for (const defaultActionQueues of [true, false]) {
          expect(
            resolveSubmitAction({
              ...running,
              enabled,
              isCompact: true,
              isAgentRunning,
              defaultActionQueues,
              separateQueueAction: true,
            }),
          ).toEqual({ action: "send", queues: false });
        }
      }
    },
  );
  it("keeps the desktop default queue preference", () => {
    expect(
      resolveSubmitAction({ ...running, defaultActionQueues: true, separateQueueAction: false }),
    ).toEqual({ action: "default", queues: true });
  });
});
