import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { FileBackedProjectRegistry, FileBackedWorkspaceRegistry } from "../workspace-registry.js";
import { ensureSystemProject } from "./ensure-system-project.js";
import { systemPaths } from "./manifest.js";
import { setupSystemSource } from "./setup-source.js";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, stdio: "pipe", encoding: "utf8" }).trim();
}

describe("Vorteo source setup", () => {
  let home: string;
  let upstream: string;
  let firstCommit: string;
  let projects: FileBackedProjectRegistry;
  let workspaces: FileBackedWorkspaceRegistry;
  const logger = createTestLogger();

  function setup() {
    return setupSystemSource({
      paseoHome: home,
      projectRegistry: projects,
      workspaceRegistry: workspaces,
      logger,
    });
  }

  function writeSettings(value: unknown) {
    mkdirSync(systemPaths(home).root, { recursive: true });
    writeFileSync(systemPaths(home).config, JSON.stringify(value));
  }

  beforeEach(async () => {
    home = mkdtempSync(path.join(os.tmpdir(), "vorteo-source-"));
    upstream = path.join(home, "upstream");
    mkdirSync(upstream);
    git(["init", "-b", "main"], upstream);
    git(["config", "user.email", "test@getpaseo.local"], upstream);
    git(["config", "user.name", "Paseo Test"], upstream);
    writeFileSync(path.join(upstream, "README.md"), "first\n");
    git(["add", "."], upstream);
    git(["-c", "commit.gpgsign=false", "commit", "-m", "first"], upstream);
    firstCommit = git(["rev-parse", "HEAD"], upstream);
    writeFileSync(path.join(upstream, "README.md"), "second\n");
    git(["-c", "commit.gpgsign=false", "commit", "-am", "second"], upstream);

    projects = new FileBackedProjectRegistry(path.join(home, "projects", "projects.json"), logger);
    workspaces = new FileBackedWorkspaceRegistry(
      path.join(home, "projects", "workspaces.json"),
      logger,
    );
    await ensureSystemProject({
      paseoHome: home,
      serverId: "srv_test",
      environment: "host",
      projectRegistry: projects,
      workspaceRegistry: workspaces,
      logger,
    });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test("clones the configured repository at the configured commit", async () => {
    writeSettings({ source: { repository: upstream, ref: firstCommit } });
    const result = await setup();
    const source = systemPaths(home).source;
    expect(result.outcome).toBe("cloned");
    expect(git(["rev-parse", "HEAD"], source)).toBe(firstCommit);
    expect(git(["branch", "--show-current"], source)).toBe("local");
    expect(git(["status", "--porcelain"], source)).toBe("");

    const [project] = await projects.list();
    expect(project).toMatchObject({ kind: "git", projectKey: "system:srv_test" });
    expect(await workspaces.get(result.workspaceId)).toMatchObject({
      projectId: project!.projectId,
      cwd: source,
      kind: "local_checkout",
      title: "Vorteo source",
    });
    expect((await workspaces.get(result.workspaceId))?.systemMembership).toBeUndefined();
  });

  test("a second request reports the existing checkout", async () => {
    writeSettings({ source: { repository: upstream } });
    const first = await setup();
    expect(await setup()).toEqual({ outcome: "already_set_up", workspaceId: first.workspaceId });
  });

  test("refuses without settings and leaves the folder empty", async () => {
    await expect(setup()).rejects.toThrow("No Vorteo source is configured");
    expect(existsSync(path.join(systemPaths(home).source, ".git"))).toBe(false);
  });

  test("refuses to clone when the installation's own checkout is configured", async () => {
    writeSettings({ source: { checkout: "/elsewhere/vorteo" } });
    await expect(setup()).rejects.toThrow("already uses the checkout it was installed from");
  });

  test("never touches a folder that already has files", async () => {
    writeSettings({ source: { repository: upstream } });
    writeFileSync(path.join(systemPaths(home).source, "notes.txt"), "mine\n");
    await expect(setup()).rejects.toThrow("not empty");
    expect(existsSync(path.join(systemPaths(home).source, "notes.txt"))).toBe(true);
  });

  test("a failed clone leaves an empty folder for the next attempt", async () => {
    writeSettings({ source: { repository: path.join(home, "missing-repo") } });
    await expect(setup()).rejects.toThrow("Could not clone Vorteo source");
    writeSettings({ source: { repository: upstream } });
    await expect(setup()).resolves.toMatchObject({ outcome: "cloned" });
  });
});
