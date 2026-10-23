/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { theme } = vi.hoisted(() => {
  // Tokens this test asserts on are explicit. Badges and tooltips the row renders read many
  // more; those resolve to a neutral placeholder so unrelated styling cannot break the test.
  const placeholder = (): unknown =>
    new Proxy(() => 0, {
      get: (_target, key) => (key === Symbol.toPrimitive ? () => 0 : placeholder()),
    });
  const withFallback = <T extends object>(value: T): T =>
    new Proxy(value, {
      get: (target, key) => {
        const entry = Reflect.get(target, key);
        if (entry === undefined) return placeholder();
        return typeof entry === "object" && entry !== null ? withFallback(entry) : entry;
      },
    });
  return {
    theme: withFallback({
      spacing: { 2: 8 },
      fontSize: { sm: 13 },
      colors: {
        foreground: "#foreground",
        foregroundMuted: "#muted",
        foregroundExtraMuted: "#extra-muted",
        statusDotRunning: "#running",
      },
    }),
  };
});

vi.mock("react-native", async (original) => ({
  ...(await original<typeof import("react-native")>()),
  View: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
    React.createElement("div", props, children),
  Text: ({ children, style }: React.PropsWithChildren<{ style?: Record<string, unknown>[] }>) => {
    const resolvedStyle = Object.assign({}, ...(style ?? []).filter(Boolean));
    return React.createElement(
      "span",
      {
        "data-color": resolvedStyle.color,
        "data-decoration": resolvedStyle.textDecorationLine,
      },
      children,
    );
  },
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: (value: typeof theme) => unknown) => factory(theme),
  },
  withUnistyles:
    (Component: React.ComponentType<Record<string, unknown>>) =>
    ({ uniProps, ...props }: Record<string, unknown>) => {
      // Unistyles makes uniProps optional; components without it pass props through.
      const themedProps =
        typeof uniProps === "function"
          ? (uniProps as (value: typeof theme) => Record<string, unknown>)(theme)
          : {};
      return React.createElement(Component, { ...props, ...themedProps });
    },
}));

vi.mock("lucide-react-native", () => {
  const createIcon = (name: string) => (props: Record<string, unknown>) =>
    React.createElement("span", { ...props, "data-icon": name });
  return {
    Circle: createIcon("Circle"),
    CircleCheck: createIcon("CircleCheck"),
    CircleDot: createIcon("CircleDot"),
    CircleAlert: createIcon("CircleAlert"),
    Eye: createIcon("Eye"),
  };
});

// The spinning ring uses Web Animations, which jsdom lacks; its own suites cover the drawing.
vi.mock("@/components/status-ring", () => ({
  StatusRing: ({ variant }: { variant: string }) =>
    React.createElement("span", { "data-icon": "StatusRing", "data-variant": variant }),
}));

vi.stubGlobal("React", React);
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

import { TaskListRow } from "./task-list-row";

const pendingTask = { text: "Queued", completed: false } as const;
const runningTask = {
  text: "Run checks",
  activeForm: "Running checks",
  completed: false,
  status: "in_progress",
} as const;
const completedTask = { text: "Finished", completed: true, status: "completed" } as const;

describe("TaskListRow", () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("keeps a pending task's ring quieter than its label, so it does not read as a checkbox", () => {
    act(() => root.render(<TaskListRow task={pendingTask} />));

    expect(container.querySelector('[data-icon="Circle"]')?.getAttribute("color")).toBe(
      "#extra-muted",
    );
    expect(container.querySelector("[data-color]")?.getAttribute("data-color")).toBe("#muted");
  });

  it("foregrounds only the running task with the running status ring", () => {
    act(() => root.render(<TaskListRow task={runningTask} />));

    expect(container.textContent).toBe("Running checks");
    expect(container.querySelector('[data-icon="StatusRing"]')?.getAttribute("data-variant")).toBe(
      "task",
    );
    expect(container.querySelector("[data-color]")?.getAttribute("data-color")).toBe("#foreground");
  });

  it("extra-mutes completed tasks with a circle check", () => {
    act(() => root.render(<TaskListRow task={completedTask} />));

    expect(container.querySelector('[data-icon="CircleCheck"]')?.getAttribute("color")).toBe(
      "#extra-muted",
    );
    const text = container.querySelector("[data-color]");
    expect(text?.getAttribute("data-color")).toBe("#extra-muted");
    expect(text?.getAttribute("data-decoration")).toBe("line-through");
  });
});
