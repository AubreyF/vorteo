import { expect, test } from "../support/fixtures";

test("persists demo edits across reload, updates Changes live and resets only demo data", async ({
  page,
}, info) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1800, height: 1000 });
  await page.goto("/?demo=1");
  await page.evaluate(() => sessionStorage.setItem("demo-persistence-control", "untouched"));
  await page.getByTestId("sidebar-workspace-row-vorteo-demo:demo-workspace-0-1").click();
  const mac = await page.evaluate(() => /Mac/.test(navigator.platform));
  await page.keyboard.press(mac ? "Meta+Shift+E" : "Control+Shift+E");
  const files = page.getByTestId("supporting-card-files");
  await files.getByText("README.md", { exact: true }).click();
  await page.keyboard.press(mac ? "Meta+Shift+G" : "Control+Shift+G");
  const pane = page.getByTestId("workspace-file-pane").filter({ visible: true });
  await pane.getByRole("button", { name: "Source", exact: true }).click();
  const editor = pane.locator(".cm-content");
  await expect(editor).toBeVisible();
  await editor.fill("# Atlas\n\nSimulated editor verification.\n");
  await page.keyboard.press(mac ? "Meta+s" : "Control+s");
  await pane.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(pane.getByText("Simulated editor verification.", { exact: true })).toBeVisible();
  await expect(
    page.getByTestId("supporting-card-changes_tree").getByText("README.md", { exact: true }),
  ).toBeVisible();
  await files.getByText("package.json", { exact: true }).click();
  await files.getByText("README.md", { exact: true }).click();
  await expect(pane.getByText("Simulated editor verification.", { exact: true })).toBeVisible();
  await page.reload();
  await expect(pane.getByText("Simulated editor verification.", { exact: true })).toBeVisible();
  await expect
    .poll(
      async () =>
        (await files.getByRole("button", { name: "Files", exact: true }).boundingBox())?.height ??
        0,
    )
    .toBeGreaterThanOrEqual(32);
  await page.screenshot({ path: info.outputPath("saved-demo-file.png"), fullPage: true });
  await page.getByTestId("demo-reset").click();
  await page.getByTestId("sidebar-workspace-row-vorteo-demo:demo-workspace-0-1").click();
  await page.keyboard.press(mac ? "Meta+Shift+E" : "Control+Shift+E");
  await files.getByText("README.md", { exact: true }).click();
  await expect(
    pane.getByText("This workspace contains simulated data only.", { exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem("demo-persistence-control"))).toBe(
    "untouched",
  );
  expect(await page.evaluate(() => sessionStorage.getItem("vorteo:demo:files:v1"))).toBeNull();
});
