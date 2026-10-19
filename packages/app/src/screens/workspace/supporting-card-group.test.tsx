/** @vitest-environment jsdom */
import React, { act, useCallback, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Portal, PortalProvider } from "@gorhom/portal";
import { SupportingCardGroup } from "./supporting-card-group";
import {
  PanePortal,
  PaneProvider,
  PaneFocusProvider,
  usePaneContext,
  usePaneFocus,
  createPaneFocusContextValue,
  type PaneContextValue,
} from "@/panels/pane-context";

vi.stubGlobal("React", React);
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

let root: Root;
let container: HTMLDivElement;
const mounted = vi.fn();
const unmounted = vi.fn();

function FileDraft() {
  useEffect(() => {
    mounted();
    return () => unmounted();
  }, []);
  return <input aria-label="Unsaved file draft" defaultValue="original" />;
}

function Workspace({ agent, visible = true }: { agent: string | null; visible?: boolean }) {
  return (
    <PortalProvider>
      {agent ? (
        <Portal hostName="workspace-cards">
          <span>{agent} tasks</span>
        </Portal>
      ) : null}
      <SupportingCardGroup visible={visible} supportingVisible={visible} hostName="workspace-cards">
        <FileDraft />
      </SupportingCardGroup>
    </PortalProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

it("retains a modified panel while conversations change and the group hides", () => {
  act(() => root.render(<Workspace agent="first" />));
  const draft = container.querySelector<HTMLInputElement>("input")!;
  draft.value = "unsaved work";
  expect(container.textContent).toContain("first tasks");
  act(() => root.render(<Workspace agent={null} visible={false} />));
  expect(container.textContent).not.toContain("first tasks");
  act(() => root.render(<Workspace agent="second" />));
  expect(container.textContent).toContain("second tasks");
  expect(container.querySelector("input")).toBe(draft);
  expect(draft.value).toBe("unsaved work");
  expect(mounted).toHaveBeenCalledTimes(1);
  expect(unmounted).not.toHaveBeenCalled();
});

it("preserves the source pane's navigation and focus in contributed cards", () => {
  const openTab = vi.fn();
  const pane = createNavigationPane(openTab);
  function AgentCard() {
    const context = usePaneContext();
    const focus = usePaneFocus();
    const openFiles = useCallback(() => context.openTab({ kind: "files" }), [context]);
    return (
      <button type="button" disabled={!focus.isInteractive} onClick={openFiles}>
        {context.tabId}
      </button>
    );
  }
  act(() =>
    root.render(
      <PortalProvider>
        <PaneProvider value={pane}>
          <PaneFocusProvider
            value={createPaneFocusContextValue({ isWorkspaceFocused: true, isPaneFocused: true })}
          >
            <PanePortal hostName="workspace-cards">
              <AgentCard />
            </PanePortal>
          </PaneFocusProvider>
        </PaneProvider>
        <SupportingCardGroup visible supportingVisible={false} hostName="workspace-cards">
          <FileDraft />
        </SupportingCardGroup>
      </PortalProvider>,
    ),
  );
  const button = container.querySelector("button")!;
  expect(button.textContent).toBe("source-agent");
  expect(button.disabled).toBe(false);
  act(() => button.click());
  expect(openTab).toHaveBeenCalledWith({ kind: "files" });
});

function createNavigationPane(openTab: PaneContextValue["openTab"]): PaneContextValue {
  return {
    serverId: "server",
    workspaceId: "workspace",
    host: "main",
    tabId: "source-agent",
    target: { kind: "agent", agentId: "source-agent" },
    openTab,
    openPreferredTarget: vi.fn(),
    closeCurrentTab: vi.fn(),
    retargetCurrentTab: vi.fn(),
    setCurrentTabState: vi.fn(),
    openFileInWorkspace: vi.fn(),
    openImportSheet: vi.fn(),
  };
}
