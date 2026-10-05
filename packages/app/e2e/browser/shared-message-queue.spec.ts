import type { Page } from "@playwright/test";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { expect, test } from "../support/fixtures";
import { seedMockAgentWorkspace, openAgentRoute } from "../support/helpers/mock-agent";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";
import {
  attachImageFromMenu,
  expectAttachmentPill,
  fillComposerDraft,
  expectComposerVisible,
} from "../support/helpers/composer";

test("shared queue survives reload and synchronizes a second device with Vorton off/on", async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "shared-queue-",
    title: "Shared queue acceptance",
    model: "thirty-minute-stream",
    initialPrompt: "Keep running while the shared queue is tested.",
  });
  const client = await connectDaemonClient<DaemonClient>({ clientIdPrefix: "shared-queue" });
  let second: Awaited<ReturnType<typeof browser.newContext>> | undefined;
  try {
    await client.mutateMessageQueue(agent.agentId, {
      kind: "pause",
      paused: true,
      operationId: "pause",
      expectedRevision: 0,
    });
    await openAgentRoute(page, agent);
    await expectComposerVisible(page, { timeout: 30_000 });
    await page.evaluate(() => {
      const key = "@paseo:create-agent-preferences";
      localStorage.setItem(
        key,
        JSON.stringify({ ...JSON.parse(localStorage.getItem(key) ?? "{}"), vortonMode: true }),
      );
    });
    await reloadPreservingPreferences(page);
    await expectComposerVisible(page, { timeout: 30_000 });
    await page.evaluate(() => {
      const original = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) {
        if (typeof data === "string") {
          const envelope = JSON.parse(data);
          if (envelope.message?.type === "agent.queue.mutate.request") {
            document.documentElement.dataset.queueRequestHeld = "true";
            return;
          }
        }
        original.call(this, data);
      };
    });
    // Dictation hotkeys can lose key-up, then replace .value without input/change.
    // Assert the queue button BEFORE any pointer, screenshot, focus, or key event.
    const composer = page.getByRole("textbox", { name: "Message agent..." }).first();
    await composer.focus();
    await composer.evaluate((element) => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Meta", metaKey: true, bubbles: true }),
      );
      (element as HTMLTextAreaElement).value = "Keep this through reload";
    });
    await expect(page.getByRole("button", { name: "Queue message", exact: true })).toBeEnabled();
    await attachImageFromMenu(page, {
      name: "queued-photo.png",
      mimeType: "image/png",
      buffer: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
        "base64",
      ),
    });
    await expectAttachmentPill(page, "composer-image-attachment-pill");
    await page.getByRole("button", { name: "Queue message", exact: true }).click();
    const queue = page.getByTestId("shared-message-queue");
    await expect(queue).toContainText("Keep this through reload");
    await expect
      .poll(() => page.evaluate(() => document.documentElement.dataset.queueRequestHeld))
      .toBe("true");
    await expect(queue).toContainText("Saved on this device");
    await expect(queue.getByTestId("queue-attachment-summary")).toHaveAttribute(
      "aria-label",
      "1 attachment",
    );
    expect((await client.readMessageQueue(agent.agentId)).snapshot?.items).toHaveLength(0);
    // Reload removes the interception and must recover the request from IndexedDB.
    await reloadPreservingPreferences(page);
    await expectComposerVisible(page, { timeout: 30_000 });
    await expect(queue).toContainText("Keep this through reload");
    await expect
      .poll(async () => (await client.readMessageQueue(agent.agentId)).snapshot?.items.length)
      .toBe(1);

    second = await browser.newContext({
      baseURL: new URL(page.url()).origin,
      storageState: await page.context().storageState(),
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    const other = await second.newPage();
    await openAgentRoute(other, agent);
    await expect(other.getByTestId("shared-message-queue")).toContainText(
      "Keep this through reload",
    );
    await expect(other.getByTestId("queue-attachment-summary")).toHaveAttribute(
      "aria-label",
      "1 attachment",
    );
    await fillComposerDraft(other, "From another device");
    await other.getByRole("button", { name: "Queue message", exact: true }).click();
    await expect(queue).toContainText("From another device");
    await expect
      .poll(async () => (await client.readMessageQueue(agent.agentId)).snapshot?.items.length)
      .toBe(2);
    await expect(queue.getByTestId("queue-attachment-summary")).toHaveCount(1);
    await expect(other.getByTestId("queue-attachment-summary")).toHaveCount(1);
    const initialOrder = (await client.readMessageQueue(agent.agentId)).snapshot!.items.map(
      (item) => item.id,
    );
    // Editing replaces the summary and row actions, preserving attached media.
    for (const [target, height] of [
      [page, 32],
      [other, 44],
    ] as const) {
      const row = target.getByTestId(`queue-message-${initialOrder[0]}`);
      await row.getByRole("button", { name: "Edit queued message", exact: true }).click();
      const input = row.getByRole("textbox", { name: "Edit queued message" });
      // Metro compiles the deferred editor on its first use.
      await expect(input).toHaveValue("Keep this through reload", { timeout: 30_000 });
      await expect(input).toHaveCSS("border-top-width", "0px");
      await expect(row.getByRole("button", { name: "Send queued message now" })).toHaveCount(0);
      await expect(row.getByRole("button", { name: "Queued message actions" })).toHaveCount(0);
      await expect(row).toContainText("queued-photo.png");
      const save = row.getByRole("button", { name: "Save", exact: true });
      await expect(save).toBeDisabled();
      await input.fill("Unsaved queue edit");
      await expect(save).toBeEnabled();
      await expect(row.getByText("Draft saved on this device", { exact: true })).toBeVisible();
      for (const name of ["Cancel", "Save"]) {
        const button = row.getByRole("button", { name, exact: true });
        await expect(button).toHaveCSS("height", `${height}px`);
        if (target === page) {
          await page.mouse.move(0, 0);
          const resting = await button.evaluate((el) => getComputedStyle(el).backgroundColor);
          await button.hover();
          await expect(button).not.toHaveCSS("background-color", resting);
        }
      }
      await row.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(
        row.getByRole("button", { name: "Edit queued message", exact: true }),
      ).toBeVisible();
    }
    const reverseOrder = initialOrder.toReversed();
    await dragQueueMessage(page, initialOrder[0], initialOrder[1], false);
    await expect
      .poll(async () =>
        (await client.readMessageQueue(agent.agentId)).snapshot?.items.map((item) => item.id),
      )
      .toEqual(reverseOrder);
    await expect(other.getByTestId(/^queue-message-/).first()).toHaveAttribute(
      "data-testid",
      "queue-message-" + reverseOrder[0],
    );
    await dragQueueMessage(other, reverseOrder[0], reverseOrder[1], true);
    await expect
      .poll(async () =>
        (await client.readMessageQueue(agent.agentId)).snapshot?.items.map((item) => item.id),
      )
      .toEqual(initialOrder);
    await expect(queue.getByTestId(/^queue-message-/).first()).toHaveAttribute(
      "data-testid",
      "queue-message-" + initialOrder[0],
    );
    await expect(queue).toContainText("Message queue");
    await expect(
      page.getByTestId("agent-chat-scroll").getByTestId("shared-message-queue"),
    ).toHaveCount(1);
    await expect(
      other.getByTestId("agent-chat-scroll").getByTestId("shared-message-queue"),
    ).toHaveCount(1);
    await expect(page.getByTestId(/^workspace-queue-count-/).filter({ hasText: "Q2" })).toHaveCount(
      1,
    );
    for (const target of [page, other]) {
      const card = target.getByTestId("shared-message-queue");
      await card.scrollIntoViewIfNeeded();
      const heading = card.getByText("Message queue", { exact: true });
      const icon = card.getByTestId("message-queue-pause-resume").locator("svg");
      await expect(heading).toBeVisible();
      await expect(icon).toBeVisible();
      // Streaming can move the card between browser calls; measure both in one frame.
      const offset = await heading.evaluate(
        (label, glyph) => {
          if (!glyph) throw new Error("Queue control icon is missing");
          return glyph.getBoundingClientRect().y - label.getBoundingClientRect().y;
        },
        await icon.elementHandle(),
      );
      // Text glyphs sit below the line box; align icons with the visible letters.
      expect(Math.abs(offset - 3)).toBeLessThanOrEqual(1);
    }
    for (const target of [page, other]) {
      for (const variant of ["circle"]) {
        await target.evaluate((value) => {
          const key = "@paseo:create-agent-preferences";
          localStorage.setItem(
            key,
            JSON.stringify({
              ...JSON.parse(localStorage.getItem(key) ?? "{}"),
              jumpToLatestVariant: value,
            }),
          );
        }, variant);
        await reloadPreservingPreferences(target);
        await expectComposerVisible(target, { timeout: 30_000 });
        await expect(target.getByTestId("shared-message-queue")).toContainText(
          "From another device",
        );
        const timeline = target.getByTestId("agent-chat-scroll");
        await timeline.hover();
        await target.mouse.wheel(0, -10000);
        const jump = target.getByRole("button", { name: "Jump to latest", exact: true });
        await expect(jump).toBeVisible();
        await expect(target.getByTestId("shared-message-queue")).not.toBeInViewport();
        await expect(jump).toContainText("Latest");
        await expect(jump).toContainText("Q2");
        const box = await jump.boundingBox();
        expect(box?.height).toBeGreaterThanOrEqual(44);
        await test.info().attach("jump-" + variant + (target === page ? "-desktop" : "-touch"), {
          body: await target.screenshot(),
          contentType: "image/png",
        });
        await jump.click();
        await expect(target.getByTestId("shared-message-queue")).toBeInViewport();
        await expect(jump).toBeHidden();
      }
    }
    await test.info().attach("queue-desktop", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
    await test.info().attach("queue-touch", {
      body: await other.screenshot(),
      contentType: "image/png",
    });

    await page.evaluate(() => {
      const key = "@paseo:create-agent-preferences";
      localStorage.setItem(
        key,
        JSON.stringify({ ...JSON.parse(localStorage.getItem(key) ?? "{}"), vortonMode: false }),
      );
    });
    await reloadPreservingPreferences(page);
    await expectComposerVisible(page, { timeout: 30_000 });
    await expect(queue).toHaveCount(0);
    await expect(page.getByTestId(/^workspace-queue-count-/)).toHaveCount(0);
    await test.info().attach("queue-vorton-off", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
    expect((await client.readMessageQueue(agent.agentId)).snapshot?.items).toHaveLength(2);
    await expect(other.getByTestId("shared-message-queue")).toContainText("From another device");
  } catch (error) {
    console.error(
      "Queue acceptance page:",
      page.url(),
      await page
        .locator("body")
        .innerText()
        .catch(() => "Page unavailable"),
    );
    throw error;
  } finally {
    await second?.close();
    await client.close();
    await agent.cleanup();
  }
});

async function reloadPreservingPreferences(page: Page): Promise<void> {
  await page.evaluate(() => {
    localStorage.setItem(
      "@paseo:e2e-disable-default-seed-once",
      localStorage.getItem("@paseo:e2e-seed-nonce") ?? "",
    );
  });
  await page.reload({ waitUntil: "commit" });
}

// Real touch events exercise the same mobile handle that leaves the rest of the
// conversation scrollable. No long-press delay is required for this handle.
async function dragQueueMessage(page: Page, from: string, to: string, touch: boolean) {
  const handle = page.getByTestId("queue-drag-" + from);
  await handle.scrollIntoViewIfNeeded();
  const start = (await handle.boundingBox())!;
  const end = (await page.getByTestId("queue-drag-" + to).boundingBox())!;
  const x = start.x + start.width / 2;
  const y = start.y + start.height / 2;
  const destination = end.y + end.height / 2;
  if (touch) {
    const cdp = await page.context().newCDPSession(page);
    try {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
      for (let step = 1; step <= 12; step++) {
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [{ x, y: y + ((destination - y) * step) / 12 }],
        });
      }
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    } finally {
      await cdp.detach();
    }
  } else {
    await expect(handle).toHaveCSS("cursor", "grab");
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, destination, { steps: 12 });
    await expect(handle).toHaveCSS("cursor", "grabbing");
    await page.mouse.up();
  }
}

test("edits queued media durably and saves the exact attachment set", async ({ page }) => {
  test.setTimeout(180_000);
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "queue-media-",
    title: "Queue media editing",
    model: "thirty-minute-stream",
    initialPrompt: "Keep running while editing the queue.",
  });
  const client = await connectDaemonClient<DaemonClient>({ clientIdPrefix: "queue-media" });
  try {
    await client.mutateMessageQueue(agent.agentId, {
      kind: "pause",
      paused: true,
      operationId: "pause",
      expectedRevision: 0,
    });
    await client.mutateMessageQueue(agent.agentId, {
      kind: "enqueue",
      operationId: "add",
      messageId: "media-edit",
      text: "Original message",
      attachments: [],
    });
    await openAgentRoute(page, agent);
    await expectComposerVisible(page);
    await page.evaluate(() => {
      const key = "@paseo:create-agent-preferences";
      localStorage.setItem(
        key,
        JSON.stringify({ ...JSON.parse(localStorage.getItem(key) ?? "{}"), vortonMode: true }),
      );
    });
    await reloadPreservingPreferences(page);
    const row = page.getByTestId("queue-message-media-edit");
    await row.getByRole("button", { name: "Edit queued message", exact: true }).click();
    const editor = page.getByTestId(/^queue-edit-draft-/);
    await editor
      .getByRole("textbox", { name: "Edit queued message", exact: true })
      .fill("Edited with media");
    const chooser = page.waitForEvent("filechooser");
    await editor.getByRole("button", { name: "Add images", exact: true }).click();
    await (
      await chooser
    ).setFiles({
      name: "edit-image.png",
      mimeType: "image/png",
      buffer: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
        "base64",
      ),
    });
    await expect(
      editor.getByRole("button", { name: "Remove edit-image.png", exact: true }),
    ).toBeVisible();
    await reloadPreservingPreferences(page);
    await expect(
      editor.getByRole("textbox", { name: "Edit queued message", exact: true }),
    ).toHaveValue("Edited with media", { timeout: 30_000 });
    await expect(
      editor.getByRole("button", { name: "Remove edit-image.png", exact: true }),
    ).toBeVisible();
    expect((await client.readMessageQueue(agent.agentId)).snapshot?.items[0].text).toBe(
      "Original message",
    );
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await expect(editor).toHaveCount(0);
    await expect
      .poll(async () => (await client.readMessageQueue(agent.agentId)).snapshot?.items[0])
      .toMatchObject({
        id: "media-edit",
        text: "Edited with media",
        revision: 1,
        attachments: [{ fileName: "edit-image.png", kind: "image" }],
      });
    await row.getByRole("button", { name: "Edit queued message", exact: true }).click();
    await editor.getByRole("button", { name: "Remove edit-image.png", exact: true }).click();
    await editor.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(
      (await client.readMessageQueue(agent.agentId)).snapshot?.items[0].attachments,
    ).toHaveLength(1);
    await row.getByRole("button", { name: "Edit queued message", exact: true }).click();
    await editor.getByRole("button", { name: "Remove edit-image.png", exact: true }).click();
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await expect
      .poll(
        async () => (await client.readMessageQueue(agent.agentId)).snapshot?.items[0].attachments,
      )
      .toEqual([]);
  } finally {
    await client.close();
    await agent.cleanup();
  }
});

test("preserves a media edit after another device changes the message", async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "queue-media-conflict-",
    title: "Queue media conflict",
    model: "thirty-minute-stream",
    initialPrompt: "Keep running while the queue is tested.",
  });
  const client = await connectDaemonClient<DaemonClient>({ clientIdPrefix: "queue-conflict" });
  let second: Awaited<ReturnType<typeof browser.newContext>> | undefined;
  try {
    await client.mutateMessageQueue(agent.agentId, {
      kind: "pause",
      paused: true,
      operationId: "pause",
      expectedRevision: 0,
    });
    await client.mutateMessageQueue(agent.agentId, {
      kind: "enqueue",
      operationId: "add",
      messageId: "conflict-edit",
      text: "Original",
      attachments: [],
    });
    await openAgentRoute(page, agent);
    await expectComposerVisible(page);
    await page.evaluate(() => {
      const key = "@paseo:create-agent-preferences";
      localStorage.setItem(
        key,
        JSON.stringify({ ...JSON.parse(localStorage.getItem(key) ?? "{}"), vortonMode: true }),
      );
    });
    await reloadPreservingPreferences(page);
    second = await browser.newContext({
      baseURL: new URL(page.url()).origin,
      storageState: await page.context().storageState(),
    });
    const other = await second.newPage();
    await openAgentRoute(other, agent);
    const row = page.getByTestId("queue-message-conflict-edit");
    const otherRow = other.getByTestId("queue-message-conflict-edit");
    await row.getByRole("button", { name: "Edit queued message", exact: true }).click();
    const editor = page.getByTestId(/^queue-edit-draft-/);
    await editor
      .getByRole("textbox", { name: "Edit queued message", exact: true })
      .fill("My retained media edit");
    const chooser = page.waitForEvent("filechooser");
    await editor.getByRole("button", { name: "Add images", exact: true }).click();
    await (
      await chooser
    ).setFiles({
      name: "conflict.png",
      mimeType: "image/png",
      buffer: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
        "base64",
      ),
    });
    await expect(
      editor.getByRole("button", { name: "Remove conflict.png", exact: true }),
    ).toBeVisible();
    await otherRow.getByRole("button", { name: "Edit queued message", exact: true }).click();
    const otherEditor = other.getByTestId(/^queue-edit-draft-/);
    await otherEditor
      .getByRole("textbox", { name: "Edit queued message", exact: true })
      .fill("Other device wins first");
    await otherEditor.getByRole("button", { name: "Save", exact: true }).click();
    await expect
      .poll(async () => (await client.readMessageQueue(agent.agentId)).snapshot?.items[0])
      .toMatchObject({ revision: 1, text: "Other device wins first", attachments: [] });
    await expect(editor).toContainText("The message changed on another device");
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    const queue = page.getByTestId("shared-message-queue");
    await expect(queue).toContainText("Could not synchronize");
    await reloadPreservingPreferences(page);
    await queue
      .getByRole("button", { name: "Review against current message", exact: true })
      .click();
    await expect(
      editor.getByRole("textbox", { name: "Edit queued message", exact: true }),
    ).toHaveValue("My retained media edit", { timeout: 30_000 });
    await expect(
      editor.getByRole("button", { name: "Remove conflict.png", exact: true }),
    ).toBeVisible();
    expect((await client.readMessageQueue(agent.agentId)).snapshot?.items[0].text).toBe(
      "Other device wins first",
    );
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await expect
      .poll(async () => (await client.readMessageQueue(agent.agentId)).snapshot?.items[0])
      .toMatchObject({
        id: "conflict-edit",
        revision: 2,
        text: "My retained media edit",
        attachments: [{ fileName: "conflict.png", kind: "image" }],
      });
    await expect(otherRow).toContainText("My retained media edit");
    await expect(otherRow.getByTestId("queue-attachment-summary")).toHaveAttribute(
      "aria-label",
      "1 attachment",
    );
  } finally {
    await second?.close();
    await client.close();
    await agent.cleanup();
  }
});
