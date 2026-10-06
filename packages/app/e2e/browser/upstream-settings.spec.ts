import { expect, test } from "../support/fixtures";
import record from "../../src/vorton-updates/upstream-sync.json";
import { UPSTREAM_UPDATE_PROMPT } from "../../src/vorton-updates/upstream";

const week = 7 * 24 * 60 * 60 * 1000;
const mergedAt = Date.parse(record.mergedAt);

for (const width of [1280, 390]) {
  test(`General contains About and a copyable overdue upstream task at ${width}px`, async ({
    page,
    context,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.clock.setFixedTime(new Date(mergedAt + week + 1));
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.addInitScript(() => {
      const key = "@paseo:create-agent-preferences";
      localStorage.setItem(
        key,
        JSON.stringify({ ...JSON.parse(localStorage.getItem(key) ?? "{}"), vortonMode: true }),
      );
    });
    await page.goto("/settings/about");
    await expect(page).toHaveURL(/\/settings\/general$/);
    await expect(page.getByText("Default send", { exact: true })).toBeVisible();
    const section = page.getByTestId("upstream-updates-section");
    await section.scrollIntoViewIfNeeded();
    await expect(page.getByTestId("upstream-merge-date")).toHaveText(
      `Last upstream merge: ${new Date(record.mergedAt).toLocaleDateString("en", { year: "numeric", month: "long", day: "numeric" })}`,
    );
    await expect(page.getByTestId("upstream-update-overdue")).toBeVisible();
    await expect(page.getByText("This device", { exact: true })).toHaveCount(1);
    await page.getByTestId("copy-upstream-prompt").click();
    await expect(
      section.getByText("Prompt copied. Paste it into an agent session on your host."),
    ).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(UPSTREAM_UPDATE_PROMPT);
    await page.getByTestId("toggle-upstream-prompt").click();
    await expect(page.getByTestId("upstream-host-prompt")).toHaveText(UPSTREAM_UPDATE_PROMPT);
    await page.getByTestId("toggle-upstream-prompt").click();
    await expect(page.getByTestId("upstream-host-prompt")).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("general-upstream.png") });
  });
}

test("the weekly highlight expires while General is open without an alternate product switch", async ({
  page,
}) => {
  await page.clock.install({ time: new Date(mergedAt + week - 60_000) });
  await page.addInitScript(() => {
    const key = "@paseo:create-agent-preferences";
    localStorage.setItem(
      key,
      JSON.stringify({ ...JSON.parse(localStorage.getItem(key) ?? "{}"), vortonMode: true }),
    );
  });
  await page.goto("/settings/general");
  await expect(page.getByTestId("upstream-updates-section")).toHaveCount(1);
  await expect(page.getByTestId("upstream-update-overdue")).toHaveCount(0);
  await page.clock.fastForward(120_000);
  await expect(page.getByTestId("upstream-update-overdue")).toHaveCount(1);
  await expect(page.getByTestId("settings-vorton-mode")).toHaveCount(0);
  await expect(page.getByTestId("upstream-updates-section")).toHaveCount(1);
  await expect(page.getByTestId("vorton-updates-section")).toHaveCount(1);
  await expect(page.getByText("This device", { exact: true })).toHaveCount(1);
  await expect(
    page.getByTestId("settings-sidebar").getByRole("button", { name: "About", exact: true }),
  ).toHaveCount(0);
});
