import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import * as Clipboard from "expo-clipboard";
import { CompactionMarker } from "./marker";
import type { CompactionItem } from "@/types/stream";
import { i18n } from "@/i18n/i18next";

// Native module registration belongs to Expo; browser permission outcomes are explicit fixtures.
vi.mock("expo-clipboard", () => ({ setStringAsync: vi.fn(async () => true) }));

let root: Root;
let container: HTMLDivElement;
const summary = "  Exact saved summary\n\nKeep the user's constraints.\n";
const item: CompactionItem = {
  kind: "compaction",
  id: "first",
  status: "completed",
  trigger: "auto",
  preTokens: 12000,
  timestamp: new Date("2026-10-07T12:00:00Z"),
  inspection: {
    summary: { type: "text", text: summary },
    estimatedPostTokens: 1500,
    firstKeptEntryId: "entry-42",
  },
};
beforeEach(async () => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await i18n.changeLanguage("en");
  container = document.createElement("div");
  container.style.maxWidth = "720px";
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function mount(items: CompactionItem[] = [item]) {
  act(() =>
    root.render(
      <>
        {items.map((entry) => (
          <CompactionMarker key={entry.id} item={entry} />
        ))}
      </>,
    ),
  );
}
async function click(name: string) {
  await page.getByRole("button", { name, exact: true }).click();
}

test.each([1280, 375])(
  "expands the original summary without losing whitespace at %ipx",
  async (width) => {
    await page.viewport(width, 800);
    mount();
    expect(container.querySelector('[data-testid="compaction-summary"]')).toBeNull();
    await click("Context automatically compacted");
    expect(container.querySelector('[data-testid="compaction-summary"]')?.textContent).toBe(
      summary,
    );
    expect(container.textContent).toContain("Before: 12000 tokens");
    expect(container.textContent).toContain("After: approximately 1500 tokens");
    expect(container.textContent).toContain("entry-42");
    for (const button of container.querySelectorAll<HTMLElement>('[role="button"],button')) {
      expect(button.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    }
    expect(container.getBoundingClientRect().right).toBeLessThanOrEqual(width);
    await page.screenshot({ path: `/tmp/compaction-inspector-${width}.png` });
    await click("Context automatically compacted");
    expect(container.querySelector('[data-testid="compaction-summary"]')).toBeNull();
  },
);

test("older and opaque events explain availability without inventing a summary", async () => {
  mount([
    { ...item, id: "old", trigger: "manual", inspection: undefined },
    {
      ...item,
      id: "opaque",
      inspection: { summary: { type: "unavailable", reason: "encrypted" } },
    },
  ]);
  await click("Context manually compacted");
  expect(container.textContent).toContain("No summary was saved");
  await click("Context automatically compacted");
  expect(container.textContent).toContain("encrypted context");
  expect(container.querySelectorAll('[data-testid="compaction-inspector"]').length).toBe(2);
  expect(container.textContent).not.toContain("Copy summary");
});

test("copy failure remains visible and retry copies the exact artifact", async () => {
  // Clipboard permission is browser-owned; control denial to exercise the visible recovery path.
  const copy = vi
    .spyOn(Clipboard, "setStringAsync")
    .mockRejectedValueOnce(new Error("Permission denied"))
    .mockResolvedValue(true);
  mount();
  await click("Context automatically compacted");
  await click("Copy summary");
  await expect
    .element(page.getByText("Could not complete the action.", { exact: false }))
    .toBeVisible();
  await click("Copy summary");
  await expect.element(page.getByText("Summary copied.", { exact: true })).toBeVisible();
  expect(copy.mock.calls).toEqual([[summary], [summary]]);
});

test("export creates a downloadable file containing the exact summary", async () => {
  const create = vi.spyOn(URL, "createObjectURL");
  mount();
  await click("Context automatically compacted");
  await click("Export summary");
  await expect.element(page.getByText("Summary export opened.", { exact: true })).toBeVisible();
  expect(create).toHaveBeenCalledTimes(1);
  const blob = create.mock.calls[0][0];
  if (!(blob instanceof Blob)) throw new Error("Expected a summary file");
  expect(await blob.text()).toBe(summary);
});

test("export failure stays visible and retry succeeds", async () => {
  vi.spyOn(URL, "createObjectURL").mockImplementationOnce(() => {
    throw new Error("Export unavailable");
  });
  mount();
  await click("Context automatically compacted");
  await click("Export summary");
  await expect
    .element(page.getByText("Could not complete the action.", { exact: false }))
    .toBeVisible();
  await click("Export summary");
  await expect.element(page.getByText("Summary export opened.", { exact: true })).toBeVisible();
});
