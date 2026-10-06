/** @vitest-environment jsdom */
import React, { type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentSkills } from "./use-agent-skills";

const runtime = vi.hoisted(() => ({
  connected: true,
  supported: true,
  clients: new Map<string, { getAgentSkillsStatus: ReturnType<typeof vi.fn> }>(),
}));
const shared = vi.hoisted(() => ({ enabled: false, save: vi.fn() }));
vi.mock("@/execution-installation/settings", () => ({
  useInstallationSettings: () => ({
    installation: shared.enabled
      ? {
          installationId: "installation",
          environments: [
            { serverId: "host", kind: "host" },
            { serverId: "dev", kind: "container" },
          ],
        }
      : null,
    data: shared.enabled
      ? { revision: 7, settings: { skills: { selection: { mode: "all" } } } }
      : undefined,
    save: shared.save,
  }),
}));
vi.mock("@/utils/confirm-dialog", () => ({ confirmDialog: vi.fn(async () => false) }));

vi.mock("@/runtime/host-features", () => ({
  useHostFeature: (_serverId: string, feature: string) =>
    feature === "skillManagement" && runtime.supported,
}));
vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: (serverId: string) => runtime.clients.get(serverId) ?? null,
  useHostRuntimeIsConnected: () => runtime.connected,
}));
vi.mock("@/contexts/toast-context", () => ({
  useToast: () => ({ error: vi.fn() }),
}));

function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      {children}
    </QueryClientProvider>
  );
}

describe("host agent skills", () => {
  beforeEach(() => {
    runtime.connected = true;
    runtime.supported = true;
    runtime.clients.clear();
    shared.enabled = false;
    shared.save.mockReset();
    vi.unstubAllGlobals();
  });

  it("shares the catalog and confirms removals separately for each environment", async () => {
    shared.enabled = true;
    runtime.connected = false;
    const status = {
      state: "drift",
      installed: ["old"],
      selection: { mode: "all" },
      ops: [{ kind: "delete", name: "old" }],
      confirmationRequired: { removals: ["old"] },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              sources: {
                host: { ...status, available: ["host-skill"] },
                dev: { ...status, available: ["dev-skill"] },
              },
            }),
            { status: 200 },
          ),
      ),
    );
    const { result } = renderHook(() => useAgentSkills("host"), { wrapper });
    await waitFor(() =>
      expect(result.current.status?.available).toEqual(["dev-skill", "host-skill"]),
    );
    expect(result.current.connected).toBe(true);
    const selection = { mode: "custom" as const, skills: ["dev-skill"] };
    await act(async () => {
      const preview = await result.current.saveSelection(selection);
      expect(preview.confirmationRequired).toEqual({
        removals: ["Host: old", "Dev container: old"],
      });
    });
    expect(shared.save).not.toHaveBeenCalled();
    expect(result.current.status?.selection).toEqual({ mode: "all" });
    await act(async () => {
      await result.current.saveSelection(selection, ["Host: old"]);
    });
    expect(shared.save).not.toHaveBeenCalled();
    await act(async () => {
      await result.current.saveSelection(selection, ["Host: old", "Dev container: old"]);
    });
    expect(shared.save).toHaveBeenCalledWith({
      expectedRevision: 7,
      settings: { skills: { selection } },
      confirmedSkillRemovals: { host: ["old"], dev: ["old"] },
    });
    expect(result.current.status?.selection).toEqual(selection);
  });

  it("requires owner access and never falls back to local skill writes", async () => {
    shared.enabled = true;
    const client = { getAgentSkillsStatus: vi.fn() };
    runtime.clients.set("host", client);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 401 })),
    );
    const { result } = renderHook(() => useAgentSkills("host"), { wrapper });
    await waitFor(() =>
      expect(result.current.error?.message).toBe(
        "Unlock Installation controls in General settings to continue.",
      ),
    );
    await act(async () => {
      await expect(result.current.saveSelection({ mode: "custom", skills: [] })).rejects.toThrow(
        "Unlock Installation controls",
      );
    });
    expect(client.getAgentSkillsStatus).not.toHaveBeenCalled();
    expect(shared.save).not.toHaveBeenCalled();
    expect(result.current.status).toBeNull();
  });

  it("reads status from the selected host client", async () => {
    const local = { getAgentSkillsStatus: vi.fn() };
    const remote = {
      getAgentSkillsStatus: vi.fn(async () => ({
        state: "not-installed",
        ops: [],
        available: ["paseo"],
        installed: [],
        selection: { mode: "all" },
      })),
    };
    runtime.clients.set("local", local);
    runtime.clients.set("remote", remote);

    const { result } = renderHook(() => useAgentSkills("remote"), { wrapper });
    await waitFor(() => expect(result.current.status?.available).toEqual(["paseo"]));
    expect(remote.getAgentSkillsStatus).toHaveBeenCalledOnce();
    expect(local.getAgentSkillsStatus).not.toHaveBeenCalled();
  });

  it("does not call an old host without the capability", async () => {
    runtime.supported = false;
    const client = { getAgentSkillsStatus: vi.fn() };
    runtime.clients.set("old-host", client);

    const { result } = renderHook(() => useAgentSkills("old-host"), { wrapper });
    expect(result.current.supported).toBe(false);
    expect(client.getAgentSkillsStatus).not.toHaveBeenCalled();
  });
});
