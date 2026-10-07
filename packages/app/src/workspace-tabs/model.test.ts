import { describe, expect, it } from "vitest";
import { buildWorkspaceTabPersistenceKey } from "./model";

describe("buildWorkspaceTabPersistenceKey", () => {
  it("trims and joins opaque server and workspace ids", () => {
    expect(
      buildWorkspaceTabPersistenceKey({
        serverId: "  server-1  ",
        workspaceId: "  setup\\workspace\\  ",
      }),
    ).toBe("server-1:setup\\workspace\\");
  });

  it("rejects incomplete identities", () => {
    expect(buildWorkspaceTabPersistenceKey({ serverId: "", workspaceId: "workspace" })).toBeNull();
    expect(buildWorkspaceTabPersistenceKey({ serverId: "server", workspaceId: "  " })).toBeNull();
  });
});

import {
  buildDeterministicWorkspaceTabId,
  normalizeWorkspaceTabTarget,
  workspaceTabTargetsEqual,
} from "./identity";

it("persists task execution ownership and keeps equal file paths in different environments distinct", () => {
  const host = {
    kind: "file" as const,
    path: "README.md",
    environment: { serverId: "host", workspaceId: "host-workspace" },
  };
  const container = {
    ...host,
    environment: { serverId: "container", workspaceId: "container-workspace" },
  };
  expect(normalizeWorkspaceTabTarget(container)).toEqual(container);
  expect(workspaceTabTargetsEqual(host, container)).toBe(false);
  expect(buildDeterministicWorkspaceTabId(host)).not.toBe(
    buildDeterministicWorkspaceTabId(container),
  );
  expect(
    normalizeWorkspaceTabTarget({
      kind: "agent",
      agentId: "task",
      environment: container.environment,
    }),
  ).toEqual({ kind: "agent", agentId: "task", environment: container.environment });
});
