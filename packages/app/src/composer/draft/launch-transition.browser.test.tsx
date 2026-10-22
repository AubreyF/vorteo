import React, { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Text } from "react-native";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LaunchPickerCollapse } from "./launch-transition";

// App sources compile against the classic JSX runtime, which expects React on the global.
beforeEach(() => vi.stubGlobal("React", React));

interface Mounted {
  root: Root;
  container: HTMLDivElement;
}

const mounted: Mounted[] = [];

function mount(): { container: HTMLDivElement; render: (node: ReactNode) => void } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  return { container, render: (node) => act(() => root.render(node)) };
}

function picker(collapsed: boolean) {
  return (
    <LaunchPickerCollapse collapsed={collapsed} stackGap={16}>
      <Text>Environment Account Profile</Text>
    </LaunchPickerCollapse>
  );
}

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
});

describe("LaunchPickerCollapse", () => {
  it("never renders a picker that starts collapsed mid-launch", () => {
    const { container, render } = mount();
    render(picker(true));
    expect(container.textContent).toBe("");
  });

  it("tucks the picker away after submit and restores it when creation fails", async () => {
    const { container, render } = mount();
    render(picker(false));
    expect(container.textContent).toContain("Environment Account Profile");

    render(picker(true));
    await vi.waitFor(() => expect(container.textContent).toBe(""), { timeout: 2000 });

    render(picker(false));
    expect(container.textContent).toContain("Environment Account Profile");
  });
});
