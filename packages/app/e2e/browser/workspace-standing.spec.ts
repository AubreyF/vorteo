import { z } from "zod";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { expect, test, type Page } from "../support/fixtures";
import { seedMockAgentWorkspace, openAgentRoute } from "../support/helpers/mock-agent";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";
import { getServerId } from "../support/helpers/server-id";
import { daemonWsRoutePattern } from "../support/helpers/daemon-port";

async function openMenu(page: Page, workspaceId: string) {
  const key = `${getServerId()}:${workspaceId}`;
  await page.getByTestId(`sidebar-workspace-row-${key}`).first().hover();
  await page.getByTestId(`sidebar-workspace-kebab-${key}`).first().click();
}

test("Standing is saved and protected, Scheduled stays simple, and failed changes can be retried", async ({
  page,
}) => {
  test.setTimeout(180_000);
  page.setDefaultTimeout(15_000);
  let failNext = true;
  await page.routeWebSocket(daemonWsRoutePattern(), (browser) => {
    const server = browser.connectToServer();
    browser.onMessage((message) => {
      const parsed = z
        .object({
          type: z.literal("session"),
          message: z.object({
            type: z.literal("workspace.lifecycle.set.request"),
            requestId: z.string(),
          }),
        })
        .safeParse(JSON.parse(typeof message === "string" ? message : message.toString("utf8")));
      const request = parsed.success ? parsed.data.message : null;
      if (failNext && request?.type === "workspace.lifecycle.set.request") {
        failNext = false;
        browser.send(
          JSON.stringify({
            type: "session",
            message: {
              type: "rpc_error",
              payload: {
                requestId: request.requestId,
                requestType: request.type,
                error: "Lifecycle change could not be saved. Try again.",
                code: "handler_error",
              },
            },
          }),
        );
      } else server.send(message);
    });
    server.onMessage((message) => browser.send(message));
  });
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "standing-workspace-",
    title: "Council updates",
  });
  const client = await connectDaemonClient<DaemonClient>({ clientIdPrefix: "standing-workspaces" });
  let scheduleId: string | undefined;
  try {
    await client.setWorkspaceLabel({
      workspaceId: agent.workspaceId,
      label: { name: "Protected", color: "amber" },
      assigned: true,
    });
    const created = await client.scheduleCreate({
      name: "Council heartbeat",
      prompt: "Review updates",
      target: { type: "agent", agentId: agent.agentId },
      cadence: { type: "cron", expression: "0 0 1 1 *", timezone: "UTC" },
      runOnCreate: false,
    });
    if (!created.schedule) throw new Error(created.error ?? "Expected schedule");
    scheduleId = created.schedule.id;
    await client.schedulePause({ id: scheduleId });
    await openAgentRoute(page, agent);
    await expect(page.getByTestId("workspace-label-chip-Protected")).toHaveText(
      "Protected (custom)",
    );
    await expect(page.getByTestId(`workspace-shield-${agent.workspaceId}`)).toBeHidden();
    await expect(page.getByTestId(`workspace-scheduled-${agent.workspaceId}`)).toHaveText(
      "Scheduled",
    );
    await openMenu(page, agent.workspaceId);
    await expect(page.getByTestId(`workspace-standing-${agent.workspaceId}`)).toBeHidden();
    await page
      .getByTestId(`sidebar-workspace-menu-labels-${getServerId()}:${agent.workspaceId}`)
      .click();
    await expect(page.getByText("Custom labels", { exact: true })).toBeVisible();
    await expect(page.getByTestId("workspace-label-picker-row-Protected")).toHaveText(
      "Protected (custom)",
    );
    await expect(page.getByTestId("workspace-label-picker-create")).toHaveText("Create Label");
    await page.getByTestId(`workspace-standing-${agent.workspaceId}`).click();
    await expect(page.getByText("Lifecycle change could not be saved. Try again.")).toBeVisible();
    await page.getByTestId(`workspace-standing-${agent.workspaceId}`).click();
    await expect(page.getByTestId(`workspace-shield-${agent.workspaceId}`)).toBeVisible();
    await page.keyboard.press("Escape");
    const section = page.getByTestId(/^sidebar-standing-section-/);
    await expect(section).toHaveText("Standing · 1");
    await section.click();
    await expect(page.getByTestId(`workspace-shield-${agent.workspaceId}`)).toBeHidden();
    await section.click();
    await expect(page.getByTestId(`workspace-shield-${agent.workspaceId}`)).toBeVisible();
    await page.mouse.move(900, 700);
    const row = page
      .getByTestId(`sidebar-workspace-row-${getServerId()}:${agent.workspaceId}`)
      .first();
    const scheduledBadge = page.getByTestId(`workspace-scheduled-${agent.workspaceId}`);
    const protectedBadge = page.getByTestId(`workspace-shield-${agent.workspaceId}`);
    await expect.poll(async () => (await scheduledBadge.boundingBox())?.height).toBe(24);
    expect((await protectedBadge.boundingBox())?.height).toBe(24);
    const resting = await scheduledBadge.boundingBox();
    const protection = await protectedBadge.boundingBox();
    const rowBox = await row.boundingBox();
    if (!resting || !protection || !rowBox) throw new Error("Expected visible workspace badges");
    expect(Math.abs(resting.y - protection.y)).toBeLessThan(1);
    expect(rowBox.x + rowBox.width - resting.x - resting.width).toBeLessThanOrEqual(12);
    await page.screenshot({ path: test.info().outputPath("badges-resting.png") });
    await row.hover();
    const menu = page
      .getByTestId(`sidebar-workspace-kebab-${getServerId()}:${agent.workspaceId}`)
      .first();
    await expect(menu).toBeVisible();
    await expect
      .poll(async () => {
        const box = await scheduledBadge.boundingBox();
        return box ? Math.round(resting.x + resting.width - box.x - box.width) : 0;
      })
      .toBe(28);
    const menuBox = await menu.boundingBox();
    const shifted = await scheduledBadge.boundingBox();
    if (!menuBox || !shifted) throw new Error("Expected hovered workspace actions");
    expect(menuBox.x).toBeGreaterThanOrEqual(shifted.x + shifted.width);
    expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(rowBox.x + rowBox.width);
    const title = row.getByText("main", { exact: true });
    expect((await title.boundingBox())?.width).toBeGreaterThanOrEqual(48);
    await page.screenshot({ path: test.info().outputPath("badges-hovered.png") });
    expect((await client.archiveWorkspace(agent.workspaceId)).error).toContain("protected");
    await expect(client.archiveAgent(agent.agentId)).rejects.toThrow("protected");
    await openMenu(page, agent.workspaceId);
    await page
      .getByTestId(`sidebar-workspace-menu-archive-${getServerId()}:${agent.workspaceId}`)
      .click();
    await expect(
      page.getByText(
        "This workspace is protected. Remove protection from its menu before archiving.",
      ),
    ).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("standing-desktop.png") });
    await openMenu(page, agent.workspaceId);
    await page
      .getByTestId(`sidebar-workspace-menu-labels-${getServerId()}:${agent.workspaceId}`)
      .click();
    await page.getByTestId(`workspace-protected-${agent.workspaceId}`).click();
    await expect(page.getByTestId(`workspace-protected-${agent.workspaceId}`)).toHaveAttribute(
      "aria-checked",
      "false",
    );
    await page.waitForTimeout(400); // Capture the settled flyout, after its entry animation.
    await page.screenshot({ path: test.info().outputPath("tag-as-desktop.png") });
    await page.keyboard.press("Escape");
    expect(
      (await client.fetchWorkspaces()).entries.find((w) => w.id === agent.workspaceId),
    ).toMatchObject({ standing: true, protected: false });
  } finally {
    if (scheduleId) await client.scheduleDelete({ id: scheduleId });
    await client.setWorkspaceLifecycle({ workspaceId: agent.workspaceId, protected: false });
    await client.close();
    await agent.cleanup();
  }
});

test.describe("touch controls", () => {
  test.use({ hasTouch: true, viewport: { width: 1280, height: 800 } });

  test("Standing and Scheduled keep touch targets on a wide touchscreen", async ({ page }) => {
    test.setTimeout(180_000);
    page.setDefaultTimeout(15_000);
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "standing-touch-",
      title: "Standing supervisor",
    });
    const client = await connectDaemonClient<DaemonClient>({ clientIdPrefix: "standing-touch" });
    let scheduleId: string | undefined;
    try {
      await client.setWorkspaceLifecycle({ workspaceId: agent.workspaceId, standing: true });
      const created = await client.scheduleCreate({
        name: "Supervisor heartbeat",
        prompt: "Review updates",
        target: { type: "agent", agentId: agent.agentId },
        cadence: { type: "cron", expression: "0 0 1 1 *", timezone: "UTC" },
        runOnCreate: false,
      });
      if (!created.schedule) throw new Error(created.error ?? "Expected schedule");
      scheduleId = created.schedule.id;
      await client.schedulePause({ id: scheduleId });
      await openAgentRoute(page, agent);
      const section = page.getByTestId(/^sidebar-standing-section-/);
      const scheduled = page.getByTestId(`workspace-scheduled-${agent.workspaceId}`);
      await expect(scheduled).toBeVisible();
      expect((await section.boundingBox())?.height).toBeGreaterThanOrEqual(44);
      expect((await scheduled.boundingBox())?.height).toBeGreaterThanOrEqual(44);
      await section.tap();
      await expect(scheduled).toBeHidden();
      await section.tap();
      await expect(scheduled).toBeVisible();
      await page.screenshot({ path: test.info().outputPath("standing-touch.png") });
      await page.getByTestId(`sidebar-workspace-kebab-${getServerId()}:${agent.workspaceId}`).tap();
      await page
        .getByTestId(`sidebar-workspace-menu-labels-${getServerId()}:${agent.workspaceId}`)
        .tap();
      const protection = page.getByTestId(`workspace-protected-${agent.workspaceId}`);
      await expect(protection).toHaveAttribute("aria-checked", "true");
      await expect(protection).toHaveCSS("min-height", "44px");
      // The menu's animated transform can retain a fractional CSS pixel.
      await expect
        .poll(async () => Math.round((await protection.boundingBox())?.height ?? 0))
        .toBeGreaterThanOrEqual(44);
      await page.screenshot({ path: test.info().outputPath("tag-as-touch.png") });
      await page.touchscreen.tap(900, 200);
      await expect(protection).toBeHidden();
      await scheduled.tap();
      await expect(page).toHaveURL(/\/schedules$/);
    } finally {
      if (scheduleId) await client.scheduleDelete({ id: scheduleId });
      await client.setWorkspaceLifecycle({ workspaceId: agent.workspaceId, protected: false });
      await client.close();
      await agent.cleanup();
    }
  });
});
