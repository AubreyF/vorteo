import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ServiceItem, WorkspaceMetaRow } from "./index";
import { useSidebarMetaPreferences } from "@/components/sidebar/display-preferences/model";
import { DEFAULT_SIDEBAR_ROW_ITEMS } from "@/components/sidebar/display-preferences/row-items";
import { en } from "@/i18n/resources/en";
import type { PrHint } from "@/git/pr-hint";

vi.mock("@/utils/open-external-url", () => ({ openExternalUrl: vi.fn() }));
vi.mock("@/components/sidebar/display-preferences/model", () => ({
  useSidebarMetaPreferences: vi.fn(),
}));
vi.mock("@/workspace-labels/chip", () => ({
  WorkspaceLabelChip: () => null,
  WORKSPACE_LABEL_CHIP_INSET: 0,
}));
vi.mock("@/hosts/host-badge", () => ({ HostBadge: () => null, HOST_BADGE_ICON_SIZE: 12 }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: { name?: string; number?: number }) => {
      const states: Record<string, string> = en.workspace.git.pr.states;
      if (key.startsWith("workspace.git.pr.states.")) return states[key.split(".").at(-1)!];
      if (key === "workspace.git.pr.accessibility.pullRequest")
        return `Pull request ${values?.number}`;
      return `${key}: ${values?.name}`;
    },
  }),
}));

const summary = { name: "preview", health: "healthy" } as const;
const unhealthy = { name: "preview", health: "unhealthy" } as const;

it("keeps the preview icon on the title line and restores the named service in Paseo", () => {
  vi.stubGlobal("React", React);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    act(() => root.render(<ServiceItem summary={summary} iconOnly />));
    expect(container.textContent).toBe("");
    const icon = container.querySelector('[data-testid="workspace-service"]');
    expect(icon?.getAttribute("aria-label")).toBe("workspace.status.serviceRunning: preview");
    expect(icon?.getBoundingClientRect().height).toBe(20);
    act(() => root.render(<ServiceItem summary={summary} />));
    expect(container.textContent).toBe("preview");
    act(() => root.render(<ServiceItem summary={unhealthy} iconOnly />));
    expect(container.querySelector('[data-testid="workspace-service-unhealthy"]')).not.toBeNull();
  } finally {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it.each([240, 380])("keeps merge activity in the existing accessible PR link at %ipx", (width) => {
  vi.stubGlobal("React", React);
  vi.mocked(useSidebarMetaPreferences).mockReturnValue({
    rowItems: DEFAULT_SIDEBAR_ROW_ITEMS,
    checksDisplay: "none",
  });
  const container = document.createElement("div");
  container.style.width = `${width}px`;
  document.body.append(container);
  const root = createRoot(container);
  const hint: PrHint = {
    url: "https://github.com/acme/repo/pull/42",
    number: 42,
    state: "open",
    forge: "github",
  };
  const render = (prHint: PrHint) =>
    act(() =>
      root.render(
        <WorkspaceMetaRow
          currentBranch={null}
          projectName={null}
          hostBadge={null}
          serviceSummary={null}
          prHint={prHint}
        />,
      ),
    );
  try {
    for (const [activity, label] of [
      ["awaiting_merge", "Awaiting merge"],
      ["merging", "Merging"],
    ] as const) {
      render({ ...hint, activity });
      const links = container.querySelectorAll('[role="link"]');
      expect(links.length).toBe(1);
      expect(links[0].textContent).toBe(`42 ${label}`);
      expect(links[0].getAttribute("aria-label")).toBe(`Pull request 42, ${label}`);
      expect(links[0].getBoundingClientRect().right).toBeLessThanOrEqual(
        container.getBoundingClientRect().right,
      );
    }
    render({ ...hint, state: "merged", activity: "merging" });
    expect(container.textContent).toBe("42 Merged");
    render(hint);
    expect(container.textContent).toBe("42");
  } finally {
    act(() => root.unmount());
    container.remove();
    vi.mocked(useSidebarMetaPreferences).mockReset();
    vi.unstubAllGlobals();
  }
});
