import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";
import { getServerId } from "../support/helpers/server-id";

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
