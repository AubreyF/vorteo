import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, afterEach, expect, test, vi } from "vitest";
import { WorkspaceRenameModal } from "./workspace-rename-modal";

const state = vi.hoisted(() => ({
  supported: true,
  suggest: vi.fn<() => Promise<string[]>>(),
  save: vi.fn<() => Promise<void>>(),
}));
vi.mock("@/runtime/host-features", () => ({ useHostFeature: () => state.supported }));
vi.mock("@/runtime/host-runtime", () => ({
  getHostRuntimeStore: () => ({
    getClient: () => ({ suggestWorkspaceTitles: state.suggest, setWorkspaceTitle: state.save }),
  }),
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/components/adaptive-modal-sheet", async () => {
  const R = await import("react");
  const Input = R.forwardRef<
    import("@/components/ui/text-input").EditingTextInputHandle,
    {
      initialValue?: string;
      onChangeText?: (value: string) => void;
      testID?: string;
      editable?: boolean;
    }
  >((props, ref) => {
    const inputRef = R.useRef<HTMLInputElement>(null);
    R.useImperativeHandle(ref, () => ({
      focus: () => inputRef.current?.focus(),
      blur: () => inputRef.current?.blur(),
      isFocused: () => document.activeElement === inputRef.current,
      getText: () => inputRef.current?.value ?? "",
      replaceText: (text) => {
        if (inputRef.current) inputRef.current.value = text;
      },
      reset: () => {
        if (inputRef.current) inputRef.current.value = "";
      },
      getNativeRef: () => inputRef.current,
    }));
    const onChangeText = props.onChangeText;
    const handleInput = R.useCallback(
      (event: React.FormEvent<HTMLInputElement>) => onChangeText?.(event.currentTarget.value),
      [onChangeText],
    );
    return (
      <input
        ref={inputRef}
        defaultValue={props.initialValue}
        data-testid={props.testID}
        disabled={props.editable === false}
        onInput={handleInput}
      />
    );
  });
  return {
    AdaptiveModalSheet: ({ visible, children }: { visible: boolean; children: React.ReactNode }) =>
      visible ? <div>{children}</div> : null,
    AdaptiveTextInput: Input,
  };
});
vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onPress,
    disabled,
    testID,
  }: {
    children: React.ReactNode;
    onPress?: () => void;
    disabled?: boolean;
    testID?: string;
  }) => (
    <button type="button" disabled={disabled} data-testid={testID} onClick={onPress}>
      {children}
    </button>
  ),
}));
let root: Root;
let query: QueryClient;
let host: HTMLDivElement;
const close = vi.fn();
const workspace = { serverId: "host", workspaceId: "workspace", name: "Original title" };
const titles = ["Fix keyboard focus", "Restore dialog focus", "Improve workspace navigation"];

beforeEach(() => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    Node: dom.window.Node,
    React,
    IS_REACT_ACT_ENVIRONMENT: true,
  }))
    vi.stubGlobal(key, value);
  state.supported = true;
  state.suggest.mockReset().mockResolvedValue(titles);
  state.save.mockReset().mockResolvedValue();
  close.mockReset();
  query = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  query.clear();
  vi.unstubAllGlobals();
});
function render(visible = true) {
  act(() =>
    root.render(
      <QueryClientProvider client={query}>
        <WorkspaceRenameModal
          visible={visible}
          workspace={workspace}
          onClose={close}
          testID="rename"
        />
      </QueryClientProvider>,
    ),
  );
}
function input() {
  const node = host.querySelector("input");
  if (!node) throw new Error("Missing input");
  return node;
}
function button(text: string) {
  const node = [...host.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === text,
  );
  if (!node) throw new Error(`Missing button ${text}`);
  return node;
}
async function ready() {
  await act(async () => {
    await vi.waitFor(() => expect(host.textContent).toContain(titles[0]));
  });
}
function click(text: string) {
  act(() => button(text).click());
}

test("late suggestions preserve typed text; selection fills input and only Save commits", async () => {
  let resolve!: (titles: string[]) => void;
  state.suggest.mockReturnValueOnce(
    new Promise((accept) => {
      resolve = accept;
    }),
  );
  render();
  act(() => {
    input().value = "My manual title";
    input().dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  await act(async () => {
    resolve(titles);
  });
  await ready();
  expect(input().value).toBe("My manual title");
  expect(state.save).not.toHaveBeenCalled();
  click(titles[0]);
  expect(input().value).toBe(titles[0]);
  expect(state.save).not.toHaveBeenCalled();
  click("sidebar.workspace.rename.submit");
  await act(async () => {
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
  });
  expect(state.save).toHaveBeenCalledWith("workspace", titles[0]);
});
test("reopening reuses suggestions; Regenerate requests new alternatives; Cancel does not save", async () => {
  render();
  await ready();
  render(false);
  render();
  await ready();
  expect(state.suggest).toHaveBeenCalledTimes(1);
  click("Regenerate");
  await act(async () => {
    await vi.waitFor(() => expect(state.suggest).toHaveBeenCalledTimes(2));
  });
  expect(state.suggest).toHaveBeenLastCalledWith("workspace", true);
  click("common.actions.cancel");
  expect(close).toHaveBeenCalledOnce();
  expect(state.save).not.toHaveBeenCalled();
});
test("provider failure stays visible and Retry recovers", async () => {
  state.suggest.mockRejectedValueOnce(new Error("Host disconnected. Reconnect and try again."));
  render();
  await act(async () => {
    await vi.waitFor(() => expect(host.textContent).toContain("Host disconnected"));
  });
  click("Retry");
  await ready();
  expect(host.textContent).not.toContain("Host disconnected");
});
test("save failure preserves the chosen title and keeps the dialog open", async () => {
  state.save.mockRejectedValueOnce(new Error("Save failed"));
  render();
  await ready();
  click(titles[1]);
  click("sidebar.workspace.rename.submit");
  await act(async () => {
    await vi.waitFor(() => expect(host.textContent).toContain("Save failed"));
  });
  expect(input().value).toBe(titles[1]);
  expect(close).not.toHaveBeenCalled();
});
test("older hosts explain availability and retain ordinary rename", () => {
  state.supported = false;
  render();
  expect(host.textContent).toContain(
    "Reconnect to refresh the host's capabilities. If suggestions remain unavailable, update the host and choose an available model in Metadata generation.",
  );
  expect(state.suggest).not.toHaveBeenCalled();
  expect(input().value).toBe("Original title");
});
