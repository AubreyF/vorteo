import React, { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MermaidIframeRuntime, type MermaidRenderedMessage } from "./iframe-runtime.web";

beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});
afterEach(() => vi.unstubAllGlobals());

it("an optional diagram runtime waits for consent before its download or execution", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const rendered: MermaidRenderedMessage[] = [];
  const failures: number[] = [];
  const props = {
    request: { revision: 1, source: "flowchart LR\n A --> B", colorScheme: "dark" as const },
    onRendered: (message: MermaidRenderedMessage) => {
      rendered.push(message);
    },
    onRenderFailed: (revision: number) => {
      failures.push(revision);
    },
  };
  try {
    await act(async () => {
      root.render(createElement(MermaidIframeRuntime, { ...props, enabled: false }));
    });
    expect(container.querySelector("iframe")).toBeNull();
    expect(rendered).toEqual([]);
    expect(
      performance
        .getEntriesByType("resource")
        .filter((entry) => entry.name.includes("runtime/html.gen")),
    ).toEqual([]);
    await act(async () => {
      root.render(createElement(MermaidIframeRuntime, { ...props, enabled: true }));
    });
    await expect.poll(() => rendered.at(-1)?.revision, { timeout: 20000 }).toBe(1);
    expect(container.querySelector("iframe")).not.toBeNull();
    expect(failures).toEqual([]);
    await act(async () => {
      root.render(createElement(MermaidIframeRuntime, { ...props, enabled: false }));
    });
    expect(container.querySelector("iframe")).toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
}, 25000);

it("loads the renderer on mount and renders the latest request", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const rendered: MermaidRenderedMessage[] = [];
  const failures: number[] = [];
  const onRendered = (message: MermaidRenderedMessage) => {
    rendered.push(message);
  };
  const onRenderFailed = (revision: number) => {
    failures.push(revision);
  };
  try {
    await act(async () => {
      root.render(
        createElement(MermaidIframeRuntime, {
          request: { revision: 1, source: "flowchart LR\n A --> B", colorScheme: "dark" },
          onRendered,
          onRenderFailed,
        }),
      );
    });
    await expect.poll(() => rendered.at(-1)?.revision, { timeout: 20000 }).toBe(1);
    expect(rendered[0].width).toBeGreaterThan(0);
    await act(async () => {
      root.render(
        createElement(MermaidIframeRuntime, {
          request: { revision: 2, source: "flowchart LR\n B --> C", colorScheme: "light" },
          onRendered,
          onRenderFailed,
        }),
      );
    });
    await expect.poll(() => rendered.at(-1)?.revision, { timeout: 20000 }).toBe(2);
    expect(rendered.at(-1)?.source).toBe("flowchart LR\n B --> C");
    expect(failures).toEqual([]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
