import { expect, test } from "../support/fixtures";

const API = "https://api.github.com/repos/AubreyF/paseo";
const latestCommit = "b".repeat(40);

test("Vorteo checks main and requires a connected installation host before preparing an update", async ({
  page,
}) => {
  let requests = 0;
  await page.route(`${API}/**`, async (route) => {
    requests += 1;
    const body = route.request().url().includes("/commits/")
      ? { sha: latestCommit }
      : { status: "ahead", ahead_by: 3 };
    await route.fulfill({ json: body });
  });
  await page.addInitScript(() => {
    const key = "@paseo:create-agent-preferences";
    const preferences = JSON.parse(localStorage.getItem(key) ?? "{}");
    localStorage.setItem(key, JSON.stringify({ ...preferences, vortonMode: false }));
    localStorage.setItem(
      "paseo-drafts",
      JSON.stringify({
        version: 5,
        state: {
          drafts: {
            "new-workspace": {
              input: { text: "Keep my existing draft", attachments: [] },
              lifecycle: "active",
              updatedAt: Date.now(),
              version: 1,
            },
          },
          createModalDraft: null,
        },
      }),
    );
  });
  await page.goto("/settings/about");
  await expect(page.getByText("This device", { exact: true })).toBeVisible();
  // A saved legacy false value no longer disables the Vorteo interface.
  await expect(page.getByTestId("vorton-updates-section")).toHaveCount(1);
  await expect(page.getByTestId("settings-vorton-mode")).toHaveCount(0);
  await expect(page.getByTestId("settings-sidebar-version")).toHaveCount(1);
  await page.getByTestId("settings-sidebar-version").click();
  await expect(page).toHaveURL(/\/settings\/general$/);
  await expect(page.getByTestId("vorton-update-status")).toHaveText(
    "3 new commits are available on main.",
  );
  expect(requests).toBeGreaterThan(0);
  await page.getByTestId("vorton-help-update").click();
  await expect(
    page.getByText("Connect this installation's host environment before preparing an update task."),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/settings\/general$/);
  const oldDraft = await page.evaluate(
    () =>
      JSON.parse(localStorage.getItem("paseo-drafts") ?? "{}").state.drafts["new-workspace"].input
        .text,
  );
  expect(oldDraft).toBe("Keep my existing draft");
});

test("a failed update check exposes a retry and recovers", async ({ page }) => {
  let fail = true;
  await page.addInitScript(() => {
    const key = "@paseo:create-agent-preferences";
    localStorage.setItem(
      key,
      JSON.stringify({ ...JSON.parse(localStorage.getItem(key) ?? "{}"), vortonMode: true }),
    );
  });
  await page.route(`${API}/**`, async (route) => {
    if (fail) {
      await route.fulfill({ status: 403, json: { message: "Rate limit exceeded" } });
      return;
    }
    await route.fulfill({
      json: route.request().url().includes("/commits/")
        ? { sha: latestCommit }
        : { status: "behind", ahead_by: 0 },
    });
  });
  await page.goto("/settings/about");
  await expect(page.getByTestId("vorton-update-status")).toContainText(
    "GitHub limited update checks",
  );
  fail = false;
  await page.getByTestId("vorton-check-update").click();
  await expect(page.getByTestId("vorton-update-status")).toHaveText(
    "This interface was built ahead of main.",
  );
});

test("manual checks show lasting feedback and the version footer starts a fresh check", async ({
  page,
}) => {
  let requests = 0;
  await page.addInitScript(() => {
    const key = "@paseo:create-agent-preferences";
    localStorage.setItem(
      key,
      JSON.stringify({ ...JSON.parse(localStorage.getItem(key) ?? "{}"), vortonMode: true }),
    );
  });
  await page.route(`${API}/**`, async (route) => {
    requests += 1;
    await route.fulfill({
      json: route.request().url().includes("/commits/")
        ? { sha: latestCommit }
        : { status: "identical", ahead_by: 0 },
    });
  });
  await page.goto("/settings/about");
  await expect(page.getByTestId("vorton-update-status")).toHaveText(
    "This interface is up to date with main.",
  );
  const button = page.getByTestId("vorton-check-update");
  const instructions = page.getByTestId("vorton-update-instructions");
  const feedbackArea = page.getByTestId("vorton-update-feedback-area");
  const helpButton = page.getByTestId("vorton-help-update");
  await page.getByTestId("vorton-updates-section").scrollIntoViewIfNeeded();
  const originalArea = await feedbackArea.boundingBox();
  const originalButton = await helpButton.boundingBox();
  await button.click();
  await expect(button).toBeDisabled();
  await expect(button).toHaveText("Checking GitHub...");
  await expect(page.getByTestId("vorton-check-success")).toHaveText("You're up to date");
  await expect(button).toBeEnabled();
  await expect(instructions).toHaveCSS("opacity", "0");
  expect(await feedbackArea.boundingBox()).toEqual(originalArea);
  expect(await helpButton.boundingBox()).toEqual(originalButton);
  await expect(page.getByTestId("vorton-check-success")).toHaveCount(0);
  await expect(instructions).toHaveCSS("opacity", "1");
  expect(await feedbackArea.boundingBox()).toEqual(originalArea);
  await page.getByTestId("settings-sidebar").getByText("General", { exact: true }).click();
  const before = requests;
  await page.getByTestId("settings-sidebar-version").click();
  await expect(page).toHaveURL(/\/settings\/general$/);
  await expect.poll(() => requests).toBeGreaterThan(before);
  await expect(page.getByTestId("vorton-check-success")).toHaveText("You're up to date");
});
