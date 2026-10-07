import path from "node:path";
import { z } from "zod";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { getServerId } from "../support/helpers/server-id";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";

test.use({
  e2eDaemonConfig: {
    version: 1,
    agents: {
      providers: {
        claude: {
          command: [
            process.execPath,
            path.resolve(__dirname, "../fixtures/fake-account-login.cjs"),
          ],
        },
      },
    },
  },
});

for (const width of [1280, 402]) {
  test(`additional subscription account sign-in and recovery at ${width}px`, async ({ page }) => {
    test.setTimeout(120_000);
    const client = await connectDaemonClient<DaemonClient>({ clientIdPrefix: "account-login" });
    try {
      await page.setViewportSize({ width, height: 1000 });
      await gotoAppShell(page);
      await page.evaluate(() => {
        const nonce = localStorage.getItem("@paseo:e2e-seed-nonce");
        if (!nonce) throw new Error("Missing isolated browser seed nonce");
        localStorage.setItem("@paseo:e2e-disable-default-seed-once", nonce);
      });
      await page.goto(`/settings/hosts/${getServerId()}/providers`);
      await page.getByTestId("provider-catalog-search").fill("Claude");
      await expect(page.getByTestId("catalog-provider-claude")).toContainText(
        "Claude Code (Claude account)",
      );
      await page.getByTestId("add-claude-account").click();
      await expect(page.getByTestId("claude-account-name")).toHaveValue(
        width === 1280 ? "Claude 1" : "Claude 2",
      );
      const name = `Browser account ${width}`;
      await page.getByTestId("claude-account-name").fill(name);
      await page.getByTestId("claude-account-create").click();
      await expect(page.getByTestId("claude-account-done")).toBeVisible();
      const config = (await client.getDaemonConfig()).config;
      const account = Object.entries(config.providers).find(
        ([, provider]) => provider.label === name,
      );
      if (!account) throw new Error("Created account missing");
      await page.getByTestId("claude-account-done").click();
      await page.getByTestId(`provider-connect-${account[0]}`).click();
      const panel = page.getByTestId("provider-login-panel");
      await panel.getByRole("button", { name: "Start sign-in", exact: true }).click();
      await expect(page.getByTestId("claude-browser-login")).toBeVisible();
      await page.getByTestId("claude-login-code").fill("incorrect-code");
      await panel.getByRole("button", { name: "Complete sign-in", exact: true }).click();
      await expect(panel).toContainText("Sign-in did not complete");
      await panel.getByRole("button", { name: "Try sign-in again", exact: true }).click();
      await expect(page.getByTestId("claude-login-code")).toHaveValue("");
      await panel.getByRole("button", { name: "Cancel sign-in", exact: true }).click();
      await expect(panel).toContainText("Sign-in cancelled");
      await panel.getByRole("button", { name: "Try sign-in again", exact: true }).click();
      await page.getByTestId("claude-login-code").fill("browser-test-code");
      await panel.getByRole("button", { name: "Complete sign-in", exact: true }).click();
      await expect(panel).toContainText("Sign-in completed");
      await expect(panel).not.toContainText("Usage is refreshing");
      await expect(panel).not.toContainText("A code lasts up to 15 minutes");
      await expect(panel).toContainText("You can close this panel and use this account.");
      expect(account[1].extends).toBe("claude");
      const environment = z.record(z.string(), z.string()).parse(account[1].env);
      expect(environment.CLAUDE_CONFIG_DIR).toContain(account[0]);
      await page.getByTestId("provider-login-done").click();
      await expect(page.getByTestId("provider-reconnect-dialog")).toBeHidden();
      await expect(page.getByTestId(`provider-rename-${account[0]}`)).toBeVisible();
      await page.evaluate(() => {
        const nonce = localStorage.getItem("@paseo:e2e-seed-nonce");
        if (!nonce) throw new Error("Missing isolated browser seed nonce");
        localStorage.setItem("@paseo:e2e-disable-default-seed-once", nonce);
      });
      await page.reload();
      await expect(page.getByTestId("host-page-providers-card")).toBeVisible();
      await expect(page.getByTestId("catalog-provider-claude")).toBeVisible();
      expect((await client.getDaemonConfig()).config.providers[account[0]].label).toBe(name);
    } finally {
      await client.close();
    }
  });
}
