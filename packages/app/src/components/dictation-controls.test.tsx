// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DictationOverlay } from "./dictation-controls";

const mode = vi.hoisted(() => ({ touch: false, compact: false }));
vi.mock("@/vorton-touch", () => ({ useVortonTouch: () => mode.touch }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 34 }) }));
vi.mock("@/constants/layout", () => ({
  FOOTER_HEIGHT: 75,
  useIsCompactFormFactor: () => mode.compact,
}));
vi.mock("./volume-meter", () => ({ VolumeMeter: () => null }));
vi.mock("@/components/ui/loading-spinner", () => ({ LoadingSpinner: () => null }));
vi.mock("react-i18next", () => ({
  // The i18n module registers this plugin when a dependency imports it.
  initReactI18next: { type: "3rdParty", init: () => {} },
  useTranslation: () => ({ t: (key: string) => key }),
}));

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
function button(action: string) {
  const element = host.querySelector(`[aria-label="message.dictation.${action}"]`);
  if (!(element instanceof HTMLElement)) throw new Error(`Missing ${action}`);
  return element;
}
it.each([
  [false, false],
  [true, false],
  [true, true],
])("keeps recording actions independent with touch=%s compact=%s", (touch, compact) => {
  mode.touch = touch;
  mode.compact = compact;
  const edit = vi.fn();
  const send = vi.fn();
  const cancel = vi.fn();
  const queue = vi.fn();
  act(() =>
    root.render(
      <DictationOverlay
        volume={0}
        duration={2}
        isRecording
        isProcessing={false}
        status="recording"
        onCancel={cancel}
        onAccept={edit}
        onAcceptAndSend={send}
        onAcceptAndQueue={queue}
      />,
    ),
  );
  act(() => button("insert").click());
  expect(edit).toHaveBeenCalledTimes(1);
  expect(send).not.toHaveBeenCalled();
  expect(cancel).not.toHaveBeenCalled();
  act(() => button("insertAndSend").click());
  expect(send).toHaveBeenCalledTimes(1);
  act(() => button("cancel").click());
  expect(cancel).toHaveBeenCalledTimes(1);
  const queueButton = host.querySelector<HTMLElement>('[aria-label="Queue recorded message"]');
  expect(queueButton).not.toBeNull();
  expect(queueButton?.textContent).not.toContain("Q");
  act(() => queueButton?.click());
  expect(queue).toHaveBeenCalledTimes(1);
  expect(send).toHaveBeenCalledTimes(1);
});
it.each([false, true])("prevents duplicate actions while processing with touch=%s", (touch) => {
  mode.touch = touch;
  const action = vi.fn();
  act(() =>
    root.render(
      <DictationOverlay
        volume={0}
        duration={2}
        isRecording={false}
        isProcessing
        status="uploading"
        onCancel={action}
        onAccept={action}
        onAcceptAndSend={action}
        onAcceptAndQueue={action}
      />,
    ),
  );
  act(() => button("cancel").click());
  expect(action).not.toHaveBeenCalled();
  expect(host.querySelector('[aria-label="Queue recorded message"]')).toBeNull();
  expect(host.querySelector('[aria-label="message.dictation.insert"]')).toBeNull();
  expect(host.querySelector('[aria-label="message.dictation.insertAndSend"]')).toBeNull();
});
