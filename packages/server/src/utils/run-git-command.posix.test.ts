import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runGitCommand } from "./run-git-command.js";

const tempDirs: string[] = [];

function makeTempRepo(): string {
  const repo = mkdtempSync(path.join(tmpdir(), "paseo-git-fsmonitor-"));
  tempDirs.push(repo);
  return repo;
}

async function configureFsmonitor(repo: string): Promise<string> {
  const hookPath = path.join(repo, "fsmonitor-hook.sh");
  const markerPath = `${hookPath}.marker`;
  writeFileSync(hookPath, "#!/bin/sh\n: > \"$0.marker\"\nprintf '1\\n'\n");
  chmodSync(hookPath, 0o755);
  await runGitCommand(["config", "core.fsmonitor", hookPath], { cwd: repo });
  return markerPath;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

describe("runGitCommand fsmonitor isolation", () => {
  it("does not execute a repository-configured fsmonitor command", async () => {
    const repo = makeTempRepo();
    await runGitCommand(["init"], { cwd: repo });
    const markerPath = await configureFsmonitor(repo);

    await runGitCommand(["status", "--porcelain"], { cwd: repo });

    expect(existsSync(markerPath)).toBe(false);
  });

  it("overrides core.fsmonitor for commands other than status", async () => {
    const repo = makeTempRepo();
    await runGitCommand(["init"], { cwd: repo });
    await configureFsmonitor(repo);

    const result = await runGitCommand(["config", "--get", "core.fsmonitor"], { cwd: repo });

    expect(result.stdout.trim()).toBe("false");
  });
});

/** Pids of processes whose command line names the address, such as a git-remote-http helper. */
function processesNaming(address: string): string[] {
  try {
    return execFileSync("pgrep", ["-f", address], { encoding: "utf8" }).trim().split("\n");
  } catch {
    return []; // pgrep exits 1 when nothing matches.
  }
}

function ignoreReset(): void {}

describe("runGitCommand timeout", () => {
  it("kills the network helper of a timed-out fetch, not only git", async () => {
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      socket.on("error", ignoreReset); // Killing the helper may reset its connection.
      sockets.add(socket);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = `127.0.0.1:${(server.address() as AddressInfo).port}`;
    const repo = makeTempRepo();
    await runGitCommand(["init"], { cwd: repo });
    try {
      const fetch = runGitCommand(["fetch", `http://${address}/repo.git`], {
        cwd: repo,
        envOverlay: { GIT_TERMINAL_PROMPT: "0" },
        timeout: 2_000,
      });
      const outcome = fetch.then(
        () => null,
        (error: unknown) => error,
      );
      // The helper is running before the timeout, so the check below is not vacuous.
      await vi.waitFor(() => expect(processesNaming(address).length).toBeGreaterThan(0), {
        timeout: 2_000,
      });
      expect(await outcome).toEqual(
        expect.objectContaining({ message: expect.stringContaining("timed out after 2000ms") }),
      );
      // The silent remote stays open, so a surviving helper would never exit on its own.
      await vi.waitFor(() => expect(processesNaming(address)).toEqual([]), { timeout: 5_000 });
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 15_000);
});
