import { expect, it } from "vitest";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { DemoSession } from "./session";
import { createDemoTransport } from "./transport";
import { DEMO_SERVER_ID } from "./scenario";

it("serves populated projects, workspaces, checklists and timelines through the real client", async () => {
  const session = new DemoSession();
  const client = new DaemonClient({
    url: "ws://demo.invalid/ws",
    clientId: "demo-test",
    expectedServerId: DEMO_SERVER_ID,
    transportFactory: () => createDemoTransport(session),
    reconnect: { enabled: false },
  });
  try {
    await client.connect();
    expect((await client.listProjects()).projects).toHaveLength(3);
    expect((await client.listTerminals("/demo/atlas/design")).terminals).toEqual([]);
    const terminals = client.observeTerminals({ cwd: "/demo/atlas/design" });
    expect((await terminals.ready).terminals).toEqual([]);
    await terminals.release();
    expect((await client.fetchWorkspaces()).entries).toHaveLength(6);
    const agents = await client.fetchAgents();
    expect(agents.entries).toHaveLength(6);
    expect(new Set(agents.entries.map(({ agent }) => agent.title)).size).toBe(6);
    expect(
      (
        await client.fetchAgents({ filter: { projectKeys: ["demo-project-observatory"] } })
      ).entries.map(({ agent }) => agent.cwd),
    ).toEqual(["/demo/observatory/design", "/demo/observatory/release"]);
    const completed = agents.entries.find(
      ({ agent }) => agent.title === "Document the notebook export",
    )?.agent;
    expect(completed?.tasks?.every((task) => task.completed)).toBe(true);
    for (const workspace of (await client.fetchWorkspaces()).entries) {
      const cwd = workspace.workspaceDirectory;
      const diff = await client.getCheckoutDiff(cwd, { mode: "uncommitted" });
      const totals = diff.files.reduce(
        (sum, file) => ({
          additions: sum.additions + file.additions,
          deletions: sum.deletions + file.deletions,
        }),
        { additions: 0, deletions: 0 },
      );
      expect(totals).toEqual(workspace.diffStat);
      const status = await client.getCheckoutStatus(cwd);
      expect(status.isDirty).toBe(diff.files.length > 0);
      expect(status.currentBranch).toBe(workspace.gitRuntime?.currentBranch);
    }
    const timeline = await client.fetchAgentTimeline(agents.entries[0].agent.id);
    expect(timeline.entries).toHaveLength(4);
    expect(timeline.entries[1].item).toMatchObject({
      type: "assistant_message",
      text: expect.stringContaining("Changes ready for review"),
    });
    expect(agents.entries[0].agent.tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "completed" }),
        expect.objectContaining({ status: "review" }),
        expect.objectContaining({ status: "blocked" }),
      ]),
    );
  } finally {
    await client.close();
  }
});

it("refuses unknown or real execution actions with a correlated error", () => {
  const session = new DemoSession();
  expect(
    session.receive({
      type: "session",
      message: { type: "daemon.update.request", requestId: "do-not-run" },
    }),
  ).toMatchObject([
    {
      type: "session",
      message: {
        type: "rpc_error",
        payload: { requestId: "do-not-run", code: "DEMO_ACTION_UNAVAILABLE" },
      },
    },
  ]);
});

it("edits only sample files, detects stale saves, updates diffs and resets the simulation", async () => {
  const session = new DemoSession();
  const client = new DaemonClient({
    url: "ws://demo.invalid/ws",
    clientId: "file-demo-test",
    expectedServerId: DEMO_SERVER_ID,
    transportFactory: () => createDemoTransport(session),
    reconnect: { enabled: false },
  });
  const cwd = "/demo/atlas/release";
  const path = "README.md";
  try {
    await client.connect();
    const original = await client.readFile(cwd, path);
    expect(original.kind).toBe("text");
    const changed = "# Simulated edit\n\nCafé 🌙\n";
    const saved = await client.writeFile({
      cwd,
      path,
      content: changed,
      expectedRevision: "demo-v1",
      expectedModifiedAt: "2026-10-01T12:00:00.000Z",
    });
    expect(saved.status).toBe("written");
    expect(saved).toMatchObject({ size: new TextEncoder().encode(changed).length });
    expect(new TextDecoder().decode((await client.readFile(cwd, path)).bytes)).toBe(changed);
    expect(
      await client.writeFile({
        cwd,
        path,
        content: "stale",
        expectedRevision: "demo-v1",
        expectedModifiedAt: "2026-10-01T12:00:00.000Z",
      }),
    ).toMatchObject({ status: "conflict" });
    expect(new TextDecoder().decode((await client.readFile(cwd, path)).bytes)).toBe(changed);
    expect(
      await client.writeFile({
        cwd: "/private",
        path: "README.md",
        content: changed,
        expectedModifiedAt: "",
      }),
    ).toMatchObject({ status: "error" });
    const diff = await client.getCheckoutDiff(cwd, { mode: "uncommitted" });
    expect(diff.files).toHaveLength(1);
    expect(diff.files[0].path).toBe(path);
    expect(
      diff.files[0].hunks[0].lines
        .filter((line) => line.type === "add")
        .map((line) => line.content)
        .join("\n") + "\n",
    ).toBe(changed);
    expect(
      (await client.fetchWorkspaces()).entries.find((entry) => entry.workspaceDirectory === cwd)
        ?.diffStat,
    ).toEqual({ additions: diff.files[0].additions, deletions: diff.files[0].deletions });
    session.reset();
    expect(await client.readFile(cwd, path)).toEqual(original);
    expect((await client.getCheckoutDiff(cwd, { mode: "uncommitted" })).files).toEqual([]);
  } finally {
    await client.close();
  }
});

it("notifies a second demo client of a saved file and stops updates after release", async () => {
  const session = new DemoSession();
  const create = (clientId: string) =>
    new DaemonClient({
      url: "ws://demo.invalid/ws",
      clientId,
      expectedServerId: DEMO_SERVER_ID,
      transportFactory: () => createDemoTransport(session),
      reconnect: { enabled: false },
    });
  const writer = create("writer");
  const reader = create("reader");
  const versions: string[] = [];
  try {
    await Promise.all([writer.connect(), reader.connect()]);
    const subscription = await reader.subscribeFile(
      { cwd: "/demo/atlas/release", path: "README.md" },
      (version) => {
        if (version.status === "ready" && version.revision) versions.push(version.revision);
      },
    );
    const input = {
      cwd: "/demo/atlas/release",
      path: "README.md",
      content: "Changed",
      expectedModifiedAt: "2026-10-01T12:00:00.000Z",
      expectedRevision: "demo-v1",
    };
    const saved = await writer.writeFile(input);
    expect(saved.status).toBe("written");
    await expect.poll(() => versions).toEqual(["demo-v2"]);
    await subscription.unsubscribe();
    await writer.writeFile({ ...input, expectedRevision: "demo-v2", content: "Changed again" });
    await reader.readFile(input.cwd, input.path);
    expect(versions).toEqual(["demo-v2"]);
  } finally {
    await Promise.all([writer.close(), reader.close()]);
  }
});

it("refreshes subscribed diffs and matching workspace totals, then honors release", async () => {
  const session = new DemoSession();
  const client = new DaemonClient({
    url: "ws://demo.invalid/ws",
    clientId: "live-diff-test",
    expectedServerId: DEMO_SERVER_ID,
    transportFactory: () => createDemoTransport(session),
    reconnect: { enabled: false },
  });
  const cwd = "/demo/atlas/release";
  const diffUpdates: unknown[] = [];
  const workspaceUpdates: unknown[] = [];
  const unrelatedUpdates: unknown[] = [];
  try {
    await client.connect();
    const diff = client.observeCheckoutDiff(cwd, { mode: "uncommitted" });
    const workspaces = client.observeWorkspaces({ filter: { projectId: "demo-project-atlas" } });
    const unrelated = client.observeWorkspaces({
      filter: { projectId: "demo-project-observatory" },
    });
    diff.subscribe({ snapshot: () => {}, update: (message) => diffUpdates.push(message) });
    workspaces.subscribe({
      snapshot: () => {},
      update: (message) => workspaceUpdates.push(message),
    });
    unrelated.subscribe({
      snapshot: () => {},
      update: (message) => unrelatedUpdates.push(message),
    });
    await Promise.all([diff.ready, workspaces.ready, unrelated.ready]);
    const input = {
      cwd,
      path: "README.md",
      content: "Live diff\n",
      expectedModifiedAt: "2026-10-01T12:00:00.000Z",
      expectedRevision: "demo-v1",
    };
    await client.writeFile(input);
    await expect.poll(() => diffUpdates.length).toBe(1);
    expect(diffUpdates[0]).toMatchObject({
      type: "checkout_diff_update",
      payload: { files: [{ path: "README.md", additions: 1 }] },
    });
    expect(workspaceUpdates).toEqual([
      expect.objectContaining({
        type: "workspace_update",
        payload: expect.objectContaining({
          workspace: expect.objectContaining({
            diffStat: expect.objectContaining({ additions: 1 }),
            gitRuntime: expect.objectContaining({ isDirty: true }),
          }),
        }),
      }),
    ]);
    expect(unrelatedUpdates).toEqual([]);
    await Promise.all([diff.release(), workspaces.release(), unrelated.release()]);
    await client.writeFile({ ...input, content: "Another save", expectedRevision: "demo-v2" });
    await client.readFile(cwd, input.path);
    expect(diffUpdates).toHaveLength(1);
    expect(workspaceUpdates).toHaveLength(1);
  } finally {
    await client.close();
  }
});

it("mutates simulated checklists with dependency and stale-edit protection and owned updates", async () => {
  const session = new DemoSession();
  const client = new DaemonClient({
    url: "ws://demo.invalid/ws",
    clientId: "demo-checklist-test",
    expectedServerId: DEMO_SERVER_ID,
    transportFactory: () => createDemoTransport(session),
    reconnect: { enabled: false },
  });
  try {
    await client.connect();
    const subscription = client.observeAgents();
    const updates: unknown[] = [];
    subscription.subscribe({ snapshot: () => {}, update: (message) => updates.push(message) });
    const agent = (await subscription.ready).entries[0].agent;
    const original = agent.tasks![0];
    await client.mutateAgentChecklist(agent.id, {
      operation: "update",
      id: original.id!,
      expectedTask: JSON.parse(JSON.stringify(original)),
      status: "pending",
    });
    updates.length = 0;
    let tasks = await client.mutateAgentChecklist(agent.id, {
      operation: "create",
      id: "demo-new",
      text: "Try the demo",
    });
    const before = tasks.find((task) => task.id === "demo-new")!;
    tasks = await client.mutateAgentChecklist(agent.id, {
      operation: "update",
      id: "demo-new",
      status: "completed",
      expectedTask: before,
    });
    expect(tasks.find((task) => task.id === "demo-new")?.completed).toBe(true);
    await expect(
      client.mutateAgentChecklist(agent.id, {
        operation: "delete",
        id: "demo-new",
        expectedTask: before,
      }),
    ).rejects.toThrow("changed while you were editing");
    await client.mutateAgentChecklist(agent.id, {
      operation: "create",
      id: "blocked-new",
      text: "Prerequisite",
    });
    await client.mutateAgentChecklist(agent.id, {
      operation: "update",
      id: "demo-new",
      status: "pending",
      blockedBy: ["blocked-new"],
    });
    await expect(
      client.mutateAgentChecklist(agent.id, {
        operation: "update",
        id: "demo-new",
        status: "completed",
      }),
    ).rejects.toThrow("Complete dependency");
    expect(updates).toHaveLength(4);
    await subscription.release();
    await client.mutateAgentChecklist(agent.id, { operation: "delete", id: "demo-new" });
    expect(updates).toHaveLength(4);
    session.reset();
    expect(
      (await client.fetchAgent(agent.id))?.agent?.tasks?.some((task) => task.id === "blocked-new"),
    ).toBe(false);
  } finally {
    await client.close();
  }
});

it("sends isolated demo replies through owned timeline subscriptions with retry deduplication", async () => {
  const session = new DemoSession();
  const client = new DaemonClient({
    url: "ws://demo.invalid/ws",
    clientId: "demo-conversation-test",
    expectedServerId: DEMO_SERVER_ID,
    transportFactory: () => createDemoTransport(session),
    reconnect: { enabled: false },
  });
  try {
    await client.connect();
    const agentId = "demo-agent-1";
    const subscription = client.observeTimeline([agentId]);
    const updates: unknown[] = [];
    subscription.subscribe({ snapshot: () => {}, update: (message) => updates.push(message) });
    await subscription.ready;
    await client.sendAgentMessage(agentId, "What remains?", { messageId: "test-message" });
    expect(updates).toHaveLength(2);
    const timeline = await client.fetchAgentTimeline(agentId);
    expect(timeline.entries).toHaveLength(6);
    expect(timeline.entries.at(-1)?.item).toMatchObject({
      type: "assistant_message",
      text: expect.stringContaining("Approve release copy"),
    });
    await client.sendAgentMessage(agentId, "What remains?", { messageId: "test-message" });
    expect(updates).toHaveLength(2);
    await subscription.release();
    await client.sendAgentMessage(agentId, "Show changes", { messageId: "test-message-2" });
    expect(updates).toHaveLength(2);
    await expect(
      client.sendAgentMessage(agentId, "Attachment", {
        images: [{ data: "fake", mimeType: "image/png" }],
      }),
    ).rejects.toThrow("text only");
    session.reset();
    expect((await client.fetchAgentTimeline(agentId)).entries).toHaveLength(4);
  } finally {
    await client.close();
  }
});
