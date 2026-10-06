// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useSessionStore, type Agent } from "@/stores/session-store";
import { useAgentPresentationNavigation } from "./use-agent-presentation-navigation";
const navigate = vi.hoisted(() => vi.fn());
vi.mock("@/utils/navigate-to-agent", () => ({ navigateToAgent: navigate }));

function agent(id: string, workspaceId: string, parentAgentId: string | null): Agent {
  return {
    serverId: "hierarchy-test",
    id,
    workspaceId,
    parentAgentId,
    cwd: `/worktrees/${workspaceId}`,
    provider: "codex",
    status: "idle",
    turn: { phase: "idle", cancellationRequestId: null },
    createdAt: new Date(0),
    updatedAt: new Date(0),
    lastUserMessageAt: null,
    lastActivityAt: new Date(0),
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: true,
      supportsMcpServers: true,
      supportsReasoningStream: true,
      supportsToolInvocations: true,
    },
    currentModeId: null,
    availableModes: [],
    pendingPermissions: [],
    persistence: null,
    runtimeInfo: { provider: "codex", sessionId: null },
    title: id,
    model: null,
    thinkingOptionId: null,
    labels: {},
    requiresAttention: false,
    attentionReason: null,
    attentionTimestamp: null,
    archivedAt: null,
  };
}

const input = { serverId: "hierarchy-test", workspaceId: "execution", isRouteFocused: true };
beforeEach(() => {
  navigate.mockClear();
  const store = useSessionStore.getState();
  store.initializeSession(input.serverId, null, 1);
  store.setAgents(
    input.serverId,
    new Map([
      ["parent", agent("parent", "origin", null)],
      ["worker", agent("worker", "execution", "parent")],
    ]),
  );
});
afterEach(() => {
  cleanup();
  useSessionStore.getState().clearSession(input.serverId);
});

it("hands an already open worker to the parent task and pauses physical workspace pruning", () => {
  const { result } = renderHook(() =>
    useAgentPresentationNavigation({
      ...input,
      tab: { descriptor: { target: { kind: "agent", agentId: "worker" } } },
    }),
  );
  expect(result.current).toBe(true);
  expect(navigate).toHaveBeenCalledWith({
    serverId: input.serverId,
    agentId: "worker",
    workspaceId: "origin",
  });
  expect(useSessionStore.getState().sessions[input.serverId]?.agents.get("worker")?.cwd).toBe(
    "/worktrees/execution",
  );
});
it("keeps a focused workspace terminal and independent task in their physical workspace", () => {
  const terminal = renderHook(() =>
    useAgentPresentationNavigation({
      ...input,
      tab: { descriptor: { target: { kind: "terminal", terminalId: "terminal" } } },
    }),
  );
  expect(terminal.result.current).toBe(false);
  terminal.unmount();
  act(() =>
    useSessionStore
      .getState()
      .setAgents(
        input.serverId,
        new Map([["independent", agent("independent", "execution", null)]]),
      ),
  );
  const independent = renderHook(() =>
    useAgentPresentationNavigation({
      ...input,
      tab: { descriptor: { target: { kind: "agent", agentId: "independent" } } },
    }),
  );
  expect(independent.result.current).toBe(false);
  expect(navigate).not.toHaveBeenCalled();
});
it("does not navigate a retained inactive workspace", () => {
  renderHook(() =>
    useAgentPresentationNavigation({
      ...input,
      isRouteFocused: false,
      tab: { descriptor: { target: { kind: "agent", agentId: "worker" } } },
    }),
  );
  expect(navigate).not.toHaveBeenCalled();
});
it("returns a surviving worker to its physical workspace after the parent is archived", () => {
  const parent = agent("parent", "origin", null);
  parent.archivedAt = new Date(1);
  act(() =>
    useSessionStore.getState().setAgents(
      input.serverId,
      new Map([
        [parent.id, parent],
        ["worker", agent("worker", "execution", "parent")],
      ]),
    ),
  );
  const { result } = renderHook(() =>
    useAgentPresentationNavigation({
      ...input,
      workspaceId: "origin",
      tab: { descriptor: { target: { kind: "agent", agentId: "worker" } } },
    }),
  );
  expect(result.current).toBe(true);
  expect(navigate).toHaveBeenCalledWith({
    serverId: input.serverId,
    agentId: "worker",
    workspaceId: "execution",
  });
});
