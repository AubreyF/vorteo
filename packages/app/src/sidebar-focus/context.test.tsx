// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  KeyboardActionDispatcherProvider,
  useKeyboardActionDispatcher,
} from "@/keyboard/keyboard-action-dispatcher-context";
import { useSidebarFocusController } from "./context";
import type { SidebarFocusWorld } from "./model";
import { useSidebarFocusStore } from "./store";

const world: SidebarFocusWorld = {
  folders: {},
  itemFolder: {},
  projects: new Map([["app", { name: "App", sections: [] }]]),
  hiddenFolderIds: new Set(),
};
const ESCAPE = { id: "agent.interrupt", scope: "global" } as const;

function wrapper({ children }: { children: ReactNode }) {
  return <KeyboardActionDispatcherProvider>{children}</KeyboardActionDispatcherProvider>;
}

function renderController() {
  return renderHook(
    () => ({
      controller: useSidebarFocusController({ world, enabled: true }),
      dispatcher: useKeyboardActionDispatcher(),
    }),
    { wrapper },
  );
}

function focusableIn(scope: boolean): HTMLButtonElement {
  const container = document.createElement("div");
  if (scope) container.dataset.sidebarFocusScope = "";
  const button = document.createElement("button");
  container.append(button);
  document.body.append(container);
  return button;
}

beforeEach(() => {
  useSidebarFocusStore.setState({
    focus: { target: { kind: "project", projectKey: "app" }, ancestors: [] },
  });
});

afterEach(() => {
  document.body.replaceChildren();
});

describe("sidebar focus Escape", () => {
  it("leaves focus while keyboard focus is in the sidebar", () => {
    const { result } = renderController();
    expect(result.current.controller.focus).toEqual({ kind: "project", projectKey: "app" });
    focusableIn(true).focus();
    let handled = false;
    act(() => {
      handled = result.current.dispatcher.dispatch(ESCAPE);
    });
    expect(handled).toBe(true);
    expect(useSidebarFocusStore.getState().focus).toBeNull();
    expect(result.current.controller.focus).toBeNull();
  });

  it("leaves Escape to other surfaces, such as agent interrupt, outside the sidebar", () => {
    const { result } = renderController();
    focusableIn(false).focus();
    expect(result.current.dispatcher.dispatch(ESCAPE)).toBe(false);
    expect(useSidebarFocusStore.getState().focus?.target).toEqual({
      kind: "project",
      projectKey: "app",
    });
  });

  it("stores the ancestors of a newly focused item for later fallback", () => {
    const { result } = renderController();
    act(() => {
      result.current.controller.focusOn({
        kind: "section",
        projectKey: "app",
        section: "standing",
      });
    });
    expect(useSidebarFocusStore.getState().focus).toEqual({
      target: { kind: "section", projectKey: "app", section: "standing" },
      ancestors: [{ kind: "project", projectKey: "app" }],
    });
  });
});
