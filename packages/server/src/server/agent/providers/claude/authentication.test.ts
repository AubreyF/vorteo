import { describe, expect, it } from "vitest";
import { requireClaudeAuthentication } from "./authentication.js";

describe("Claude authentication monitoring", () => {
  it("uses the configured CLI, environment and cancellation signal", async () => {
    const signal = new AbortController().signal;
    await requireClaudeAuthentication({
      executable: "/configured/claude",
      args: ["--settings", "/account/settings.json"],
      runtimeSettings: { env: { CLAUDE_CONFIG_DIR: "/account" } },
      signal,
      async run(command, args, options) {
        expect(command).toBe("/configured/claude");
        expect(args).toEqual(["--settings", "/account/settings.json", "auth", "status"]);
        expect(options).toMatchObject({
          envOverlay: { CLAUDE_CONFIG_DIR: "/account" },
          timeout: 5000,
          signal,
        });
        return { stdout: JSON.stringify({ loggedIn: true, authMethod: "api_key" }), stderr: "" };
      },
    });
  });

  it.each([0, 1])("rejects a signed-out CLI with exit status %s", async (code) => {
    await expect(
      requireClaudeAuthentication({
        executable: "claude",
        args: [],
        async run() {
          const stdout = JSON.stringify({ loggedIn: false });
          if (code === 1) throw Object.assign(new Error("signed out"), { code, stdout });
          return { stdout, stderr: "" };
        },
      }),
    ).rejects.toMatchObject({ code: "SIGN_IN_REQUIRED" });
  });

  it.each(["", "not JSON", "{}", '{"loggedIn":"true"}'])(
    "does not infer authentication from %j",
    async (stdout) => {
      await expect(
        requireClaudeAuthentication({
          executable: "claude",
          args: [],
          async run() {
            return { stdout, stderr: "" };
          },
        }),
      ).rejects.toMatchObject({ code: "CHECK_FAILED" });
    },
  );

  it("does not expose command output or report success when the check fails", async () => {
    await expect(
      requireClaudeAuthentication({
        executable: "claude",
        args: [],
        async run() {
          throw new Error("timeout containing private command output");
        },
      }),
    ).rejects.toMatchObject({
      code: "CHECK_FAILED",
      message:
        "Could not verify Claude authentication. Check the connection in Providers settings, then refresh the provider.",
    });
  });

  it("rejects a failed command even if its output claims to be logged in", async () => {
    await expect(
      requireClaudeAuthentication({
        executable: "claude",
        args: [],
        async run() {
          throw Object.assign(new Error("failed"), { code: 1, stdout: '{"loggedIn":true}' });
        },
      }),
    ).rejects.toMatchObject({ code: "CHECK_FAILED" });
  });
});
