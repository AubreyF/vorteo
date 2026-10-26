import { expect, test, type Page } from "../support/fixtures";
import { expectComposerVisible } from "../support/helpers/composer";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { installProviderUsageFixture } from "../support/helpers/provider-usage";
import { closeContextWindowSheet, contextWindowSheet } from "../support/helpers/context-window";

const MOBILE_VIEWPORT = { width: 390, height: 844 };

async function openMockAgent(page: Page) {
  await page.setViewportSize(MOBILE_VIEWPORT);
  const session = await seedMockAgentWorkspace({
    repoPrefix: "provider-usage-tooltip-",
    title: "Provider usage tooltip e2e",
    initialPrompt: "emit 1 coalesced agent stream update for provider usage tooltip.",
  });
  await openAgentRoute(page, session);
  await expectComposerVisible(page);
  await expect(page.getByTestId("context-window-meter")).toBeVisible({ timeout: 30_000 });
  return session;
}

test.use({ vortonMode: true });

test.describe("provider usage tooltip", () => {
  test("fetches usage when the context tooltip opens and renders the active provider", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const usageFixture = await installProviderUsageFixture(page, [
      {
        fetchedAt: "2026-06-19T00:00:00.000Z",
        providers: [
          {
            providerId: "mock",
            displayName: "Mock provider",
            status: "available",
            planLabel: "Test plan",
            windows: [
              {
                id: "session",
                label: "Session",
                usedPct: 42,
                remainingPct: 58,
                resetsAt: "2026-06-19T05:00:00.000Z",
              },
            ],
          },
        ],
      },
    ]);
    const session = await openMockAgent(page);
    try {
      // Vorteo loads account usage for the profile control before opening the meter.
      expect(usageFixture.requestCount()).toBe(1);

      await page.getByTestId("context-window-meter").click();
      await usageFixture.waitForRequestCount(2);

      // The sidebar's Quota card (b7e249fef) also names the account, so read the meter's sheet.
      const sheet = contextWindowSheet(page);
      await expect(sheet.getByText("Mock provider", { exact: true })).toBeVisible({
        timeout: 10_000,
      });
      await expect(sheet.getByText("Test plan")).toBeVisible();
      await expect(sheet.getByText("Session", { exact: true })).toBeVisible();
      await expect(sheet.getByText("42%")).toBeVisible();
    } finally {
      await session.cleanup();
    }
  });

  test("refreshes usage again each time the tooltip is shown", async ({ page }) => {
    test.setTimeout(180_000);
    const usageFixture = await installProviderUsageFixture(page, [
      {
        fetchedAt: "2026-06-19T00:00:00.000Z",
        providers: [
          {
            providerId: "mock",
            displayName: "Mock provider",
            status: "available",
            planLabel: "Test plan",
            windows: [{ id: "session", label: "Session", usedPct: 41 }],
          },
        ],
      },
      {
        fetchedAt: "2026-06-19T00:00:00.000Z",
        providers: [
          {
            providerId: "mock",
            displayName: "Mock provider",
            status: "available",
            planLabel: "Test plan",
            windows: [{ id: "session", label: "Session", usedPct: 41 }],
          },
        ],
      },
      {
        fetchedAt: "2026-06-19T00:01:00.000Z",
        providers: [
          {
            providerId: "mock",
            displayName: "Mock provider",
            status: "available",
            planLabel: "Test plan",
            windows: [{ id: "session", label: "Session", usedPct: 64 }],
          },
        ],
      },
    ]);
    const session = await openMockAgent(page);
    try {
      const meter = page.getByTestId("context-window-meter");

      // The sidebar's Quota card (b7e249fef) also shows usage, so read the meter's sheet.
      const sheet = contextWindowSheet(page);
      await meter.click();
      await usageFixture.waitForRequestCount(2);
      await expect(sheet.getByText("41%")).toBeVisible({ timeout: 10_000 });

      await closeContextWindowSheet(page);
      await expect(sheet).toHaveCount(0);

      await meter.click();
      await usageFixture.waitForRequestCount(3);
      expect(usageFixture.requestCount()).toBe(3);
      await expect(sheet.getByText("64%")).toBeVisible();
    } finally {
      await session.cleanup();
    }
  });
});
