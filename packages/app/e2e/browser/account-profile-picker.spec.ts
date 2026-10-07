import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";
import { daemonWsRoutePattern } from "../support/helpers/daemon-port";
import { seedWorkspace } from "../support/helpers/seed-client";
import { waitForSettledPosition } from "../support/helpers/sheet-layout";
import { expect, test } from "../support/fixtures";
import { seedAgentProfiles } from "../support/helpers/agent-profiles";
import { expectComposerVisible } from "../support/helpers/composer";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";

const medium = {
  id: "account-medium",
  name: "Astra Medium",
  provider: "mock",
  model: "ten-second-stream",
  modeId: "load-test",
  instructions: "Review the project instructions before making changes.\n".repeat(40),
};
const ultra = { ...medium, id: "account-ultra", name: "Astra Ultra", modeId: "approval-test" };

test("profile cards use border selection, a separate activation action, and compact sections", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const seed = await seedAgentProfiles([medium, ultra], true);
  const workspace = await seedMockAgentWorkspace({
    repoPrefix: "account-picker-",
    title: "Account picker",
    model: "e2e-fast-stream",
    initialPrompt: "Remember the profile picker acceptance task.",
  });
  try {
    await workspace.client.waitForAgentUpsert(
      workspace.agentId,
      (agent) => agent.status === "idle",
      15_000,
    );
    await openAgentRoute(page, workspace);
    await expectComposerVisible(page);

    await expect(page.getByTestId("agent-preset-selector")).toContainText("Choose profile");
    await page.getByTestId("agent-preset-selector").click();
    await expect(
      page.getByTestId("account-preset-menu").getByText("Choose profile", { exact: true }),
    ).toBeVisible();
    await expect(page.getByTestId("preset-environment-card")).toBeVisible();
    await expect(page.getByTestId("preset-account-mock")).toHaveCount(1);
    await expect(page.getByTestId("preset-reveal-account-mock")).toHaveCSS("opacity", "1");
    const environmentTile = page
      .locator('[data-testid^="preset-environment-"][role="button"]')
      .first();
    const environmentBounds = await environmentTile.boundingBox();
    const accountBounds = await page.getByTestId("preset-account-mock").boundingBox();
    expect(environmentBounds!.height).toBe(accountBounds!.height);
    const accountRadius = await page
      .getByTestId("preset-account-mock")
      .evaluate((element) => getComputedStyle(element).borderRadius);
    expect(accountRadius).not.toBe("0px");
    await expect(environmentTile).toHaveCSS("border-radius", accountRadius);
    await expect(page.getByTestId("shared-model-trigger")).toHaveCount(0);
    await expect(page.getByTestId("shared-thinking-trigger")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Connect", exact: true })).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "Search accounts" })).toHaveCount(0);
    await expect(page.getByTestId("preset-use-profile")).toHaveCount(0);
    await page.getByTestId("preset-row-shared-profile/mock/account-ultra").click();
    await expect(page.getByTestId("profile-customization-details")).toContainText("Approval Test");
    await expect(page.getByTestId("preset-use-profile")).toBeEnabled();
    const chosenProfile = page.getByTestId("preset-row-shared-profile/mock/account-ultra");
    await expect(chosenProfile).toHaveCSS("border-radius", accountRadius);
    await expect(chosenProfile).not.toHaveCSS("border-left-color", "rgba(0, 0, 0, 0)");
    await expect(chosenProfile.locator("svg")).toHaveCount(0);
    for (const tile of [
      environmentTile,
      page.getByTestId("preset-account-mock"),
      chosenProfile,
      page.getByTestId("preset-row-shared-profile/mock/account-medium"),
    ]) {
      await page.mouse.move(0, 0);
      const restColor = await tile.evaluate((element) => getComputedStyle(element).backgroundColor);
      const restBounds = await tile.boundingBox();
      await tile.hover();
      await expect(tile).not.toHaveCSS("background-color", restColor);
      expect(await tile.boundingBox()).toEqual(restBounds);
      await page.mouse.move(0, 0);
      await expect(tile).toHaveCSS("background-color", restColor);
    }

    await expect(page.getByTestId("preset-use-profile")).toHaveText("Activate Profile");
    await waitForSettledPosition(page.getByTestId("preset-use-profile"));
    const firstProfile = await page
      .getByTestId("preset-row-shared-profile/mock/account-medium")
      .boundingBox();
    const secondProfile = await chosenProfile.boundingBox();
    expect(secondProfile!.height).toBe(accountBounds!.height);
    expect(secondProfile!.y).toBe(firstProfile!.y);
    expect(secondProfile!.x).toBeGreaterThan(firstProfile!.x);
    const card = await page.getByTestId("preset-profile-card").boundingBox();
    const action = await page.getByTestId("preset-use-profile").boundingBox();
    expect(action!.y).toBeGreaterThanOrEqual(card!.y + card!.height);
    const profileScroll = page.getByTestId("preset-profile-scroll");
    await profileScroll.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect
      .poll(() => profileScroll.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);
    expect((await page.getByTestId("preset-use-profile").boundingBox())!.y).toBe(action!.y);
    await profileScroll.evaluate((element) => {
      element.scrollTop = 0;
    });

    await expect(page.getByTestId("preset-search-toggle")).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath("profile-cards-desktop.png") });
    await page.getByTestId("preset-manage-profiles").click();
    await expect(page.getByTestId("provider-settings-sheet")).toBeVisible();
    await expect(page.getByTestId("agent-profile-row-account-medium")).toBeVisible();
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByTestId("agent-preset-selector").click();
    await expect(page.getByTestId("preset-manage-profiles")).toHaveCount(0);
    await expect(page.getByTestId("preset-section-environment")).toBeVisible();
    await expect(page.getByTestId("preset-section-account")).toBeVisible();
    await expect(page.getByTestId("preset-choices-mock")).toBeVisible();
    await page.getByTestId("preset-section-account").click();
    await expect(page.getByTestId("preset-choices-mock")).toHaveCount(0);
    await expect(page.getByTestId("preset-account-mock")).toBeVisible();
    await page.getByTestId("preset-account-mock").click();
    await expect(page.getByTestId("preset-choices-mock")).toBeVisible();
    await page.getByTestId("preset-row-shared-profile/mock/account-ultra").click();
    await page.getByTestId("preset-section-environment").click();
    await expect(page.getByTestId("preset-choices-mock")).toHaveCount(0);
    await page.getByTestId("preset-section-profile").click();
    await expect(page.getByTestId("profile-customization-details")).toContainText("Approval Test");
    await expect(page.getByTestId("preset-search-toggle")).toHaveCount(0);
    await waitForSettledPosition(page.getByTestId("account-preset-menu"));
    await expect(page.getByTestId("preset-use-profile")).toBeInViewport();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    const labelEdges: number[] = [];
    for (const [section, label] of [
      ["environment", "Environment:"],
      ["account", "Account:"],
      ["profile", "Profile:"],
    ]) {
      const heading = page.getByTestId(`preset-section-${section}`);
      await expect(heading.getByText(label, { exact: true })).toBeVisible();
      const bounds = await heading.getByText(label, { exact: true }).boundingBox();
      labelEdges.push(bounds!.x + bounds!.width);
    }
    expect(Math.max(...labelEdges) - Math.min(...labelEdges)).toBeLessThan(1);
    const mobileFirst = page.getByTestId("preset-row-shared-profile/mock/account-medium");
    const mobileSecond = page.getByTestId("preset-row-shared-profile/mock/account-ultra");
    await expect
      .poll(async () =>
        Math.abs((await mobileFirst.boundingBox())!.y - (await mobileSecond.boundingBox())!.y),
      )
      .toBeLessThan(1);
    await page.screenshot({ path: test.info().outputPath("profile-cards-mobile.png") });
    await page.setViewportSize({ width: 320, height: 844 });
    await expect
      .poll(
        async () => (await mobileSecond.boundingBox())!.y - (await mobileFirst.boundingBox())!.y,
      )
      .toBeGreaterThan(60);
    await page.screenshot({ path: test.info().outputPath("profile-cards-narrow.png") });
    await page.getByTestId("preset-use-profile").click();
    await expect(page.getByTestId("preset-handoff-modal")).toBeVisible();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.setViewportSize({ width: 1280, height: 720 });
    await expect(page.getByTestId("agent-preset-selector")).toBeVisible();
  } finally {
    await workspace.cleanup();
    await seed.restore();
  }
});

test("active profile hides the action until a different profile is selected", async ({ page }) => {
  test.setTimeout(120_000);
  const seed = await seedAgentProfiles([medium, ultra], true);
  const workspace = await seedWorkspace({ repoPrefix: "active-profile-picker-" });
  try {
    const agent = await workspace.client.createAgent({
      provider: "mock",
      cwd: workspace.repoPath,
      workspaceId: workspace.workspaceId,
      profileId: "shared-workflow/mock/account-medium",
    });
    await openAgentRoute(page, { ...workspace, agentId: agent.id });
    await expectComposerVisible(page);
    await expect(page.getByTestId("agent-preset-selector")).toContainText("Astra Medium");
    await page.getByTestId("agent-preset-selector").click();
    await expect(page.getByTestId("preset-row-shared-profile/mock/account-medium")).toBeVisible();
    await expect(page.getByTestId("preset-use-profile")).toHaveCount(0);
    await expect(page.getByTestId("preset-action-area")).toHaveCSS("height", "0px");
    const originalCard = await page.getByTestId("preset-profile-card").boundingBox();
    await page.screenshot({ path: test.info().outputPath("profile-active-no-action.png") });
    await page.getByTestId("preset-row-shared-profile/mock/account-ultra").click();
    await expect(page.getByTestId("preset-use-profile")).toHaveText("Switch to Profile");
    await waitForSettledPosition(page.getByTestId("preset-use-profile"));
    expect((await page.getByTestId("preset-profile-card").boundingBox())!.height).toBeLessThan(
      originalCard!.height,
    );
    await page.getByTestId("preset-row-shared-profile/mock/account-medium").click();
    await expect(page.getByTestId("preset-use-profile")).toHaveCount(0);
    await expect(page.getByTestId("preset-action-area")).toHaveCSS("height", "0px");
    expect((await page.getByTestId("preset-profile-card").boundingBox())!.height).toBe(
      originalCard!.height,
    );
  } finally {
    await workspace.cleanup();
    await seed.restore();
  }
});

test("chooser opens while usage is pending and refreshes within the account tile", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const seed = await seedAgentProfiles([medium, ultra], true);
  const workspace = await seedMockAgentWorkspace({
    repoPrefix: "instant-picker-",
    title: "Instant picker",
    model: "e2e-fast-stream",
    initialPrompt: "Remember the instant picker test.",
  });
  const pending: Array<() => void> = [];
  let hold = true;
  await page.routeWebSocket(daemonWsRoutePattern(), (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((message) => server.send(message));
    server.onMessage((message) => {
      if (typeof message !== "string") return socket.send(message);
      const envelope = JSON.parse(message);
      if (
        envelope.type === "session" &&
        envelope.message?.type === "provider.usage.list.response"
      ) {
        envelope.message.payload.providers = [
          {
            providerId: "mock",
            displayName: "Mock",
            status: "available",
            planLabel: null,
            windows: [
              {
                id: "weekly",
                label: "Weekly",
                remainingPct: 8,
                resetsAt: new Date(Date.now() + 3.5 * 86_400_000).toISOString(),
              },
            ],
          },
        ];
        const deliver = () => socket.send(JSON.stringify(envelope));
        if (hold) pending.push(deliver);
        else deliver();
        return;
      }
      socket.send(message);
    });
  });
  try {
    await workspace.client.waitForAgentUpsert(
      workspace.agentId,
      (agent) => agent.status === "idle",
      15_000,
    );
    await openAgentRoute(page, workspace);
    await expectComposerVisible(page);
    await expect.poll(() => pending.length).toBeGreaterThan(0);
    await page.getByTestId("agent-preset-selector").click();
    await expect(page.getByTestId("account-preset-menu")).toBeVisible({ timeout: 1000 });
    await expect(page.getByTestId("preset-usage-loading-mock")).toBeVisible();
    await page.getByTestId("preset-row-shared-profile/mock/account-ultra").click();
    await expect(page.getByTestId("preset-use-profile")).toHaveText("Activate Profile");
    hold = false;
    pending.splice(0).forEach((deliver) => deliver());
    await expect(page.getByTestId("preset-usage-loading-mock")).toHaveCount(0);
    const account = page.getByTestId("preset-account-mock");
    const remaining = account.getByText("8% left", { exact: true });
    const reset = account.getByText("Resets in 3 days", { exact: true });
    await expect(remaining).toBeVisible();
    await expect(reset).toBeVisible();
    expect((await remaining.boundingBox())!.y).toBeLessThan((await reset.boundingBox())!.y);
    await page.screenshot({ path: test.info().outputPath("profile-usage-refreshed.png") });
  } finally {
    hold = false;
    pending.splice(0).forEach((deliver) => deliver());
    await workspace.cleanup();
    await seed.restore();
  }
});

for (const reducedMotion of ["no-preference", "reduce"] as const) {
  test(`chooser entrances respect ${reducedMotion} motion preference`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.emulateMedia({ reducedMotion });
    const lastProfile = { ...medium, id: "account-last", name: "Last Profile" };
    const seed = await seedAgentProfiles([medium, ultra, lastProfile], true);
    const workspace = await seedWorkspace({ repoPrefix: "chooser-motion-" });
    try {
      const agent = await workspace.client.createAgent({
        provider: "mock",
        cwd: workspace.repoPath,
        workspaceId: workspace.workspaceId,
        profileId: "shared-workflow/mock/account-medium",
      });
      await openAgentRoute(page, { ...workspace, agentId: agent.id });
      await expectComposerVisible(page);
      await expect(page.getByTestId("agent-preset-selector")).toContainText("Astra Medium");
      const framesPromise = page.evaluate(
        () =>
          new Promise<Array<[number, number]>>((resolve, reject) => {
            const frames: Array<[number, number]> = [];
            const started = performance.now();
            const sample = () => {
              const first = document.querySelector(
                '[data-testid="preset-reveal-profile-shared-profile/mock/account-medium"]',
              );
              const last = document.querySelector(
                '[data-testid="preset-reveal-profile-shared-profile/mock/account-last"]',
              );
              if (first && last) {
                const a = Number(getComputedStyle(first).opacity);
                const b = Number(getComputedStyle(last).opacity);
                frames.push([a, b]);
                if (a === 1 && b === 1) return resolve(frames);
              }
              if (performance.now() - started > 10_000)
                return reject(new Error("Chooser entrance did not settle"));
              requestAnimationFrame(sample);
            };
            requestAnimationFrame(sample);
          }),
      );
      await page.getByTestId("agent-preset-selector").click();
      const frames = await framesPromise;
      expect(frames.some(([first, last]) => first > last && last < 1)).toBe(
        reducedMotion === "no-preference",
      );
      expect(frames.at(-1)).toEqual([1, 1]);
      // Selection changes stay usable while the details sweep is running.
      await page.getByTestId("preset-row-shared-profile/mock/account-ultra").click();
      await page.getByTestId("preset-row-shared-profile/mock/account-medium").click();
      await expect(page.getByTestId("preset-use-profile")).toHaveCount(0);
      await expect(page.getByTestId("preset-row-shared-profile/mock/account-medium")).not.toHaveCSS(
        "border-left-color",
        "rgba(0, 0, 0, 0)",
      );
    } finally {
      await workspace.cleanup();
      await seed.restore();
    }
  });
}

test("picker hides incompatible profiles and preserves them in Manage profiles", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const incompatible = {
    ...medium,
    id: "unsupported-model",
    name: "Unsupported model",
    model: "not-in-account-catalog",
  };
  const reasoning = {
    ...medium,
    id: "unsupported-reasoning",
    name: "Unsupported reasoning",
    thinkingOptionId: "not-in-model-catalog",
  };
  const seed = await seedAgentProfiles([incompatible, medium, reasoning], true);
  const workspace = await seedMockAgentWorkspace({
    repoPrefix: "profile-compatibility-",
    title: "Profile compatibility",
    model: "e2e-fast-stream",
  });
  try {
    await openAgentRoute(page, workspace);
    await expectComposerVisible(page);
    await page.getByTestId("agent-preset-selector").click();
    await expect(page.getByTestId("preset-row-shared-profile/mock/account-medium")).toBeVisible();
    await expect(page.getByTestId("preset-row-shared-profile/mock/unsupported-model")).toHaveCount(
      0,
    );
    await expect(
      page.getByTestId("preset-row-shared-profile/mock/unsupported-reasoning"),
    ).toHaveCount(0);
    await expect(page.getByTestId("preset-use-profile")).toHaveCount(0);
    await page.getByTestId("preset-row-shared-profile/mock/account-medium").click();
    await expect(page.getByTestId("preset-use-profile")).toBeEnabled();
    await page.getByTestId("preset-manage-profiles").click();
    await expect(page.getByTestId("agent-profile-row-unsupported-model")).toContainText(
      "Model not-in-account-catalog is not offered by this account.",
    );
    await expect(page.getByTestId("agent-profile-row-unsupported-reasoning")).toContainText(
      "Reasoning level not-in-model-catalog is not offered",
    );
  } finally {
    await workspace.cleanup();
    await seed.restore();
  }
});

test("failed catalog discovery offers retry and restores selectable profiles", async ({ page }) => {
  test.setTimeout(120_000);
  const seed = await seedAgentProfiles([medium], true);
  const workspace = await seedMockAgentWorkspace({
    repoPrefix: "profile-catalog-retry-",
    title: "Catalog retry",
  });
  let failCatalog = true;
  await page.routeWebSocket(daemonWsRoutePattern(), (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((message) => server.send(message));
    server.onMessage((message) => {
      if (!failCatalog || typeof message !== "string") return socket.send(message);
      const envelope = JSON.parse(message);
      const type = envelope.message?.type;
      if (
        envelope.type === "session" &&
        (type === "get_providers_snapshot_response" || type === "providers_snapshot_update")
      ) {
        const payload = envelope.message.payload;
        delete payload.compactSnapshot;
        delete payload.snapshotHash;
        delete payload.notModified;
        payload.entries = [
          { provider: "mock", enabled: true, status: "error", error: "Catalog discovery failed" },
        ];
        return socket.send(JSON.stringify(envelope));
      }
      socket.send(message);
    });
  });
  try {
    await openAgentRoute(page, workspace);
    await expectComposerVisible(page);
    await page.getByTestId("agent-preset-selector").click();
    await expect(page.getByTestId("preset-catalog-error")).toHaveText("Catalog discovery failed");
    await expect(page.getByTestId("preset-row-shared-profile/mock/account-medium")).toHaveCount(0);
    await expect(page.getByTestId("preset-use-profile")).toHaveCount(0);
    failCatalog = false;
    await page.getByTestId("preset-retry-profiles").click();
    await expect(page.getByTestId("preset-row-shared-profile/mock/account-medium")).toBeVisible();
    await page.getByTestId("preset-row-shared-profile/mock/account-medium").click();
    await expect(page.getByTestId("preset-use-profile")).toBeEnabled();
  } finally {
    await workspace.cleanup();
    await seed.restore();
  }
});

test("one saved profile stays selected across accounts and unavailable choices stay out of the picker", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const client = await connectDaemonClient<DaemonClient>({
    clientIdPrefix: "profile-account-selection",
  });
  const model = {
    id: "shared-model",
    label: "Shared model",
    thinkingOptions: [{ id: "high", label: "High" }],
  };
  await client.patchDaemonConfig({
    providers: {
      "profile-one": {
        extends: "codex",
        label: "Account one",
        enabled: true,
        command: ["node"],
        models: [model],
      },
      "profile-two": {
        extends: "codex",
        label: "Account two",
        enabled: true,
        command: ["node"],
        models: [model],
      },
      "profile-limited": {
        extends: "codex",
        label: "Limited account",
        enabled: true,
        command: ["node"],
        models: [{ ...model, thinkingOptions: [] }],
      },
    },
  });
  const seed = await seedAgentProfiles(
    [
      {
        id: "review",
        name: "Shared review",
        provider: "codex",
        model: "shared-model",
        thinkingOptionId: "high",
      },
    ],
    true,
  );
  const workspace = await seedMockAgentWorkspace({
    repoPrefix: "shared-profile-account-",
    title: "Shared profile account",
  });
  try {
    await openAgentRoute(page, workspace);
    await expectComposerVisible(page);
    await page.getByTestId("agent-preset-selector").click();
    await page.getByTestId("preset-account-profile-one").click();
    const row = page.getByTestId("preset-row-shared-profile/codex/review");
    await row.click();
    await expect(page.getByTestId("preset-use-profile")).toBeEnabled();
    await page.getByTestId("preset-account-profile-two").click();
    await expect(row).toHaveCount(1);
    await expect(page.getByTestId("preset-use-profile")).toBeEnabled();
    await page.getByTestId("preset-account-profile-limited").click();
    await expect(row).toHaveCount(0);
    await expect(page.getByTestId("preset-use-profile")).toHaveCount(0);
    await page.getByTestId("preset-account-profile-one").click();
    await expect(row).toHaveCount(1);
    await expect(page.getByTestId("preset-use-profile")).toBeEnabled();
  } finally {
    await workspace.cleanup();
    await seed.restore();
    await client.patchDaemonConfig({
      removeProviders: ["profile-one", "profile-two", "profile-limited"],
    });
    await client.close();
  }
});
