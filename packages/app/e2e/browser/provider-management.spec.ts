import { mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { Locator } from "@playwright/test";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";
import { getServerId } from "../support/helpers/server-id";

// Account management must work without a provider installation. A file cannot
// contain an executable, so this path stays unavailable on every test host.
test.use({
  e2eDaemonConfig: {
    version: 1,
    agents: {
      providers: {
        codex: { command: [path.join(process.execPath, "unavailable-codex")] },
      },
    },
  },
});

for (const width of [1280, 402]) {
  test(`Vorton provider management at ${width}px`, async ({ page }) => {
    test.setTimeout(120_000);
    const client = await connectDaemonClient<DaemonClient>({
      clientIdPrefix: "provider-management",
    });
    const createdIds: string[] = [];
    try {
      for (const name of ["Existing work", "Existing personal"]) {
        const account = await client.createCodexAccount(crypto.randomUUID(), name);
        createdIds.push(account.providerId);
      }
      await page.setViewportSize({ width, height: 1000 });
      await gotoAppShell(page);
      await page.evaluate(() => {
        const key = "@paseo:create-agent-preferences";
        const preferences = JSON.parse(localStorage.getItem(key) ?? "{}");
        localStorage.setItem(key, JSON.stringify({ ...preferences, vortonMode: true }));
        const nonce = localStorage.getItem("@paseo:e2e-seed-nonce");
        if (!nonce) throw new Error("Missing isolated browser seed nonce");
        localStorage.setItem("@paseo:e2e-disable-default-seed-once", nonce);
      });
      await page.goto(`/settings/hosts/${getServerId()}/providers`);
      await expect(
        page.getByTestId("host-page-providers-card").getByTestId("add-codex-account"),
      ).toHaveCount(0);
      for (const id of ["claude", "codex", "copilot", "opencode", "pi", "omp"]) {
        await expect(page.getByTestId(`provider-rename-${id}`)).toHaveCount(0);
        await expect(page.getByTestId(`provider-remove-${id}`)).toHaveCount(0);
      }
      await expect(page.getByTestId("catalog-provider-codex")).toContainText(
        "Codex (ChatGPT account)",
      );
      const codexAdd = page.getByTestId("add-codex-account");
      const otherAdd = page.locator('[data-testid^="install-provider-"]').first();
      await expect(otherAdd).toBeVisible();
      const codexBox = await codexAdd.boundingBox();
      const otherBox = await otherAdd.boundingBox();
      expect(codexBox?.width).toBe(otherBox?.width);
      expect(codexBox?.height).toBe(otherBox?.height);
      await page.getByTestId("provider-catalog-search").fill("CoDeX");
      for (const suffix of ["one", "two"]) {
        const name = `Search account ${width} ${suffix}`;
        await page
          .getByTestId("catalog-provider-codex")
          .getByRole("button", { name: "Add", exact: true })
          .click();
        await expect(page.getByTestId("codex-account-name")).toHaveValue("Codex 3");
        await page.getByTestId("codex-account-name").fill(name);
        await page.getByTestId("codex-account-create").click();
        await expect(page.getByTestId("provider-login-panel")).toBeVisible();
        await page.getByTestId("codex-account-done").click();
        const entry = Object.entries((await client.getDaemonConfig()).config.providers).find(
          ([, provider]) => provider.label === name,
        );
        if (!entry) throw new Error(`Missing created provider ${name}`);
        const [id, provider] = entry;
        createdIds.push(id);
        await expect(page.getByTestId("catalog-provider-codex")).toBeVisible();
        const controls = [
          page.getByTestId(`provider-rename-${id}`),
          page.getByTestId(`provider-remove-${id}`),
          page.getByTestId(`provider-connect-${id}`),
          page.getByRole("switch", { name: `Enable ${name}`, exact: true }),
        ];
        const boxes: NonNullable<Awaited<ReturnType<Locator["boundingBox"]>>>[] = [];
        for (const control of controls) {
          await expect(control).toBeVisible();
          const box = await control.boundingBox();
          if (!box) throw new Error("Missing provider control bounds");
          boxes.push(box);
        }
        const gaps = boxes
          .slice(1)
          .map((box, index) => box.x - boxes[index].x - boxes[index].width);
        expect(gaps[0]).toBeGreaterThan(0);
        for (const gap of gaps) expect(gap).toBeCloseTo(gaps[0], 0);
        for (const action of ["rename", "remove", "connect"]) {
          await expect(page.getByTestId(`provider-${action}-${id}-outline`)).toHaveCSS(
            "border-top-style",
            "solid",
          );
        }
        await page.getByTestId(`provider-rename-${id}`).click();
        await page.getByTestId("provider-rename-dialog-input").fill(`Renamed ${name}`);
        await page.getByTestId("provider-rename-dialog-submit").click();
        await expect(page.getByTestId("provider-rename-dialog")).toBeHidden();
        await expect(
          page.getByRole("button", { name: `Renamed ${name} provider details`, exact: true }),
        ).toBeVisible();
        const renamed = (await client.getDaemonConfig()).config.providers[id];
        expect(renamed.label).toBe(`Renamed ${name}`);
        expect(renamed.env).toEqual(provider.env);
        await expect
          .poll(async () => {
            const { entries } = await client.getProvidersSnapshot();
            const snapshot = entries.find((candidate) => candidate.provider === id);
            return { status: snapshot?.status, enabled: snapshot?.enabled };
          })
          .toEqual({ status: "unavailable", enabled: true });
        const cancelDialog = page.waitForEvent("dialog").then((dialog) => dialog.dismiss());
        await Promise.all([page.getByTestId(`provider-remove-${id}`).click(), cancelDialog]);
        await expect(page.getByTestId(`provider-rename-${id}`)).toBeVisible();
        const confirmDialog = page.waitForEvent("dialog").then((dialog) => dialog.accept());
        await Promise.all([page.getByTestId(`provider-remove-${id}`).click(), confirmDialog]);
        await expect(page.getByTestId(`provider-rename-${id}`)).toHaveCount(0);
        expect((await client.getDaemonConfig()).config.providers[id]).toBeUndefined();
      }
      await page.evaluate(() => {
        const key = "@paseo:create-agent-preferences";
        const preferences = JSON.parse(localStorage.getItem(key) ?? "{}");
        localStorage.setItem(key, JSON.stringify({ ...preferences, vortonMode: false }));
        const seedNonce = localStorage.getItem("@paseo:e2e-seed-nonce");
        if (!seedNonce) throw new Error("Missing test seed nonce");
        localStorage.setItem("@paseo:e2e-disable-default-seed-once", seedNonce);
      });
      await page.reload();
      await expect(page.getByTestId("host-page-providers-card")).toBeVisible();
      await expect(page.getByTestId("catalog-provider-codex")).toHaveCount(0);
      await expect(page.getByTestId("provider-rename-codex")).toHaveCount(0);
    } finally {
      await client.patchDaemonConfig({ removeProviders: createdIds });
      await client.close();
    }
  });
}

test("provider drag order persists, reports save failures, and plugin deletion stays removed", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const client = await connectDaemonClient<DaemonClient>({ clientIdPrefix: "provider-order" });
  try {
    await client.patchDaemonConfig({
      providers: { antigravity: { enabled: false }, muse: { enabled: false } },
    });
    await gotoAppShell(page);
    await page.evaluate(() => {
      const key = "@paseo:create-agent-preferences";
      const preferences = JSON.parse(localStorage.getItem(key) ?? "{}");
      localStorage.setItem(key, JSON.stringify({ ...preferences, vortonMode: true }));
      const nonce = localStorage.getItem("@paseo:e2e-seed-nonce");
      if (!nonce) throw new Error("Missing isolated browser seed nonce");
      localStorage.setItem("@paseo:e2e-disable-default-seed-once", nonce);
    });
    await page.goto(`/settings/hosts/${getServerId()}/providers`);
    const handles = page.locator('[data-testid^="provider-drag-"]');
    await expect(handles.first()).toBeVisible();
    const original = await handles.evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("data-testid")),
    );
    const source = page.getByTestId("provider-drag-codex");
    const target = page.getByTestId("provider-drag-claude");
    await expect(source).toBeVisible();
    const start = await source.boundingBox();
    const end = await target.boundingBox();
    if (!start || !end) throw new Error("Missing drag handle bounds");
    await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
    await page.mouse.down();
    await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2, { steps: 12 });
    await page.mouse.up();
    await expect
      .poll(async () => (await client.getDaemonConfig()).config.providers.codex?.order)
      .toBe(0);
    await expect(handles.first()).toHaveAttribute("data-testid", "provider-drag-codex");
    await page.evaluate(() => {
      const nonce = localStorage.getItem("@paseo:e2e-seed-nonce");
      if (!nonce) throw new Error("Missing test seed nonce");
      localStorage.setItem("@paseo:e2e-disable-default-seed-once", nonce);
    });
    await page.reload();
    await expect(handles.first()).toHaveAttribute("data-testid", "provider-drag-codex");
    expect(await handles.count()).toBe(original.length);
    const home = process.env.E2E_PASEO_HOME;
    if (!home) throw new Error("Missing isolated daemon home");
    const configPath = path.join(home, "config.json");
    const backupPath = path.join(home, "config.provider-order-backup.json");
    await rename(configPath, backupPath);
    await mkdir(configPath);
    try {
      await source.focus();
      await page.keyboard.press("Space");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Space");
      await expect(page.getByRole("alert")).toContainText(/EISDIR|directory/);
      await expect(handles.first()).toHaveAttribute("data-testid", "provider-drag-codex");
    } finally {
      await rm(configPath, { recursive: true });
      await rename(backupPath, configPath);
    }
    await source.focus();
    await page.keyboard.press("Space");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Space");
    await expect
      .poll(async () => (await client.getDaemonConfig()).config.providers.codex?.order)
      .toBe(1);
    await expect(page.getByRole("alert")).toHaveCount(0);
    for (const id of ["antigravity", "muse"]) {
      const confirmation = page.waitForEvent("dialog").then((dialog) => dialog.accept());
      await Promise.all([page.getByTestId(`provider-remove-${id}`).click(), confirmation]);
      await expect(page.getByTestId(`provider-remove-${id}`)).toHaveCount(0);
    }
    await page.evaluate(() => {
      const nonce = localStorage.getItem("@paseo:e2e-seed-nonce");
      if (!nonce) throw new Error("Missing test seed nonce");
      localStorage.setItem("@paseo:e2e-disable-default-seed-once", nonce);
    });
    await page.reload();
    await expect(page.getByTestId("provider-order-list")).toBeVisible();
    await expect(page.getByTestId("provider-remove-antigravity")).toHaveCount(0);
    await expect(page.getByTestId("provider-remove-muse")).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath("providers-reordered.png") });
  } finally {
    await client.close();
  }
});
