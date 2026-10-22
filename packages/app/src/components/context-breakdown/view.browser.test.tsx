import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { within } from "@testing-library/dom";
import type { AgentContextBreakdown } from "@getpaseo/protocol/agent-context";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n as testI18n } from "@/i18n/i18next";
import type { ContextBreakdownView } from "./use-context-breakdown";

// Load translations so rows expose their real labels.
void testI18n;

// The suite stubs react-native-svg to nothing; draw plain SVG so the donut's arcs can be counted.
vi.mock("react-native-svg", () => ({
  default: (props: React.SVGProps<SVGSVGElement>) => <svg {...props} />,
  Circle: ({ cx, cy, r }: React.SVGProps<SVGCircleElement>) => <circle cx={cx} cy={cy} r={r} />,
}));

const { ContextBreakdown } = await import("./view");

// App sources compile against the classic JSX runtime, which expects React on the global.
beforeEach(() => vi.stubGlobal("React", React));

const BREAKDOWN: AgentContextBreakdown = {
  model: "claude-opus-5-5",
  totalTokens: 140_500,
  maxTokens: 1_000_000,
  categories: [
    { name: "System prompt", tokens: 11_400, kind: "used" },
    { name: "System tools", tokens: 19_300, kind: "used" },
    { name: "MCP tools", tokens: 16_600, kind: "used" },
    { name: "Memory files", tokens: 1_900, kind: "used" },
    { name: "Skills", tokens: 7_000, kind: "used" },
    { name: "Messages", tokens: 27_600, kind: "used" },
    { name: "Since last update", tokens: 52_700, kind: "used" },
    { name: "Autocompact buffer", tokens: 33_000, kind: "buffer" },
    { name: "Free space", tokens: 826_500, kind: "free" },
    { name: "MCP tools (deferred)", tokens: 161_600, kind: "deferred" },
  ],
  groups: [
    {
      id: "mcp_tools",
      items: [
        { name: "mcp__paseo__update_checklist", detail: "paseo", tokens: 2_100 },
        { name: "mcp__paseo__get_checklist", detail: "paseo", tokens: 400 },
      ],
    },
    { id: "memory_files", items: [{ name: "CLAUDE.md", detail: "Project", tokens: 1_900 }] },
  ],
  observedAt: "2026-10-21T12:00:00.000Z",
};

const mounted: { root: Root; container: HTMLDivElement }[] = [];

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
});

function mount(view: ContextBreakdownView, interactive = true, loading = false) {
  const container = document.createElement("div");
  container.style.width = "320px";
  container.style.padding = "16px";
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() =>
    root.render(
      <ContextBreakdown
        view={view}
        loading={loading}
        percentage={14}
        usedTokens={140_500}
        maxTokens={1_000_000}
        sessionCost="$4.20"
        interactive={interactive}
      />,
    ),
  );
  mounted.push({ root, container });
  return { container, view: within(container) };
}

describe("ContextBreakdown", () => {
  it("draws every reported category and expands item groups", () => {
    const { container, view } = mount({ kind: "ready", breakdown: BREAKDOWN });
    for (const label of ["Messages", "Since last update", "Free space", "MCP tools (deferred)"]) {
      expect(view.getByText(label)).toBeTruthy();
    }
    expect(view.getByText("2.8%")).toBeTruthy();
    // Track plus nine drawn segments; the deferred row stays out of the donut.
    expect(container.querySelectorAll("circle")).toHaveLength(10);
    expect(view.queryByText("mcp__paseo__update_checklist")).toBeNull();
    act(() => view.getByTestId("context-breakdown-group-mcp_tools").click());
    expect(view.getByText("mcp__paseo__update_checklist")).toBeTruthy();
  });

  it("shows used and free space for providers that report totals only", () => {
    const { container, view } = mount({ kind: "totals" });
    expect(view.getByText("Used")).toBeTruthy();
    expect(view.getByText("Free space")).toBeTruthy();
    expect(view.getByText("This provider reports totals only.")).toBeTruthy();
    expect(container.querySelectorAll("circle")).toHaveLength(3);
  });

  it("shows one loading pulse instead of rows while anything loads", () => {
    const { container, view } = mount({ kind: "loading" }, true, true);
    expect(view.getByTestId("context-breakdown-loading")).toBeTruthy();
    expect(view.getByText("14% used")).toBeTruthy();
    expect(view.queryByText("Used")).toBeNull();
    expect(container.textContent).not.toMatch(/loading/i);
  });

  it("lists groups without expansion where the surface cannot be pressed", () => {
    const { view } = mount({ kind: "ready", breakdown: BREAKDOWN }, false);
    // Claude reports MCP tools both as a category row and as an item group.
    expect(view.getAllByText("MCP tools")).toHaveLength(2);
    expect(view.queryByTestId("context-breakdown-group-mcp_tools")).toBeNull();
  });
});
