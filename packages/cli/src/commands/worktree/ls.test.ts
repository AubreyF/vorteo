import path from "node:path";
import { describe, expect, it } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { runLsCommandWithDeps } from "./ls.js";

const daemonTarget = { kind: "endpoint" as const, host: "example.test:12345" };

type ListInput = Parameters<DaemonClient["getPaseoWorktreeList"]>[0];

interface RecordingClient {
  client: DaemonClient;
  listCalls: ListInput[];
}

function createRecordingClient(): RecordingClient {
  const listCalls: ListInput[] = [];
  const client = {
    fetchAgents: async () => ({ entries: [] }),
    getPaseoWorktreeList: async (input: ListInput) => {
      listCalls.push(input);
      return {
        worktrees: [
          {
            worktreePath: "/tmp/paseo-home/worktrees/repo/feature",
            branchName: "feature",
            head: "abc123",
            createdAt: "2026-04-12T00:00:00.000Z",
          },
        ],
        error: null,
        requestId: "req-list",
      };
    },
    close: async () => {},
  } as unknown as DaemonClient;
  return { client, listCalls };
}

describe("runLsCommand", () => {
  it("lists worktrees of the current directory by default", async () => {
    const { client, listCalls } = createRecordingClient();

    const result = await runLsCommandWithDeps(
      { daemonTarget },
      { connectToDaemon: async () => client },
    );

    expect(listCalls).toEqual([{ cwd: process.cwd() }]);
    expect(result.data).toEqual([
      {
        name: "feature",
        branch: "feature",
        cwd: "/tmp/paseo-home/worktrees/repo/feature",
        agent: "-",
      },
    ]);
  });

  it("sends --cwd resolved to an absolute path", async () => {
    const { client, listCalls } = createRecordingClient();

    await runLsCommandWithDeps(
      { daemonTarget, cwd: "some/dir" },
      { connectToDaemon: async () => client },
    );

    expect(listCalls).toEqual([{ cwd: path.resolve("some/dir") }]);
  });

  it("sends --repo as repoRoot, taking precedence over --cwd", async () => {
    const { client, listCalls } = createRecordingClient();

    await runLsCommandWithDeps(
      { daemonTarget, repo: "relative/repo", cwd: "/ignored" },
      { connectToDaemon: async () => client },
    );

    expect(listCalls).toEqual([{ repoRoot: path.resolve("relative/repo") }]);
  });

  it("reports the daemon's list error", async () => {
    const client = {
      fetchAgents: async () => ({ entries: [] }),
      getPaseoWorktreeList: async () => ({
        worktrees: [],
        error: { code: "UNKNOWN", message: "cwd or repoRoot is required" },
        requestId: "req-list",
      }),
      close: async () => {},
    } as unknown as DaemonClient;

    await expect(
      runLsCommandWithDeps({ daemonTarget }, { connectToDaemon: async () => client }),
    ).rejects.toEqual({
      code: "WORKTREE_LIST_FAILED",
      message: "Failed to list worktrees: cwd or repoRoot is required",
    });
  });
});
