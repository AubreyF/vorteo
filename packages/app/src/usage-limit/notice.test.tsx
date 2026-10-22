// @vitest-environment jsdom
import type { UsageLimitHold } from "@getpaseo/protocol/usage-limit";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { UsageLimitNotice } from "./notice";
import { UsageLimitResumeSwitch } from "./account-switch";

vi.hoisted(async () => {
  globalThis.React = await import("react");
});

const state = vi.hoisted(() => ({
  supported: true,
  connected: true,
  hold: undefined as UsageLimitHold | undefined,
  autoResume: undefined as boolean | undefined,
  setResume: vi.fn(),
  patchConfig: vi.fn(),
  reportError: vi.fn(),
}));

vi.mock("@/stores/session-store", () => ({
  useSessionStore: (selector: (store: unknown) => unknown) =>
    selector({
      sessions: {
        host: {
          serverInfo: { features: { usageLimitResume: state.supported } },
          agentDetails: new Map(),
          agents: new Map([["agent", { usageLimitHold: state.hold, archivedAt: null }]]),
        },
      },
    }),
}));
vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => ({ setAgentUsageLimitResume: state.setResume }),
  useHostRuntimeIsConnected: () => state.connected,
}));
vi.mock("@/runtime/host-features", () => ({
  useHostFeature: (_serverId: string, feature: string) =>
    feature === "usageLimitResume" && state.supported,
}));
vi.mock("@/hooks/use-daemon-config", () => ({
  useDaemonConfig: () => ({
    config: { providers: { claude: { autoResumeAfterUsageLimit: state.autoResume } } },
    patchConfig: state.patchConfig,
  }),
}));
vi.mock("@/hooks/use-action-error", () => ({ useReportActionError: () => state.reportError }));
vi.mock("@/components/ui/switch", async () => {
  const { useCallback } = await import("react");
  function Switch(props: {
    value: boolean;
    onValueChange: (value: boolean) => void;
    disabled?: boolean;
    testID?: string;
  }) {
    const { value, onValueChange } = props;
    const toggle = useCallback(() => onValueChange(!value), [value, onValueChange]);
    return (
      <button
        type="button"
        data-testid={props.testID}
        aria-checked={value}
        disabled={props.disabled}
        onClick={toggle}
      />
    );
  }
  return { Switch };
});

let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;

beforeEach(() => {
  state.supported = true;
  state.connected = true;
  state.hold = { stoppedAt: "2026-10-22T17:00:00.000Z", attempts: 0 };
  state.autoResume = undefined;
  vi.clearAllMocks();
  queryClient = new QueryClient();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function render(node: React.ReactNode) {
  await act(async () =>
    root.render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>),
  );
}

function find(testID: string) {
  return container.querySelector<HTMLElement>(`[data-testid="${testID}"]`);
}

it("offers both choices while the thread waits", async () => {
  state.setResume.mockResolvedValue(null);
  await render(<UsageLimitNotice serverId="host" agentId="agent" />);
  expect(container.textContent).toContain(
    "Usage limit reached. Resumes when the account has room again.",
  );
  expect(find("usage-limit-dont-resume")).not.toBeNull();
  await act(async () => find("usage-limit-resume-now")?.click());
  expect(state.setResume).toHaveBeenCalledWith("agent", "resume_now");
});

it("offers only Resume now once the owner opted out", async () => {
  state.hold = { stoppedAt: "2026-10-22T17:00:00.000Z", attempts: 0, optOut: true };
  await render(<UsageLimitNotice serverId="host" agentId="agent" />);
  expect(find("usage-limit-dont-resume")).toBeNull();
  expect(find("usage-limit-resume-now")).not.toBeNull();
});

it("reports a failed request as a toast", async () => {
  state.setResume.mockRejectedValue(new Error("Thread is not held"));
  await render(<UsageLimitNotice serverId="host" agentId="agent" />);
  await act(async () => find("usage-limit-dont-resume")?.click());
  expect(state.setResume).toHaveBeenCalledWith("agent", "dont_resume");
  expect(state.reportError).toHaveBeenCalled();
});

it("hides the notice for released holds and hosts without the feature", async () => {
  state.hold = {
    stoppedAt: "2026-10-22T17:00:00.000Z",
    attempts: 1,
    releasedAt: "2026-10-22T23:00:00.000Z",
  };
  await render(<UsageLimitNotice serverId="host" agentId="agent" />);
  expect(find("usage-limit-notice")).toBeNull();
  state.hold = { stoppedAt: "2026-10-22T17:00:00.000Z", attempts: 0 };
  state.supported = false;
  await render(<UsageLimitNotice serverId="host" agentId="agent" />);
  expect(find("usage-limit-notice")).toBeNull();
});

it("saves the account switch, which is on unless turned off", async () => {
  state.patchConfig.mockResolvedValue({ providers: {} });
  await render(
    <UsageLimitResumeSwitch serverId="host" providerId="claude" providerLabel="Claude" />,
  );
  const toggle = find("provider-auto-resume-switch-claude");
  expect(toggle?.getAttribute("aria-checked")).toBe("true");
  await act(async () => toggle?.click());
  expect(state.patchConfig).toHaveBeenCalledWith({
    providers: { claude: { autoResumeAfterUsageLimit: false } },
  });
});

it("hides the account switch on hosts without the feature", async () => {
  state.supported = false;
  await render(
    <UsageLimitResumeSwitch serverId="host" providerId="claude" providerLabel="Claude" />,
  );
  expect(find("provider-auto-resume-claude")).toBeNull();
});
