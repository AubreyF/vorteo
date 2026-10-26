import { expect, test } from "../support/fixtures";

for (const width of [1800, 390]) {
  test(`demo task edits persist and reset at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/?demo=1");
    if (width === 390) await page.getByTestId("menu-button").click();
    const workspace = page.getByTestId("sidebar-workspace-row-vorteo-demo:demo-workspace-0-1");
    await workspace.click();
    await page
      .getByRole("checkbox", { name: "Complete Approve release copy", exact: true })
      .click();
    await expect(
      page.getByRole("checkbox", { name: "Reopen Approve release copy", exact: true }),
    ).toBeChecked();
    if (width === 1800)
      await expect(workspace.getByRole("progressbar")).toHaveAttribute("aria-label", /3\/4 tasks/);
    await page
      .getByRole("button", { name: "Details for Approve release copy", exact: true })
      .click();
    await page.getByTestId("checklist-title").fill("Approve simulated release copy");
    await page.getByRole("button", { name: "Save task", exact: true }).click();
    await expect(
      page.getByRole("checkbox", { name: "Reopen Approve simulated release copy", exact: true }),
    ).toBeVisible();
    await page.reload();
    await expect(
      page.getByRole("checkbox", { name: "Reopen Approve simulated release copy", exact: true }),
    ).toBeChecked();
    if (width === 1800)
      await expect(workspace.getByRole("progressbar")).toHaveAttribute("aria-label", /3\/4 tasks/);
    // 2cf5e0cbb made desktop card rows 32px tall to match the sidebar.
    await expect
      .poll(
        async () =>
          (await page.getByTestId("checklist-row-demo-task-1-4").boundingBox())?.height ?? 0,
      )
      .toBeGreaterThanOrEqual(width === 1800 ? 31.9 : 39.9);
    await page.screenshot({ path: info.outputPath("demo-checklist.png"), fullPage: true });
    if (width === 390) await page.getByTestId("menu-button").click();
    await page.getByTestId("demo-reset").click();
    if (width === 390) await page.getByTestId("menu-button").click();
    await page.getByTestId("sidebar-workspace-row-vorteo-demo:demo-workspace-0-1").click();
    await expect(
      page.getByRole("checkbox", { name: "Complete Approve release copy", exact: true }),
    ).toBeVisible();
  });
}

test.describe("compact theme surfaces", () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });
  for (const theme of [
    "starship-light",
    "starship-dark",
    "scriptorium",
    "midas",
    "ember",
    "neon",
  ]) {
    test(`task sheets and file cards stay usable in ${theme}`, async ({ page }, info) => {
      await page.goto("/?demo=1");
      await page.getByTestId("menu-button").click();
      await page.getByTestId("sidebar-footer-overflow").click();
      await page.getByTestId(`theme-preview-${theme}`).click();
      const backdrop = page.getByRole("button", { name: "Menu backdrop", exact: true });
      if (await backdrop.isVisible()) await backdrop.click({ position: { x: 5, y: 800 } });
      await expect(page.locator("html")).toHaveAttribute("data-vorteo-appearance", theme);
      await page.getByTestId("sidebar-workspace-row-vorteo-demo:demo-workspace-0-1").click();
      await page
        .getByRole("button", { name: "Details for Approve release copy", exact: true })
        .click();
      const title = page.getByTestId("checklist-title");
      await title.fill("");
      await expect(page.getByTestId("checklist-save")).toBeDisabled();
      await title.fill("Review compact theme");
      await page.getByRole("button", { name: "Review", exact: true }).click();
      const save = page.getByTestId("checklist-save");
      await save.scrollIntoViewIfNeeded();
      expect((await save.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
      await page.screenshot({ path: info.outputPath(`${theme}-task-sheet.png`) });
      await save.click();
      await expect(page.getByTestId("checklist-editor")).toBeHidden();
      await expect(page.getByText("Review compact theme", { exact: true })).toBeVisible();
      // Phones show Files inline in the conversation since 56b01ba3a.
      const files = page.getByTestId("supporting-card-files").filter({ visible: true });
      await files.scrollIntoViewIfNeeded();
      await expect(files).toBeVisible();
      const disclosure = files.getByTestId("supporting-card-files-toggle");
      if ((await disclosure.getAttribute("aria-expanded")) !== "true") await disclosure.click();
      await files.getByText("README.md", { exact: true }).click();
      await expect(page.getByTestId("explorer-close")).toBeHidden();
      const pane = page.getByTestId("workspace-file-pane").filter({ visible: true });
      await expect(
        pane.getByText("This workspace contains simulated data only.", { exact: true }),
      ).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
      await page.screenshot({ path: info.outputPath(`${theme}-compact-file.png`) });
    });
  }
});
