import os from "node:os";
import path from "node:path";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { setWorkspaceLifecycle } from "../workspace-lifecycle/policy.js";
import {
  createPersistedProjectRecord,
  createPersistedWorkspaceRecord,
  FileBackedProjectRegistry,
  FileBackedWorkspaceRegistry,
  type PersistedWorkspaceRecord,
} from "../workspace-registry.js";
import { ensureSystemProject } from "./ensure-system-project.js";
import { SYSTEM_PROJECT_KIND, systemPaths } from "./manifest.js";

const T0 = "2026-10-22T00:00:00.000Z";

let home: string;
let projects: FileBackedProjectRegistry;
let workspaces: FileBackedWorkspaceRegistry;
const logger = createTestLogger();

function open() {
  projects = new FileBackedProjectRegistry(path.join(home, "projects", "projects.json"), logger);
  workspaces = new FileBackedWorkspaceRegistry(
    path.join(home, "projects", "workspaces.json"),
    logger,
  );
}

function ensure(environment: "host" | "container" | "single" = "host") {
  return ensureSystemProject({
    paseoHome: home,
    serverId: "srv_test",
    environment,
    projectRegistry: projects,
    workspaceRegistry: workspaces,
    logger,
    now: () => T0,
  });
}

async function runner(): Promise<PersistedWorkspaceRecord> {
  const member = (await workspaces.list()).find(
    (workspace) => workspace.systemMembership?.role === "optimization-runner",
  );
  if (!member) throw new Error("runner workspace missing");
  return member;
}

function writeConfig(value: unknown) {
  mkdirSync(systemPaths(home).root, { recursive: true });
  writeFileSync(
    systemPaths(home).config,
    typeof value === "string" ? value : JSON.stringify(value),
  );
}

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "vorteo-system-"));
  open();
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("startup seeding", () => {
  test("first start creates the project, its folders and the Host runner", async () => {
    const result = await ensure("host");
    const [project] = await projects.list();
    expect(project).toMatchObject({
      projectId: result.projectId,
      customName: "Vorteo System",
      projectKey: "system:srv_test",
      rootPath: systemPaths(home).source,
      systemProject: { kind: SYSTEM_PROJECT_KIND },
    });
    expect(result).toMatchObject({ createdProject: true, adopted: [], retired: [] });
    expect(await runner()).toMatchObject({
      projectId: result.projectId,
      kind: "directory",
      cwd: systemPaths(home).runner("optimization-runner"),
      title: "Optimization Runner",
      standing: true,
      protected: true,
    });
    expect(existsSync(systemPaths(home).source)).toBe(true);
    expect(existsSync(systemPaths(home).runner("optimization-runner"))).toBe(true);
  });

  test("a repeat start changes nothing", async () => {
    const first = await ensure();
    const before = JSON.stringify([await projects.list(), await workspaces.list()]);
    open();
    const second = await ensure();
    expect(second).toEqual({
      projectId: first.projectId,
      createdProject: false,
      created: [],
      adopted: [],
      retired: [],
    });
    expect(JSON.stringify([await projects.list(), await workspaces.list()])).toBe(before);
  });

  test("overlapping calls in one daemon allocate a single project", async () => {
    const [left, right] = await Promise.all([ensure(), ensure()]);
    expect(left.projectId).toBe(right.projectId);
    expect(await projects.list()).toHaveLength(1);
    expect((await workspaces.list()).filter((w) => w.systemMembership)).toHaveLength(1);
  });

  test("the Dev container gets the project but no Host-only runner", async () => {
    const result = await ensure("container");
    expect(result.createdProject).toBe(true);
    expect(await workspaces.list()).toEqual([]);
  });

  test("a missing folder is recreated on the next start", async () => {
    await ensure();
    rmSync(systemPaths(home).root, { recursive: true, force: true });
    await ensure();
    expect(existsSync(systemPaths(home).runner("optimization-runner"))).toBe(true);
  });

  test("duplicate system projects keep the oldest and delete nothing", async () => {
    for (const [projectId, createdAt] of [
      ["prj_newer", "2026-10-22T02:00:00.000Z"],
      ["prj_older", "2026-10-22T01:00:00.000Z"],
    ] as const) {
      await projects.writeSystemProject({
        ...createPersistedProjectRecord({
          projectId,
          rootPath: path.join(home, projectId),
          kind: "non_git",
          displayName: projectId,
          customName: "Vorteo System",
          createdAt,
          updatedAt: createdAt,
        }),
        systemProject: { kind: SYSTEM_PROJECT_KIND },
      });
    }
    const result = await ensure();
    expect(result.projectId).toBe("prj_older");
    expect((await projects.list()).map((p) => p.projectId).sort()).toEqual([
      "prj_newer",
      "prj_older",
    ]);
  });

  test("a role that leaves the manifest is retired, not deleted", async () => {
    await ensure("host");
    const member = await runner();
    open();
    // A container daemon has no runner role, so the same records act as a retired role.
    const result = await ensure("container");
    expect(result.retired).toEqual([member.workspaceId]);
    const retired = await workspaces.get(member.workspaceId);
    expect(retired).toMatchObject({ standing: false, protected: false, archivedAt: null });
    expect(retired?.systemMembership).toBeUndefined();
    await workspaces.archive(member.workspaceId, T0);
    expect((await workspaces.get(member.workspaceId))?.archivedAt).toBe(T0);
  });
});

describe("adoption", () => {
  async function existingRunner(overrides: Partial<PersistedWorkspaceRecord> = {}) {
    await projects.upsert(
      createPersistedProjectRecord({
        projectId: "prj_vorteo",
        rootPath: path.join(home, "paseo"),
        kind: "git",
        displayName: "paseo",
        projectKey: "remote:github.com/aubreyf/paseo",
        createdAt: T0,
        updatedAt: T0,
      }),
    );
    const record = {
      ...createPersistedWorkspaceRecord({
        workspaceId: "wks_7111bd6bfdcf420f",
        projectId: "prj_vorteo",
        projectMembership: { key: "remote:github.com/aubreyf/paseo", name: "Vorteo" },
        cwd: path.join(home, "paseo"),
        kind: "local_checkout",
        displayName: "main",
        title: "Optimization Runner",
        branch: "main",
        worktreeRoot: path.join(home, "paseo"),
        createdAt: T0,
        updatedAt: T0,
      }),
      standing: true,
      protected: true,
      ...overrides,
    };
    await workspaces.upsert(record);
    writeConfig({ adopt: { "optimization-runner": record.workspaceId } });
    return record;
  }

  test("moves the named workspace into the project and keeps its ID", async () => {
    const original = await existingRunner();
    const result = await ensure();
    expect(result).toMatchObject({ adopted: [original.workspaceId], created: [] });
    expect(await workspaces.get(original.workspaceId)).toMatchObject({
      projectId: result.projectId,
      projectMembership: null,
      kind: "directory",
      cwd: systemPaths(home).runner("optimization-runner"),
      branch: null,
      worktreeRoot: null,
      createdAt: T0,
      systemMembership: { role: "optimization-runner" },
      standing: true,
      protected: true,
    });
    expect(await workspaces.list()).toHaveLength(1);
  });

  test("refuses archived or Factory workspaces and creates a fresh runner instead", async () => {
    const original = await existingRunner({ archivedAt: T0, protected: false });
    const result = await ensure();
    expect(result.adopted).toEqual([]);
    expect(result.created).toHaveLength(1);
    expect(await workspaces.get(original.workspaceId)).toMatchObject({
      projectId: "prj_vorteo",
      archivedAt: T0,
    });
  });

  test("ignores an invalid settings file", async () => {
    writeConfig("{not json");
    await expect(ensure()).resolves.toMatchObject({ createdProject: true });
    writeConfig({ adopt: { "optimization-runner": "not-a-workspace-id" } });
    open();
    const result = await ensure();
    expect(result.adopted).toEqual([]);
  });
});

describe("protection", () => {
  test("ordinary writes cannot rename, archive, remove or rekey the project", async () => {
    const { projectId } = await ensure();
    const project = (await projects.get(projectId))!;
    await expect(projects.archive(projectId, T0)).rejects.toThrow("managed by Vorteo System");
    await expect(projects.remove(projectId)).rejects.toThrow("managed by Vorteo System");
    await expect(
      projects.update(projectId, (current) => ({ ...current, customName: "Renamed" })),
    ).rejects.toThrow("managed by Vorteo System");
    // Kind follows the checkout; the key and marker stay daemon-owned.
    await projects.upsert({
      ...project,
      kind: "git",
      projectKey: "remote:github.com/aubreyf/paseo",
      systemProject: undefined,
    });
    expect(await projects.get(projectId)).toMatchObject({
      kind: "git",
      projectKey: "system:srv_test",
      systemProject: { kind: SYSTEM_PROJECT_KIND },
    });
  });

  test("the root lookup used by new workspaces keeps the system key", async () => {
    const { projectId } = await ensure();
    const found = await projects.getOrCreateActiveByRoot({
      rootPath: systemPaths(home).source,
      kind: "non_git",
      displayName: "vorteo",
      projectKey: "remote:github.com/aubreyf/paseo",
      timestamp: T0,
    });
    expect(found).toMatchObject({ projectId, projectKey: "system:srv_test" });
  });

  test("ordinary records cannot claim the system marker or role", async () => {
    await expect(
      projects.upsert({
        ...createPersistedProjectRecord({
          projectId: "prj_fake",
          rootPath: home,
          kind: "non_git",
          displayName: "fake",
          createdAt: T0,
          updatedAt: T0,
        }),
        systemProject: { kind: SYSTEM_PROJECT_KIND },
      }),
    ).rejects.toThrow("daemon startup");
    await expect(
      workspaces.upsert({
        ...createPersistedWorkspaceRecord({
          workspaceId: "wks_fake",
          projectId: "prj_fake",
          cwd: home,
          kind: "directory",
          displayName: "fake",
          createdAt: T0,
          updatedAt: T0,
        }),
        systemMembership: { role: "optimization-runner" },
      }),
    ).rejects.toThrow("daemon startup");
  });

  test("system workspaces refuse archive, removal, moves, renames and unprotecting", async () => {
    await ensure();
    const member = await runner();
    const id = member.workspaceId;
    await expect(workspaces.archive(id, T0)).rejects.toThrow("managed by Vorteo System");
    await expect(workspaces.remove(id)).rejects.toThrow("managed by Vorteo System");
    for (const change of [
      { projectId: "prj_other" },
      { cwd: home },
      { title: "Renamed" },
      { protected: false },
      { standing: false },
    ]) {
      await expect(workspaces.update(id, (current) => ({ ...current, ...change }))).rejects.toThrow(
        "managed by Vorteo System",
      );
    }
    await expect(
      workspaces.update(id, (current) => setWorkspaceLifecycle(current, { protected: false })),
    ).rejects.toThrow("managed by Vorteo System");
    await expect(workspaces.upsert({ ...member, systemMembership: undefined })).resolves.toBe(
      undefined,
    );
    expect((await workspaces.get(id))?.systemMembership).toEqual({ role: "optimization-runner" });
  });

  test("pinning and labels still work on system workspaces", async () => {
    await ensure();
    const { workspaceId } = await runner();
    await workspaces.update(workspaceId, (current) => ({
      ...current,
      pinnedAt: T0,
      labels: ["upkeep"],
    }));
    expect(await workspaces.get(workspaceId)).toMatchObject({
      pinnedAt: T0,
      labels: ["upkeep"],
      protected: true,
    });
  });

  test("operator workspaces in the project stay ordinary", async () => {
    const { projectId } = await ensure();
    const operator = createPersistedWorkspaceRecord({
      workspaceId: "wks_operator",
      projectId,
      cwd: home,
      kind: "directory",
      displayName: "my tweak",
      createdAt: T0,
      updatedAt: T0,
    });
    await workspaces.upsert(operator);
    await workspaces.update(operator.workspaceId, (current) => ({ ...current, title: "Mine" }));
    await workspaces.archive(operator.workspaceId, T0);
    expect((await workspaces.get(operator.workspaceId))?.archivedAt).toBe(T0);
  });
});
