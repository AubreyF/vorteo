import { expect, test } from "../support/fixtures";

test("demo composer replies without model access and retains messages across reload", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1800, height: 1000 });
  await page.goto("/?demo=1");
  await page.getByTestId("sidebar-workspace-row-vorteo-demo:demo-workspace-0-1").click();
  const composer = page.getByRole("textbox", { name: "Message agent..." });
  await composer.fill("Which sample tasks remain for this release?");
  await composer.press("Enter");
  await expect(page.getByText("Simulated reply", { exact: true })).toBeVisible();
  await expect(page.getByText("Approve release copy (pending)", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Which sample tasks remain for this release?", { exact: true }),
  ).toHaveCount(1);
  await page.reload();
  await expect(page.getByText("Simulated reply", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Which sample tasks remain for this release?", { exact: true }),
  ).toHaveCount(1);
  await page.screenshot({ path: info.outputPath("demo-conversation.png"), fullPage: true });
  await page.getByTestId("demo-reset").click();
  await page.getByTestId("sidebar-workspace-row-vorteo-demo:demo-workspace-0-1").click();
  await expect(page.getByText("Simulated reply", { exact: true })).toHaveCount(0);
});
