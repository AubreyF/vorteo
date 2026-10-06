import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import path from "node:path";
import { expect, test, type Page } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";
import { getServerId } from "../support/helpers/server-id";

async function openProvidersInMode({ page, vortonMode }: { page: Page; vortonMode: boolean }) {
  await page.evaluate((enabled) => {
    const key = "@paseo:create-agent-preferences";
    const preferences = JSON.parse(localStorage.getItem(key) ?? "{}");
    localStorage.setItem(key, JSON.stringify({ ...preferences, vortonMode: enabled }));
    const nonce = localStorage.getItem("@paseo:e2e-seed-nonce");
    if (!nonce) throw new Error("Missing browser seed nonce");
    localStorage.setItem("@paseo:e2e-disable-default-seed-once", nonce);
  }, vortonMode);
  await page.goto(`/settings/hosts/${getServerId()}/providers`);
}

test("old Claude CLI explains missing models and clears the warning after upgrading", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const client = await connectDaemonClient<DaemonClient>({ clientIdPrefix: "cli-update-warning" });
  const provider = "claude-cli-update-test";
  const command = [process.execPath, path.resolve("e2e/fixtures/catalog-claude.cjs")];
  try {
    await client.patchDaemonConfig({
      providers: {
        [provider]: {
          extends: "claude",
          label: "CLI warning account",
          enabled: true,
          command,
          env: { CATALOG_CLAUDE_VERSION: "2.1.267" },
        },
      },
    });
    await client.refreshProvidersSnapshot({ providers: [provider] });
    await gotoAppShell(page);
    await openProvidersInMode({ page, vortonMode: true });
    const row = page.getByRole("button", {
      name: "CLI warning account provider details",
      exact: true,
    });
    for (const width of [1280, 402]) {
      await page.setViewportSize({ width, height: 1000 });
      await expect(row).toContainText("CLI update needed");
      await row.click();
      const warning = page.getByTestId("provider-cli-update");
      await expect(warning).toContainText("2.1.267");
      await expect(warning).toContainText("Opus 5.5: 2.1.280 or later");
      await expect(warning).toContainText("brew upgrade --cask claude-code");
      await expect(warning).toBeVisible();
      expect(await warning.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      );
      await page.screenshot({ path: test.info().outputPath(`cli-update-${width}.png`) });
      await page.getByRole("button", { name: "Close", exact: true }).click();
      await expect(page.getByTestId("provider-settings-sheet")).toBeHidden();
    }
    await page.setViewportSize({ width: 1280, height: 1000 });
    await openProvidersInMode({ page, vortonMode: false });
    await expect(row).not.toContainText("CLI update needed");
    await row.click();
    await expect(page.getByTestId("provider-settings-sheet")).toBeVisible();
    await expect(page.getByTestId("provider-cli-update")).toHaveCount(0);
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await openProvidersInMode({ page, vortonMode: true });
    await expect(row).toContainText("CLI update needed");
    await client.patchDaemonConfig({
      providers: {
        [provider]: { env: { CATALOG_CLAUDE_VERSION: "2.1.285" } },
      },
    });
    await client.refreshProvidersSnapshot({ providers: [provider] });
    await expect(row).not.toContainText("CLI update needed");
    await row.click();
    await expect(page.getByTestId("provider-cli-update")).toHaveCount(0);
    await expect(
      page.getByTestId("provider-settings-sheet").getByText("Opus 5.5", { exact: true }),
    ).toBeVisible();
  } finally {
    await client.patchDaemonConfig({ removeProviders: [provider] });
    await client.close();
  }
});

test("provider rows preserve snapshot labels, layout, settings, and enabled state", async ({
  page,
}) => {
  const client = await connectDaemonClient<DaemonClient>({ clientIdPrefix: "provider-section" });
  const providerId = "section-disabled";
  try {
    // Configure only this isolated daemon; the test never launches a provider task.
    await client.patchDaemonConfig({
      providers: { [providerId]: { extends: "codex", enabled: false, label: "Disabled account" } },
    });
    await gotoAppShell(page);
    await page.goto(`/settings/hosts/${getServerId()}/providers`);
    const card = page.getByTestId("host-page-providers-card");
    await client.refreshProvidersSnapshot({ providers: ["mock"] });
    const snapshot = await client.getProvidersSnapshot();
    const labels = snapshot.entries.map(
      (entry) => `${entry.label ?? entry.provider} provider details`,
    );
    await expect
      .poll(() =>
        card.getByRole("button", { name: /provider details$/ }).evaluateAll((rows) => {
          const actualLabels = [];
          for (const row of rows) actualLabels.push(row.getAttribute("aria-label"));
          return actualLabels;
        }),
      )
      .toEqual(labels);
    const disabled = card.getByRole("button", {
      name: "Disabled account provider details",
      exact: true,
    });
    await expect(disabled.getByText("Disabled", { exact: true })).toBeVisible();
    await disabled.click();
    await expect(page.getByTestId("provider-settings-sheet")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("provider-settings-sheet")).toBeHidden();

    const mock = snapshot.entries.find((entry) => entry.provider === "mock");
    if (!mock) throw new Error("The isolated daemon must expose its deterministic provider");
    const row = card.getByRole("button", { name: `${mock.label} provider details`, exact: true });
    await expect(row.getByText("Available", { exact: true })).toBeVisible();
    const toggle = row.getByRole("switch");
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    const count = mock.models?.filter((model) => model.isSelectable !== false).length ?? 0;
    expect(count).toBeGreaterThan(1);
    const modelCount = `${count.toLocaleString()} models`;
    await expect(row.getByText(modelCount, { exact: true })).toBeVisible();
    const order = await row.evaluate(
      (element, expected) => {
        const nodes = Array.from(element.querySelectorAll("*"));
        const icons = Array.from(element.querySelectorAll("svg"));
        return {
          icons: icons.slice(0, 2).map((icon) => nodes.indexOf(icon)),
          label: nodes.findIndex((node) => node.textContent === expected.label),
          models: nodes.findIndex((node) => node.textContent === expected.modelCount),
          status: nodes.findIndex((node) => node.textContent === "Available"),
          toggle: nodes.findIndex((node) => node.getAttribute("role") === "switch"),
        };
      },
      { label: mock.label, modelCount },
    );
    expect(order.icons).toHaveLength(2);
    expect(order.icons[1]).toBeGreaterThan(order.icons[0]);
    expect(order.label).toBeGreaterThan(order.icons[1]);
    expect(order.status).toBeGreaterThan(order.label);
    expect(order.models).toBeGreaterThan(order.status);
    expect(order.toggle).toBeGreaterThan(order.models);
    const disabledToggle = disabled.getByRole("switch");
    await expect(disabledToggle).toHaveAttribute("aria-checked", "false");
    await disabledToggle.click();
    await expect(disabledToggle).toHaveAttribute("aria-checked", "true");
    await expect
      .poll(async () => (await client.getDaemonConfig()).config.providers[providerId].enabled)
      .toBe(true);
    await expect(page.getByTestId("provider-settings-sheet")).toBeHidden();
  } finally {
    try {
      await client.patchDaemonConfig({ removeProviders: [providerId] });
      expect((await client.getDaemonConfig()).config.providers[providerId]).toBeUndefined();
    } finally {
      await client.close();
    }
  }
});
