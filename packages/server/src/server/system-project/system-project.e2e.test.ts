import { afterEach, beforeEach, expect, test } from "vitest";

import { createDaemonTestContext, type DaemonTestContext } from "../test-utils/index.js";

let ctx: DaemonTestContext;

beforeEach(async () => {
  ctx = await createDaemonTestContext({ systemProjectEnabled: true });
});

afterEach(async () => {
  await ctx.cleanup();
});

async function systemWorkspace() {
  const { entries } = await ctx.client.fetchWorkspaces();
  const runner = entries.find((entry) => entry.systemMembership?.role === "optimization-runner");
  if (!runner) throw new Error("Expected the Optimization Runner workspace");
  return runner;
}

test("a fresh daemon advertises and serves the Vorteo System project", async () => {
  expect(ctx.client.getLastServerInfoMessage()?.features?.systemProject).toBe(true);
  const runner = await systemWorkspace();
  expect(runner).toMatchObject({
    name: "Optimization Runner",
    projectDisplayName: "Vorteo System",
    projectSystem: { kind: "vorteo-system" },
    standing: true,
    protected: true,
  });
});

test("clients cannot archive, rename, unprotect or remove the system project", async () => {
  const runner = await systemWorkspace();
  expect((await ctx.client.archiveWorkspace(runner.id)).error).toContain(
    "managed by Vorteo System",
  );
  await expect(ctx.client.setWorkspaceTitle(runner.id, "Renamed")).rejects.toThrow(
    "managed by Vorteo System",
  );
  await expect(
    ctx.client.setWorkspaceLifecycle({ workspaceId: runner.id, protected: false }),
  ).rejects.toThrow("managed by Vorteo System");
  await expect(ctx.client.renameProject(runner.projectId, "Mine")).rejects.toThrow(
    "managed by Vorteo System",
  );
  expect(await systemWorkspace()).toMatchObject({
    id: runner.id,
    name: "Optimization Runner",
    protected: true,
  });
});
