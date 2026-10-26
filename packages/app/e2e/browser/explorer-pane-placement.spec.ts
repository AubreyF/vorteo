// Splitting a tab out of a pane leaves a New tab behind, and the workspace must stay usable:
// Explorer never replaces the last ordinary pane, including after a reload.
import { expect, type Locator, type Page } from "@playwright/test";
import { test } from "../support/fixtures";
import { gotoWorkspace } from "../support/helpers/launcher";
import { seedCorruptedWorkspaceLayout } from "../support/helpers/workspace-layout";

function mainTabRow(page: Page): Locator {
  return page
    .locator('[data-testid^="workspace-pane-"]')
    .getByTestId("workspace-tabs-row")
    .filter({ visible: true });
}

function draftTabChip(page: Page): Locator {
  return page.locator('[data-testid^="workspace-tab-draft_"]').filter({ visible: true });
}

function newTabPaneChild(page: Page): Locator {
  return page
    .getByTestId("split-group-child")
    .filter({ has: page.getByTestId("workspace-new-tab-panel") })
    .first();
}

async function emptyPaneBox(page: Page) {
  const paneChild = newTabPaneChild(page);
  await expect(paneChild).toBeVisible({ timeout: 15_000 });
  const box = await paneChild.boundingBox();
  expect(box).not.toBeNull();
  if (!box) throw new Error("New tab pane has no bounding box");
  return box;
}

/** dnd-kit pointer drag from a tab chip to an absolute point. */
async function dragChipTo(
  page: Page,
  chip: Locator,
  target: { x: number; y: number },
): Promise<void> {
  const chipBox = await chip.boundingBox();
  expect(chipBox).not.toBeNull();
  if (!chipBox) throw new Error("Dragged chip has no bounding box");

  await page.mouse.move(chipBox.x + chipBox.width / 2, chipBox.y + chipBox.height / 2);
  await page.mouse.down();
  // Exceed the 8px PointerSensor activation distance before heading to the target.
  await page.mouse.move(chipBox.x + chipBox.width / 2 + 12, chipBox.y + chipBox.height / 2 + 4);
  await page.mouse.move(target.x, target.y, { steps: 20 });
  await page.mouse.up();
}

// Retired 2026-10-24: Files and Changes became supporting cards beside the conversation
// (60f4899a6, 2e2921f79, 73be0edc5), so the Explorer no longer opens as a tab dock whose tab row
// receives agents. explorer-sidebar.spec.ts covered the same tab dock and was retired with it.

async function closeOnlyDraft(page: Page): Promise<void> {
  await draftTabChip(page).hover();
  await page.getByRole("button", { name: "Close", exact: true }).click();
}

async function moveOnlyDraftIntoRightSplit(page: Page): Promise<void> {
  // The primary pane's menu holds Split right beside the workspace actions (195e1c044).
  await page.getByTestId("workspace-split-pane-menu").filter({ visible: true }).first().click();
  await page.getByTestId("workspace-split-pane-right").click();
  const target = await emptyPaneBox(page);
  await dragChipTo(page, draftTabChip(page), {
    x: target.x + target.width / 2,
    y: target.y + target.height / 2,
  });
  await expect(mainTabRow(page)).toHaveCount(1);
}

async function expectNewLauncher(page: Page): Promise<void> {
  await expect(
    page.getByTestId("workspace-new-tab-panel").getByRole("button", { name: "Agent", exact: true }),
  ).toBeVisible();
  await expect(draftTabChip(page)).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Message agent..." })).toHaveCount(0);
  await expect(page.getByText("Vorteo ran into a problem.", { exact: true })).toHaveCount(0);
}

async function openAgentDraftFromLauncher(page: Page): Promise<void> {
  await expectNewLauncher(page);
  await page
    .getByTestId("workspace-new-tab-panel")
    .getByRole("button", { name: "Agent", exact: true })
    .click();
  await expect(page.getByRole("textbox", { name: "Message agent..." })).toBeVisible();
}

// Explorer cannot replace the ordinary workspace canvas, including on restore.
test("closing the last split-born tab with hidden Explorer keeps a usable workspace", async ({
  page,
  withWorkspace,
}) => {
  const workspace = await withWorkspace({ prefix: "last-pane-hidden-explorer-" });
  await gotoWorkspace(page, workspace.workspaceId);
  await openAgentDraftFromLauncher(page);
  await closeOnlyDraft(page);
  await expectNewLauncher(page);
  await openAgentDraftFromLauncher(page);
  await moveOnlyDraftIntoRightSplit(page);
  await closeOnlyDraft(page);
  await expectNewLauncher(page);
  await page.reload();
  await expectNewLauncher(page);
});

test("visible Explorer does not replace the last ordinary workspace pane", async ({
  page,
  withWorkspace,
}) => {
  const workspace = await withWorkspace({ prefix: "last-pane-visible-explorer-" });
  await gotoWorkspace(page, workspace.workspaceId);
  await page.getByRole("button", { name: "Open Explorer sidebar", exact: true }).click();
  await openAgentDraftFromLauncher(page);
  await moveOnlyDraftIntoRightSplit(page);
  await closeOnlyDraft(page);
  await expectNewLauncher(page);
  await page.reload();
  await expectNewLauncher(page);
});

// A saved layout with a hidden Explorer and 2,250 empty drafts froze the page on reload until
// 9711e1710 dropped empty Explorer drafts during restore.
test("reloading a saved hidden generated Explorer recovers a usable workspace", async ({
  page,
  withWorkspace,
}) => {
  const otherWorkspace = await withWorkspace({ prefix: "uncorrupted-explorer-" });
  await gotoWorkspace(page, otherWorkspace.workspaceId);
  await openAgentDraftFromLauncher(page);

  const workspace = await withWorkspace({ prefix: "saved-hidden-explorer-" });
  await gotoWorkspace(page, workspace.workspaceId);
  await expectNewLauncher(page);
  await seedCorruptedWorkspaceLayout(page, workspace.workspaceId);
  await page.reload();
  await expectNewLauncher(page);
  await gotoWorkspace(page, otherWorkspace.workspaceId);
  await expect(draftTabChip(page)).toHaveCount(1);
});
