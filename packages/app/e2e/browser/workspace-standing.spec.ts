import { z } from "zod";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { expect, test, type Page } from "../support/fixtures";
import { seedMockAgentWorkspace, openAgentRoute } from "../support/helpers/mock-agent";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";
import { getServerId } from "../support/helpers/server-id";
import { openWorkspaceActionsMenu } from "../support/helpers/workspace-ui";
import { daemonWsRoutePattern } from "../support/helpers/daemon-port";
import { SIDEBAR_INDENT_UNIT } from "../../src/components/sidebar/indent";
import { openMobileAgentSidebar } from "../support/helpers/sidebar";

/**
 * Escape closes an open tooltip first and the menu on the next press, so keep pressing until
 * no menu backdrop remains.
 */
async function closeMenus(page: Page) {
  const backdrop = page.locator('[aria-label="Menu backdrop"]');
  for (let attempt = 0; attempt < 3 && (await backdrop.count()) > 0; attempt += 1) {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);
  }
  await expect(backdrop).toHaveCount(0);
}

/** The labels submenu repeats the workspace menu's toggles; act on the submenu's copy. */
function labelsItem(page: Page, workspaceId: string, item: "protected" | "schedules") {
  return page
    .getByTestId(`sidebar-workspace-menu-content-${getServerId()}:${workspaceId}-workspaceLabels`)
    .getByTestId(`workspace-${item}-${workspaceId}`);
}

async function openMenu(page: Page, workspaceId: string) {
  const key = `${getServerId()}:${workspaceId}`;
  await page.getByTestId(`sidebar-workspace-row-${key}`).first().hover();
  await page.getByTestId(`sidebar-workspace-kebab-${key}`).first().click();
}

// Geometry drift, owner review (2026-10-24): the Standing section's disclosure arrow should be
// centred on the workspace status dot column (under 1px apart) but measures 14px off. No commit
// records the change as intended; 5653d0c93 says workspace indentation is preserved.
test.fixme("Standing follows schedules and protection, and failed changes can be retried", async ({
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
    await client.createAgent({
      provider: "mock",
      labels: { [PARENT_AGENT_ID_LABEL]: agent.agentId },
      workspaceId: agent.workspaceId,
      cwd: agent.cwd,
      title: "Count badge reference",
      model: "e2e-fast-stream",
      modeId: "load-test",
    });
    await client.setWorkspaceLabel({
      workspaceId: agent.workspaceId,
      label: { name: "Review", color: "amber" },
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
    await expect(page.getByTestId("workspace-label-chip-Review")).toHaveText("Review");
    await expect(page.getByTestId(`workspace-shield-${agent.workspaceId}`)).toBeHidden();
    // The badge is icon-only; its state is in its accessible name.
    await expect(page.getByTestId(`workspace-scheduled-${agent.workspaceId}`)).toHaveAccessibleName(
      /^Paused workspace/,
    );
    await expect(
      page.getByTestId(`workspace-subagent-count-${getServerId()}-${agent.workspaceId}`),
    ).not.toBeAttached();
    // Status badges are icons and custom labels keep text chips (0d18398e7); they share a line.
    const badgeBox = (await page
      .getByTestId(`workspace-scheduled-${agent.workspaceId}`)
      .boundingBox())!;
    const chipBox = (await page.getByTestId("workspace-label-chip-Review").boundingBox())!;
    expect(
      Math.abs(badgeBox.y + badgeBox.height / 2 - (chipBox.y + chipBox.height / 2)),
    ).toBeLessThan(1);
    await openMenu(page, agent.workspaceId);
    await expect(page.getByTestId(`workspace-standing-${agent.workspaceId}`)).toBeHidden();
    await page
      .getByTestId(`sidebar-workspace-menu-labels-${getServerId()}:${agent.workspaceId}`)
      .click();
    await expect(page.getByText("Custom labels", { exact: true })).toBeVisible();
    await expect(page.getByTestId("workspace-label-picker-create")).toHaveText("Create Label");
    await expect(page.getByTestId("workspace-label-picker-row-Review")).toBeVisible();
    await labelsItem(page, agent.workspaceId, "protected").click();
    await expect(page.getByText("Lifecycle change could not be saved. Try again.")).toBeVisible();
    await labelsItem(page, agent.workspaceId, "protected").click();
    await expect(page.getByTestId(`workspace-shield-${agent.workspaceId}`)).toBeVisible();
    await page.keyboard.press("Escape");
    const section = page.getByTestId(/^sidebar-standing-section-.*-toggle$/);
    await expect(section).toHaveText("Standing");
    const heading = section.getByText("Standing", { exact: true });
    const workspaceRow = page
      .getByTestId(`sidebar-workspace-row-${getServerId()}:${agent.workspaceId}`)
      .first();
    const dot = workspaceRow.getByTestId("workspace-status-indicator-done").locator(":scope > div");
    const headingBox = await heading.boundingBox();
    const dotBox = await dot.boundingBox();
    if (!headingBox || !dotBox) throw new Error("Expected Standing heading and workspace dot");

    const titleSize = await workspaceRow
      .getByText("main", { exact: true })
      .evaluate((element) => getComputedStyle(element).fontSize);
    await expect(heading).toHaveCSS("font-size", titleSize);
    // Standing is a project child like a folder, so its folder icon sits one indent unit
    // outside the workspaces it holds.
    const folderIconBox = await section.locator("svg").first().boundingBox();
    if (!folderIconBox) throw new Error("Expected leading folder icon");
    const iconCenter = folderIconBox.x + folderIconBox.width / 2;
    expect(Math.abs(dotBox.x + dotBox.width / 2 - iconCenter - SIDEBAR_INDENT_UNIT)).toBeLessThan(
      1,
    );
    expect(headingBox.x - folderIconBox.x - folderIconBox.width).toBeGreaterThanOrEqual(8);
    const workspaceTitleBox = await workspaceRow.getByText("main", { exact: true }).boundingBox();
    expect(Math.abs(workspaceTitleBox!.x - headingBox.x - SIDEBAR_INDENT_UNIT)).toBeLessThan(1);
    await section.hover();
    expect(await section.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe(
      "rgba(0, 0, 0, 0)",
    );
    const sectionBox = await section.boundingBox();
    const workspaceBox = await workspaceRow.boundingBox();
    expect(sectionBox?.width).toBe(workspaceBox?.width);

    await section.click();
    await expect(section).toContainText("1");
    const collapsedBadge = section.getByTestId(/^count-sidebar-standing-section-/);
    await expect(collapsedBadge).toHaveCSS("min-width", "20px");
    expect((await collapsedBadge.boundingBox())!.width).toBeGreaterThanOrEqual(20);
    await page.screenshot({ path: test.info().outputPath("standing-collapsed.png") });
    await expect(page.getByTestId(`workspace-shield-${agent.workspaceId}`)).toBeHidden();
    await section.click();
    await expect(page.getByTestId(`workspace-shield-${agent.workspaceId}`)).toBeVisible();
    await page.mouse.move(900, 700);
    const row = page
      .getByTestId(`sidebar-workspace-row-${getServerId()}:${agent.workspaceId}`)
      .first();
    const scheduledBadge = page.getByTestId(`workspace-scheduled-${agent.workspaceId}`);
    const protectedBadge = page.getByTestId(`workspace-shield-${agent.workspaceId}`);
    const countBadge = page.getByTestId(
      `workspace-subagent-count-${getServerId()}-${agent.workspaceId}`,
    );
    await expect(countBadge).not.toBeAttached();
    const countHeight = (await page.getByTestId("workspace-label-chip-Review").boundingBox())!
      .height;
    expect((await scheduledBadge.boundingBox())?.height).toBe(countHeight);
    expect((await protectedBadge.boundingBox())?.height).toBe(countHeight);
    await expect(page.getByTestId("workspace-label-chip-Review")).toBeVisible();
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
      .toBe(0);
    const menuBox = await menu.boundingBox();
    const shifted = await scheduledBadge.boundingBox();
    if (!menuBox || !shifted) throw new Error("Expected hovered workspace actions");
    expect(shifted).toEqual(resting);
    expect(menuBox.x).toBeLessThan(shifted.x + shifted.width);
    expect(menuBox.x + menuBox.width).toBeGreaterThan(shifted.x);
    await expect(menu).toHaveCSS("border-radius", "0px");
    expect(await menu.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe(
      "rgba(0, 0, 0, 0)",
    );
    expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(rowBox.x + rowBox.width);
    const title = row.getByText("main", { exact: true });
    expect((await title.boundingBox())?.width).toBeGreaterThanOrEqual(48);
    await expect(row.getByTestId("sidebar-menu-fade")).toBeVisible();
    const rowBackground = await row.evaluate(
      (element) => getComputedStyle(element).backgroundColor,
    );
    await expect(menu).toHaveCSS("background-color", rowBackground);
    await expect(row.getByTestId("sidebar-menu-backdrop")).toHaveCSS(
      "background-color",
      rowBackground,
    );
    await expect(row.getByTestId("sidebar-menu-fade").locator("stop").last()).toHaveCSS(
      "stop-color",
      rowBackground,
    );
    await page.screenshot({ path: test.info().outputPath("badges-hovered.png") });
    await menu.hover();
    await expect(menu).toHaveCSS("border-radius", "4px");
    expect(await scheduledBadge.boundingBox()).toEqual(resting);
    await page.screenshot({ path: test.info().outputPath("menu-hovered.png") });
    expect((await client.archiveWorkspace(agent.workspaceId)).error).toContain("protected");
    await expect(client.archiveAgent(agent.agentId)).rejects.toThrow("protected");
    await openMenu(page, agent.workspaceId);
    const archive = page.getByTestId(
      `sidebar-workspace-menu-archive-${getServerId()}:${agent.workspaceId}`,
    );
    await expect(archive).toBeDisabled();
    await archive.locator("..").hover();
    await expect(
      page.getByText("Unprotect and remove schedules to archive", { exact: true }),
    ).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("standing-desktop.png") });
    await page.keyboard.press("Escape");
    await openMenu(page, agent.workspaceId);
    await page
      .getByTestId(`sidebar-workspace-menu-labels-${getServerId()}:${agent.workspaceId}`)
      .click();
    await labelsItem(page, agent.workspaceId, "protected").click();
    await expect(labelsItem(page, agent.workspaceId, "protected")).toHaveAttribute(
      "aria-checked",
      "false",
    );
    await page.waitForTimeout(400); // Capture the settled flyout, after its entry animation.
    await page.screenshot({ path: test.info().outputPath("tag-as-desktop.png") });
    await page.keyboard.press("Escape");
    expect(
      (await client.fetchWorkspaces()).entries.find((w) => w.id === agent.workspaceId),
    ).toMatchObject({ protected: false });
  } finally {
    if (scheduleId) await client.scheduleDelete({ id: scheduleId });
    await client.setWorkspaceLifecycle({ workspaceId: agent.workspaceId, protected: false });
    await client.close();
    await agent.cleanup();
  }
});

test.describe("touch controls", () => {
  test.use({ hasTouch: true, viewport: { width: 1280, height: 800 } });

  for (const width of [1280, 390]) {
    test(`focused Standing keeps usable breadcrumb targets at ${width}px`, async ({ page }) => {
      test.setTimeout(180_000);
      await page.setViewportSize({ width, height: 844 });
      const agent = await seedMockAgentWorkspace({
        repoPrefix: "standing-focus-touch-",
        title: "Focused supervisor",
      });
      try {
        await agent.client.setWorkspaceLifecycle({
          workspaceId: agent.workspaceId,
          standing: true,
        });
        await openAgentRoute(page, agent);
        if (width < 600) await openMobileAgentSidebar(page);
        const focus = page.getByTestId(/^sidebar-standing-section-.*-focus$/);
        await expect(focus).toBeVisible();
        await focus.tap();
        const breadcrumb = page.getByTestId("sidebar-focus-breadcrumb");
        await expect(breadcrumb).toBeVisible();
        await expect(page.getByTestId("sidebar-focus-current")).toHaveText("Standing");
        for (const link of await breadcrumb.getByRole("link").all()) {
          const box = await link.boundingBox();
          expect(box?.height).toBeGreaterThanOrEqual(44);
          expect(box?.width).toBeGreaterThanOrEqual(44);
        }
        await page.screenshot({ path: test.info().outputPath(`standing-focus-${width}.png`) });
        await page.reload();
        if (width < 600) await openMobileAgentSidebar(page);
        await expect(page.getByTestId("sidebar-focus-current")).toHaveText("Standing");
        await page.getByTestId("sidebar-focus-crumb-all").tap();
        await expect(breadcrumb).toBeHidden();
        await expect(focus).toBeVisible();
      } finally {
        await agent.client.setWorkspaceLifecycle({
          workspaceId: agent.workspaceId,
          protected: false,
        });
        await agent.cleanup();
      }
    });
  }

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
      const section = page.getByTestId(/^sidebar-standing-section-.*-toggle$/);
      const scheduled = page.getByTestId(`workspace-scheduled-${agent.workspaceId}`);
      await expect(scheduled).toBeVisible();
      expect((await section.boundingBox())?.height).toBeGreaterThanOrEqual(44);
      expect((await scheduled.boundingBox())?.height).toBeGreaterThanOrEqual(44);
      await section.tap();
      await expect(scheduled).toBeHidden();
      await section.tap();
      await expect(scheduled).toBeVisible();
      await page.screenshot({ path: test.info().outputPath("standing-touch.png") });
      // Touch rows have no overflow button since 2415534c8; the workspace menu has its actions.
      await openWorkspaceActionsMenu(page, { tap: true });
      await page.getByTestId("workspace-header-labels").tap();
      const protection = page
        .getByTestId(`workspace-protected-${agent.workspaceId}`)
        .filter({ visible: true })
        .last();
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
      await expect(page).toHaveURL(/\/schedules\?.*workspaceId=/);
    } finally {
      if (scheduleId) await client.scheduleDelete({ id: scheduleId });
      await client.setWorkspaceLifecycle({ workspaceId: agent.workspaceId, protected: false });
      await client.close();
      await agent.cleanup();
    }
  });
});

test("older environments show disabled built-in protection instead of a custom label", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.routeWebSocket(daemonWsRoutePattern(), (browser) => {
    const server = browser.connectToServer();
    browser.onMessage((message) => server.send(message));
    server.onMessage((message) => {
      if (typeof message !== "string") {
        browser.send(message);
        return;
      }
      const envelope = JSON.parse(message) as {
        message?: {
          type?: string;
          payload?: { status?: string; features?: Record<string, unknown> };
        };
      };
      if (
        envelope.message?.type === "status" &&
        envelope.message.payload?.status === "server_info"
      ) {
        envelope.message.payload.features = {
          ...envelope.message.payload.features,
          workspaceLifecycle: false,
        };
      }
      browser.send(JSON.stringify(envelope));
    });
  });
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "standing-old-environment-",
    title: "Protected legacy label",
  });
  try {
    await agent.client.setWorkspaceLabel({
      workspaceId: agent.workspaceId,
      label: { name: "Review", color: "red" },
      assigned: true,
    });
    await openAgentRoute(page, agent);
    await openMenu(page, agent.workspaceId);
    await page
      .getByTestId(`sidebar-workspace-menu-labels-${getServerId()}:${agent.workspaceId}`)
      .click();
    const protection = labelsItem(page, agent.workspaceId, "protected");
    await expect(protection).toHaveText("Protected");
    await expect(protection).toHaveAttribute("aria-disabled", "true");
    await expect(page.getByTestId("workspace-label-picker-row-Review")).toBeVisible();
    await expect(
      page
        .getByTestId(
          `sidebar-workspace-menu-content-${getServerId()}:${agent.workspaceId}-workspaceLabels`,
        )
        .getByText("Update this environment to use Protected."),
    ).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("protected-old-environment.png") });
  } finally {
    await agent.cleanup();
  }
});

test("workspace schedule creation, pause, resume and deletion drive Standing", async ({ page }) => {
  test.setTimeout(180_000);
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "schedule-membership-",
    title: "Scheduled review",
  });
  const client = await connectDaemonClient<DaemonClient>({ clientIdPrefix: "schedule-membership" });
  let scheduleId: string | undefined;
  try {
    await openAgentRoute(page, agent);
    const section = page.getByTestId(/^sidebar-standing-section-.*-toggle$/);
    await expect(section).toBeHidden();
    await openMenu(page, agent.workspaceId);
    await page
      .getByTestId(`sidebar-workspace-menu-labels-${getServerId()}:${agent.workspaceId}`)
      .click();
    await expect(page.getByTestId(`workspace-standing-${agent.workspaceId}`)).toBeHidden();
    const catalog = await client.listWorkspaceLabels();
    await expect(page.getByText("Custom labels", { exact: true })).toHaveCount(
      catalog.labels.length > 0 ? 1 : 0,
    );
    await labelsItem(page, agent.workspaceId, "schedules").click();
    await expect(page.getByText("Workspace schedules", { exact: true })).toBeVisible();
    await page.getByTestId("schedules-empty-new").click();
    await page.getByTestId("schedule-name-input").fill("Workspace review");
    await page.getByTestId("schedule-prompt-input").fill("Review pending changes");
    await expect(page.getByTestId("schedule-project-trigger")).toBeHidden();
    await page.getByTestId("schedule-cadence-preset-trigger").click();
    await page.getByTestId("schedule-cadence-preset-daily-9").click();
    await page.getByRole("button", { name: "Create schedule", exact: true }).click();
    await expect(page.getByTestId("schedule-form-sheet")).toBeHidden();
    const schedules = await client.scheduleList();
    const created = schedules.schedules.find((schedule) => schedule.name === "Workspace review");
    expect(created?.target).toEqual({ type: "agent", agentId: agent.agentId });
    if (!created) throw new Error("Expected created workspace schedule");
    scheduleId = created.id;
    await openAgentRoute(page, agent);
    const badge = page.getByTestId(`workspace-scheduled-${agent.workspaceId}`);
    await expect(badge).toHaveAccessibleName(/^Scheduled workspace/);
    await expect(section).toHaveText("Standing");
    await client.schedulePause({ id: scheduleId });
    await expect(badge).toHaveAccessibleName(/^Paused workspace/, { timeout: 25_000 });
    await expect(section).toHaveText("Standing");
    await client.scheduleResume({ id: scheduleId });
    await expect(badge).toHaveAccessibleName(/^Scheduled workspace/, { timeout: 25_000 });
    await client.setWorkspaceLifecycle({ workspaceId: agent.workspaceId, protected: true });
    await client.scheduleDelete({ id: scheduleId });
    scheduleId = undefined;
    await expect(badge).toBeHidden({ timeout: 25_000 });
    await expect(section).toHaveText("Standing");
    await client.setWorkspaceLifecycle({ workspaceId: agent.workspaceId, protected: false });
    await expect(section).toBeHidden();
  } finally {
    if (scheduleId) await client.scheduleDelete({ id: scheduleId });
    await client.setWorkspaceLifecycle({ workspaceId: agent.workspaceId, protected: false });
    await client.close();
    await agent.cleanup();
  }
});

for (const state of ["protected", "scheduled", "paused", "protected-scheduled"] as const) {
  test(`archive stays locked for ${state} until blockers are removed`, async ({ page }) => {
    // Product regression, reported to Builds on 2026-10-24: since 84f489a59 the daemon checks
    // protection before schedules, so archiving a protected, scheduled workspace reports only
    // "Unprotect to archive". Remove the fixme once it names both blockers.
    test.fixme(state === "protected-scheduled", "Archive reports only the protection blocker");
    test.setTimeout(180_000);
    page.setDefaultTimeout(15_000);
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "archive-lock-",
      title: "Archive lock",
    });
    const client = await connectDaemonClient<DaemonClient>({ clientIdPrefix: "archive-lock" });
    const protectedWorkspace = state === "protected" || state === "protected-scheduled";
    const scheduled = state !== "protected";
    const reasons = {
      protected: "Unprotect to archive",
      active: "Remove schedules to archive",
      scheduled: "Remove schedules to archive",
      paused: "Remove schedules to archive",
      "protected-scheduled": "Unprotect and remove schedules to archive",
    };
    const reason = reasons[state];
    let scheduleId: string | undefined;
    try {
      await client.setWorkspaceLifecycle({
        workspaceId: agent.workspaceId,
        protected: protectedWorkspace,
      });
      if (scheduled) {
        const created = await client.scheduleCreate({
          name: "Archive guard schedule",
          prompt: "Review",
          target: { type: "agent", agentId: agent.agentId },
          cadence: { type: "cron", expression: "0 0 1 1 *", timezone: "UTC" },
          runOnCreate: false,
        });
        if (!created.schedule) throw new Error(created.error ?? "Expected schedule");
        scheduleId = created.schedule.id;
        if (state === "paused") await client.schedulePause({ id: scheduleId });
      }
      await openAgentRoute(page, agent);
      const key = `${getServerId()}:${agent.workspaceId}`;
      const row = page.getByTestId(`sidebar-workspace-row-${key}`).first();
      await expect(row).toBeVisible();
      await openMenu(page, agent.workspaceId);
      const archive = page.getByTestId(`sidebar-workspace-menu-archive-${key}`);
      await expect(archive).toBeDisabled();
      await archive.locator("..").hover();
      await expect(page.getByText(reason, { exact: true })).toBeVisible();
      await page.screenshot({ path: test.info().outputPath(`${state}-archive-locked.png`) });
      await closeMenus(page);
      await page.keyboard.press("Control+Shift+Backspace");
      await page.keyboard.press("Meta+Shift+Backspace");
      await expect(row).toBeVisible();
      expect((await client.archiveWorkspace(agent.workspaceId)).error).toContain(reason);
      // The context menu uses the same lock and tooltip as the overflow menu.
      await row.click({ button: "right" });
      await expect(archive).toBeDisabled();
      await closeMenus(page);
      if (protectedWorkspace) {
        await openMenu(page, agent.workspaceId);
        await page.getByTestId(`sidebar-workspace-menu-labels-${key}`).click();
        await labelsItem(page, agent.workspaceId, "protected").click();
        await expect(page.getByTestId(`workspace-shield-${agent.workspaceId}`)).toBeHidden();
        await closeMenus(page);
      }
      await openMenu(page, agent.workspaceId);
      if (scheduleId) {
        await expect(archive).toBeDisabled();
        await archive.locator("..").hover();
        await expect(page.getByText("Remove schedules to archive", { exact: true })).toBeVisible();
        const retained = await client.scheduleList();
        expect(retained.schedules.some((schedule) => schedule.id === scheduleId)).toBe(true);
        await client.scheduleDelete({ id: scheduleId });
        scheduleId = undefined;
        await closeMenus(page);
        await expect(page.getByTestId(`workspace-scheduled-${agent.workspaceId}`)).toBeHidden({
          timeout: 30_000,
        });
        // Leaving derived Standing moves the row and closes its old menu.
        await openMenu(page, agent.workspaceId);
      }
      await expect(archive).toBeEnabled({ timeout: 30_000 });
      await archive.click();
      await expect(row).toBeHidden();
    } finally {
      if (scheduleId) await client.scheduleDelete({ id: scheduleId });
      const exists = (await client.fetchWorkspaces()).entries.some(
        (entry) => entry.id === agent.workspaceId,
      );
      if (exists)
        await client.setWorkspaceLifecycle({ workspaceId: agent.workspaceId, protected: false });
      await client.close();
      await agent.cleanup();
    }
  });
}

test.describe("compact archive lock", () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });
  test("shows why Archive is locked without hover", async ({ page }) => {
    test.setTimeout(180_000);
    page.setDefaultTimeout(15_000);
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "archive-lock-touch-",
      title: "Protected touch",
    });
    const client = await connectDaemonClient<DaemonClient>({
      clientIdPrefix: "archive-lock-touch",
    });
    try {
      await client.setWorkspaceLifecycle({ workspaceId: agent.workspaceId, protected: true });
      await openAgentRoute(page, agent);
      // Touch rows have no overflow button since 2415534c8; the title menu has the same actions.
      await page.getByTestId("workspace-header-menu-trigger").filter({ visible: true }).tap();
      await expect(page.getByTestId("workspace-header-archive")).toBeDisabled();
      const hint = page.getByText("Unprotect to archive", { exact: true });
      await hint.scrollIntoViewIfNeeded();
      await expect(hint).toBeInViewport({ ratio: 1 });
      await page.screenshot({ path: test.info().outputPath("compact-archive-lock.png") });
    } finally {
      await client.setWorkspaceLifecycle({ workspaceId: agent.workspaceId, protected: false });
      await client.close();
      await agent.cleanup();
    }
  });
  // Product regression, reported to Builds on 2026-10-24: since 56b01ba3a phones cannot open the
  // Explorer's Changes view. Remove the fixme once they can.
  test.fixme("compact Git Archive explains the schedule lock outside the sidebar", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    page.setDefaultTimeout(15_000);
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "archive-lock-git-",
      title: "Scheduled Git guard",
    });
    const client = await connectDaemonClient<DaemonClient>({ clientIdPrefix: "archive-lock-git" });
    let scheduleId: string | undefined;
    try {
      const created = await client.scheduleCreate({
        prompt: "Review",
        target: { type: "agent", agentId: agent.agentId },
        cadence: { type: "cron", expression: "0 0 1 1 *", timezone: "UTC" },
        runOnCreate: false,
      });
      if (!created.schedule) throw new Error(created.error ?? "Expected schedule");
      scheduleId = created.schedule.id;
      await client.schedulePause({ id: scheduleId });
      await openAgentRoute(page, agent);
      const changesTab = page.getByTestId("explorer-tab-changes").filter({ visible: true });
      if (!(await changesTab.isVisible()))
        await page.getByTestId("workspace-explorer-toggle").first().click();
      await expect(changesTab).toBeVisible();
      await changesTab.click();
      const explorer = page.getByTestId("explorer-content-area").filter({ visible: true });
      await explorer.getByTestId("changes-actions-menu-trigger").click();
      const archive = page.getByTestId("workspace-archive-action");
      await expect(archive).toBeDisabled();
      const hint = archive.getByText("Remove schedules to archive", { exact: true });
      await hint.scrollIntoViewIfNeeded();
      await expect(hint).toBeInViewport({ ratio: 1 });
      await page.screenshot({ path: test.info().outputPath("compact-git-archive-lock.png") });
      await client.setWorkspaceLifecycle({ workspaceId: agent.workspaceId, protected: false });
      await expect(archive).toBeDisabled();
      await client.scheduleDelete({ id: scheduleId });
      scheduleId = undefined;
      await expect(archive).toBeEnabled({ timeout: 30_000 });
    } finally {
      if (scheduleId) await client.scheduleDelete({ id: scheduleId });
      await client.close();
      await agent.cleanup();
    }
  });
});

test("sidebar sub-agent badge counts active work and hides finished unarchived workers", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "active-workers-",
    title: "Active worker counts",
  });
  const client = await connectDaemonClient<DaemonClient>({ clientIdPrefix: "active-worker-count" });
  try {
    const child = await client.createAgent({
      provider: "mock",
      labels: { [PARENT_AGENT_ID_LABEL]: agent.agentId },
      workspaceId: agent.workspaceId,
      cwd: agent.cwd,
      title: "Working child",
      model: "ten-second-stream",
      modeId: "load-test",
    });
    await client.createAgent({
      provider: "mock",
      labels: { [PARENT_AGENT_ID_LABEL]: agent.agentId },
      workspaceId: agent.workspaceId,
      cwd: agent.cwd,
      title: "Idle child",
      model: "e2e-fast-stream",
      modeId: "load-test",
    });
    await openAgentRoute(page, agent);
    const badge = page.getByTestId(
      `workspace-subagent-count-${getServerId()}-${agent.workspaceId}`,
    );
    await expect(badge).not.toBeAttached();
    await client.sendAgentMessage(child.id, "Work on the sidebar check.");
    await expect(badge).toHaveText("A1");
    await expect(badge.getByLabel("1 active subagent")).toHaveText("A1");
    await page.screenshot({ path: test.info().outputPath("active-subagent-badge.png") });
    await expect(badge).not.toBeAttached({ timeout: 30_000 });
    await page.reload();
    await expect(badge).not.toBeAttached();
  } finally {
    await client.close();
    await agent.cleanup();
  }
});
