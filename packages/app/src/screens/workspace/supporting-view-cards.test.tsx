/** @vitest-environment jsdom */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupportingViewCardsProps } from "./supporting-view-cards";

vi.stubGlobal("React", React);
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

vi.mock("react-native", () => ({ Dimensions: { get: () => ({ width: 1800, height: 1000 }) } }));
vi.mock("@/constants/platform", () => ({ isWeb: true }));
vi.mock("@/storage/app-storage", () => ({
  default: {
    getItem: async () => null,
    setItem: async () => {},
    removeItem: async () => {},
  },
}));
vi.mock("@/agent-stream/task-card", () => ({
  TaskCard: ({ children }: React.PropsWithChildren) => <section>{children}</section>,
  TaskCardHeader: ({ children }: React.PropsWithChildren) => <header>{children}</header>,
  TaskCardAction: ({
    onPress,
    accessibilityLabel,
  }: {
    onPress: () => void;
    accessibilityLabel: string;
  }) => (
    <button type="button" onClick={onPress}>
      {accessibilityLabel}
    </button>
  ),
}));
vi.mock("@/agent-stream/task-card-icon", () => ({ TaskCardIcon: () => null }));
vi.mock("lucide-react-native", () => ({ X: () => null }));
vi.mock("@/agent-stream/card-disclosure", () => ({
  CardDisclosure: ({
    title,
    expanded,
    onPress,
  }: {
    title: string;
    expanded: boolean;
    onPress: () => void;
  }) => (
    <button type="button" aria-expanded={expanded} onClick={onPress}>
      {title}
    </button>
  ),
}));
vi.mock("@/components/retained-panel", () => ({
  RetainedPanel: ({ active, children }: React.PropsWithChildren<{ active: boolean }>) => (
    <div hidden={!active}>{children}</div>
  ),
}));
vi.mock("./workspace-tab-presentation", () => ({
  WorkspaceTabPresentationResolver: ({
    tab,
    children,
  }: {
    tab: { kind: string };
    children: (value: { label: string }) => React.ReactNode;
  }) => children({ label: tab.kind }),
}));
vi.mock("./workspace-pane-state", () => ({
  deriveWorkspacePaneState: ({
    pane,
    tabs,
  }: {
    pane: { focusedTabId: string };
    tabs: { tabId: string; target: { kind: string } }[];
  }) => ({
    activeTabId: pane.focusedTabId,
    tabs: tabs.map((tab) => ({ descriptor: { ...tab, key: tab.tabId, kind: tab.target.kind } })),
  }),
}));
vi.mock("./workspace-pane-content", () => ({
  WorkspacePaneContent: ({ content }: { content: { key: string } }) => (
    <input aria-label={`${content.key} state`} defaultValue="retained selection" />
  ),
}));

import { usePanelStore } from "@/stores/panel-store";
import { CardColumnContext } from "@/agent-stream/columns/card-column";
import { SupportingViewCards } from "./supporting-view-cards";
import {
  requestSupportingCard,
  useSupportingCardRequests,
} from "@/workspace-tabs/supporting-card-requests";

const column = { heights: new Map<string, number>(), measure: () => {} };

describe("supporting view cards", () => {
  let container: HTMLDivElement;
  let root: Root;
  const select = vi.fn();
  const close = vi.fn();
  const buildContent = vi.fn(({ tab }: { tab: { tabId: string } }) => ({
    key: tab.tabId,
    paneContextValue: { closeCurrentTab: close },
  })) as unknown as SupportingViewCardsProps["buildPaneContentModel"];
  const props: SupportingViewCardsProps = {
    pane: { id: "explorer", tabIds: ["files", "changes"], focusedTabId: "files" },
    uiTabs: [
      { tabId: "files", target: { kind: "files" }, createdAt: 1 },
      { tabId: "changes", target: { kind: "changes_tree" }, createdAt: 2 },
    ],
    normalizedServerId: "host",
    normalizedWorkspaceId: "workspace",
    isWorkspaceFocused: true,
    onSelectTab: select,
    buildPaneContentModel: buildContent,
  };
  const render = (value = props) =>
    act(() =>
      root.render(
        <CardColumnContext.Provider value={column}>
          <SupportingViewCards {...value} />
        </CardColumnContext.Provider>,
      ),
    );
  const disclosure = (title: string) =>
    [...container.querySelectorAll("button")].find((button) => button.textContent === title)!;
  beforeEach(() => {
    vi.clearAllMocks();
    usePanelStore.setState({ supportingCardExpanded: { files: true }, inlineCardExpanded: {} });
    useSupportingCardRequests.setState({ requests: {} });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("keeps every card type independent between sidebar and inline layouts", () => {
    for (const kind of [
      "goal",
      "tasks",
      "journal",
      "queue",
      "subagents",
      "providerSubagents",
      "files",
      "changes",
    ] as const) {
      const set = usePanelStore.getState().setSupportingCardExpanded;
      set(kind, true, "sidebar");
      set(kind, false, "inline");
      expect(usePanelStore.getState().supportingCardExpanded[kind]).toBe(true);
      expect(usePanelStore.getState().inlineCardExpanded[kind]).toBe(false);
      set(kind, (current) => !current, "sidebar");
      expect(usePanelStore.getState().inlineCardExpanded[kind]).toBe(false);
      set(kind, (current) => !current, "inline");
      expect(usePanelStore.getState().supportingCardExpanded[kind]).toBe(false);
      expect(usePanelStore.getState().inlineCardExpanded[kind]).toBe(true);
    }
  });

  it("keeps both designated cards and preserves panel state across folding", () => {
    render();
    const files = container.querySelector<HTMLInputElement>('[aria-label="files state"]')!;
    files.value = "selected nested file";
    act(() => disclosure("files").click());
    expect(disclosure("files").getAttribute("aria-expanded")).toBe("false");
    expect(files.parentElement?.hidden).toBe(true);
    act(() => disclosure("files").click());
    expect(container.querySelector('[aria-label="files state"]')).toBe(files);
    expect(files.value).toBe("selected nested file");
    expect(disclosure("changes_tree")).toBeTruthy();
  });

  it("selects a folded view without folding the other open card", () => {
    render();
    act(() => disclosure("changes_tree").click());
    expect(select).toHaveBeenCalledWith("explorer", "changes");
    render({ ...props, pane: { ...props.pane, focusedTabId: "changes" } });
    expect(disclosure("files").getAttribute("aria-expanded")).toBe("true");
    expect(disclosure("changes_tree").getAttribute("aria-expanded")).toBe("true");
  });

  it("preserves disclosure preferences when another workspace selects a different view", () => {
    render();
    expect(disclosure("changes_tree").getAttribute("aria-expanded")).toBe("false");
    render({
      ...props,
      normalizedWorkspaceId: "another-workspace",
      pane: { ...props.pane, focusedTabId: "changes" },
    });
    expect(disclosure("changes_tree").getAttribute("aria-expanded")).toBe("false");
    act(() => requestSupportingCard("host:another-workspace", "changes_tree"));
    expect(disclosure("changes_tree").getAttribute("aria-expanded")).toBe("true");
  });

  it("reveals the already selected card after it was folded", () => {
    render();
    act(() => disclosure("files").click());
    expect(disclosure("files").getAttribute("aria-expanded")).toBe("false");
    act(() => requestSupportingCard("host:workspace", "files"));
    expect(disclosure("files").getAttribute("aria-expanded")).toBe("true");
    act(() => disclosure("files").click());
    act(() => requestSupportingCard("host:workspace", "files"));
    expect(disclosure("files").getAttribute("aria-expanded")).toBe("true");
  });

  it("keeps a close action for other retained supporting tabs", () => {
    render({
      ...props,
      uiTabs: [
        ...props.uiTabs,
        { tabId: "file", target: { kind: "file", path: "/repo/file.ts" }, createdAt: 3 },
      ],
    });
    act(() => disclosure("Close file").click());
    expect(close).toHaveBeenCalledOnce();
    expect(disclosure("Close files")).toBeUndefined();
  });
});
