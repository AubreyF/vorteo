import path from "node:path";
import { expect, test, type Page } from "../support/fixtures";
import {
  draftAgentProfile,
  draftModel,
  openAgentProfileSettings,
} from "../support/helpers/agent-profiles";

// This fixture catalog advertises Ultrafast on Sol; another model offers Fast only.
// The real daemon discovers both through the same Codex model/list boundary.
test.use({
  e2eDaemonConfig: {
    version: 1,
    agents: {
      providers: {
        codex: {
          enabled: true,
          command: [process.execPath, path.resolve("e2e/fixtures/catalog-codex.mjs")],
        },
        claude: { enabled: false },
        copilot: { enabled: false },
        opencode: { enabled: false },
        pi: { enabled: false },
        omp: { enabled: false },
      },
    },
  },
});

// The composer's speed control went with the Paseo mode in 471d7f22a; profiles carry speed, so
// the Codex catalog's tiers are checked in the profile editor's Speed feature.
const SPEED = "service_tier";

/** A speed choice: a row in the desktop list, or a button in the phone sheet. */
function speedOption(page: Page, label: string) {
  return page
    .locator(`[data-testid^="agent-profile-feature-option-${SPEED}-"]`)
    .filter({ hasText: new RegExp(`^${label}`) })
    .or(page.getByRole("button", { name: label, exact: true }))
    .filter({ visible: true })
    .last();
}

function speedTrigger(page: Page) {
  return page.getByTestId(`agent-profile-feature-trigger-${SPEED}`);
}

async function openSpeedChoices(page: Page): Promise<void> {
  await speedTrigger(page).click();
  await expect(page.getByText("Normal", { exact: true }).last()).toBeVisible();
}

async function expectSpeedChoices(page: Page, choices: string[]): Promise<void> {
  for (const choice of ["Normal", "Fast", "Ultrafast"]) {
    const option = speedOption(page, choice);
    if (choices.includes(choice)) {
      // The list can open low in the editor and scroll; each choice must be reachable.
      await option.scrollIntoViewIfNeeded();
      await expect(option).toBeInViewport();
    } else
      await expect(
        page
          .locator(`[data-testid^="agent-profile-feature-option-${SPEED}-"]`)
          .or(page.getByRole("button", { name: choice, exact: true }))
          .filter({ visible: true })
          .filter({ hasText: new RegExp(`^${choice}`) }),
      ).toHaveCount(0);
  }
}

async function selectSpeed(page: Page, label: string): Promise<void> {
  await speedOption(page, label).click();
  await expect(speedTrigger(page)).toContainText(label);
}

for (const viewport of [
  { name: "desktop", width: 1280, height: 850 },
  { name: "compact", width: 390, height: 844 },
]) {
  test(`Codex catalog drives speed choices on ${viewport.name}`, async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    // Settings opens from the desktop sidebar; the editor is then checked at this width.
    await openAgentProfileSettings(page);
    await page.setViewportSize(viewport);
    await draftAgentProfile(page, {
      name: "Speed settings",
      provider: "Codex",
      model: "GPT-6.1 Sol",
    });
    await expect(speedTrigger(page)).toContainText("Normal", { timeout: 30_000 });

    await openSpeedChoices(page);
    await expectSpeedChoices(page, ["Normal", "Fast", "Ultrafast"]);
    await page.screenshot({ path: testInfo.outputPath(`${viewport.name}-speed-options.png`) });
    await selectSpeed(page, "Ultrafast");
    await page.screenshot({ path: testInfo.outputPath(`${viewport.name}-ultrafast-selected.png`) });

    await openSpeedChoices(page);
    await selectSpeed(page, "Normal");
    // A model without Ultrafast offers only Normal and Fast.
    await draftModel(page, "GPT-6 Sol");
    await openSpeedChoices(page);
    await expectSpeedChoices(page, ["Normal", "Fast"]);
    await page.screenshot({ path: testInfo.outputPath(`${viewport.name}-fast-only.png`) });
  });
}
