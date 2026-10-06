/** @vitest-environment jsdom */
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceScriptPayload } from "@getpaseo/protocol/messages";
import { WorkspacePreviewRows } from "./workspace-preview-rows";

const state = vi.hoisted(() => ({
  open: vi.fn(),
  theme: {
    spacing: { 1.5: 6, 3: 12 },
    fontSize: { sm: 13 },
    fontWeight: { normal: "400" },
    colors: {
      foregroundMuted: "#aaa",
      statusSuccess: "#0a0",
      statusDanger: "#a00",
      surface2: "#222",
    },
  },
}));
vi.mock("@/utils/open-external-url", () => ({ openExternalUrl: state.open }));
vi.mock("react-native-unistyles", () => ({
  StyleSheet: { create: (factory: (theme: typeof state.theme) => unknown) => factory(state.theme) },
  withUnistyles:
    (Component: React.ComponentType<Record<string, unknown>>) =>
    ({ uniProps, ...props }: { uniProps: (theme: typeof state.theme) => object }) => (
      <Component {...props} {...uniProps(state.theme)} />
    ),
}));
function script(
  scriptName: string,
  patch: Partial<WorkspaceScriptPayload> = {},
): WorkspaceScriptPayload {
  return {
    scriptName,
    type: "service",
    hostname: "web.localhost",
    port: 3000,
    proxyUrl: "http://web.localhost:6767",
    publicProxyUrl: "https://preview.example.ts.net:32780",
    lifecycle: "running",
    health: "healthy",
    exitCode: null,
    terminalId: null,
    ...patch,
  };
}
beforeEach(() => {
  vi.stubGlobal("React", React);
});
afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
  state.open.mockReset();
});
describe("workspace preview rows", () => {
  it("opens the exact private HTTPS URL for each service", () => {
    render(
      <WorkspacePreviewRows
        scripts={[
          script("web"),
          script("docs", { publicProxyUrl: "https://preview.example.ts.net:32781" }),
        ]}
      />,
    );
    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(2);
    expect(links[0].tagName).toBe("A");
    expect(links[0].getAttribute("href")).toBe("https://preview.example.ts.net:32780");
    fireEvent.click(links[1]);
    expect(state.open).toHaveBeenCalledWith("https://preview.example.ts.net:32781");
    fireEvent.click(links[0]);
    expect(state.open).toHaveBeenLastCalledWith("https://preview.example.ts.net:32780");
  });
  it("omits stopped services, plain scripts and localhost-only services", () => {
    render(
      <WorkspacePreviewRows
        scripts={[
          script("stopped", { lifecycle: "stopped" }),
          script("command", { type: "script" }),
          script("local", { publicProxyUrl: null }),
        ]}
      />,
    );
    expect(screen.queryAllByRole("link")).toHaveLength(0);
  });
  it("shows previews independently of legacy mode preferences", () => {
    render(<WorkspacePreviewRows scripts={[script("web")]} />);
    expect(screen.queryAllByRole("link")).toHaveLength(1);
  });
});
