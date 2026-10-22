import { expect, test } from "vitest";
import { claudeConnectionStatus } from "./claude-connection-status";

test("shared readiness requires every included delivery, not just a saved token", () => {
  expect(claudeConnectionStatus(undefined)).toContain("Checking");
  expect(claudeConnectionStatus({ connected: false, environments: [] })).toBe("Not connected.");
  expect(
    claudeConnectionStatus({
      connected: true,
      environments: [
        { serverId: "host", status: "ready" },
        { serverId: "dev", status: "pending" },
      ],
    }),
  ).toContain("Synchronization is pending");
  expect(
    claudeConnectionStatus({
      connected: true,
      environments: [
        { serverId: "host", status: "ready" },
        { serverId: "dev", status: "excluded" },
      ],
    }),
  ).toBe("Connected and ready.");
  expect(claudeConnectionStatus({ connected: true, environments: [] })).toContain(
    "Synchronization is pending",
  );
  expect(
    claudeConnectionStatus({
      connected: true,
      environments: [{ serverId: "host", status: "excluded" }],
    }),
  ).toContain("exclusions");
});

test("pending credential removal remains visible after disconnect", () => {
  expect(
    claudeConnectionStatus({
      connected: false,
      environments: [{ serverId: "dev", status: "disconnecting" }],
    }),
  ).toContain("Credential removal will finish automatically");
});

test("full sign-in names the Host account and asks for sign-in again when its grant is lost", () => {
  expect(
    claudeConnectionStatus({
      connected: true,
      needsSignIn: false,
      accountLabel: "owner@example.com",
      environments: [{ serverId: "dev", status: "ready" }],
    }),
  ).toBe("Connected and ready. Signed in as owner@example.com.");
  expect(claudeConnectionStatus({ connected: true, needsSignIn: false, environments: [] })).toBe(
    "Connected and ready.",
  );
  expect(
    claudeConnectionStatus({
      connected: false,
      needsSignIn: true,
      environments: [{ serverId: "dev", status: "disconnected" }],
    }),
  ).toContain("Sign in again");
});
