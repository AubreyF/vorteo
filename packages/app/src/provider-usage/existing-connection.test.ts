import { expect, test } from "vitest";
import { describeExistingConnection, existingConnections } from "./existing-connection";

test("outside an installation the daemon catalog lists the default CLI and added accounts", () => {
  const connections = existingConnections({
    provider: "codex",
    definitions: undefined,
    serverId: "local",
    usage: [
      {
        providerId: "codex",
        displayName: "Codex",
        status: "available",
        planLabel: "pro",
        windows: [],
      },
    ],
    entries: [
      { provider: "codex", status: "ready" },
      { provider: "codex-account-1", status: "loading", label: "Codex 2" },
      { provider: "claude", status: "ready" },
    ],
  });
  expect(connections.map((entry) => describeExistingConnection(entry, "host"))).toEqual([
    "host CLI sign-in (pro)",
    "Codex 2",
  ]);
});

test("a default connection that is neither signed in nor detected is not listed", () => {
  expect(
    existingConnections({
      provider: "claude",
      definitions: [
        { id: "claude", providerType: "claude", bindings: { host: "claude" }, policy: {} },
      ],
      serverId: "host",
      usage: [],
      entries: [{ provider: "claude", status: "unavailable" }],
    }),
  ).toEqual([]);
});
