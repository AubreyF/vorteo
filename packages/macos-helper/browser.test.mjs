import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
import { validateParameters } from "./protocol.mjs";
let browser;
let page;
let program;
beforeAll(async () => {
  program = await readFile(new URL("./browser/page.js", import.meta.url), "utf8");
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  await browser.close();
});
beforeEach(async () => {
  if (page) await page.close();
  page = await browser.newPage();
  // Real DOM, local fixture, no network route mocks or authenticated sessions.
  await page.setContent(
    '<h1>Plugins</h1><p>fixture-private-key</p><input type=password value="fixture-private-key"><input aria-label="Name"><button>Create</button><a href="https://unapproved.example/">Continue</a><select><option value="private-identifier">Save</option></select>',
  );
  await page.addScriptTag({ content: program });
});
async function run(parameters) {
  return JSON.parse(
    await page.evaluate((data) => window.vorteoPage(data), {
      origin: "null",
      allowedText: ["Plugins", "Name", "Create", "Save", "Continue"],
      destinations: [],
      ...parameters,
    }),
  );
}
describe("fixed browser operations", () => {
  it("returns bounded approved UI phrases while withholding values and body text", async () => {
    const reply = await run({ action: "read", pageId: "page-1" });
    expect(reply.headings).toEqual(["Plugins"]);
    expect(reply.elements[0].label).toBe("[withheld]");
    expect(reply.elements.map((element) => element.label)).toEqual([
      "[withheld]",
      "Name",
      "Create",
      "Continue",
      "Save",
    ]);
    expect(JSON.stringify(reply)).not.toContain("fixture-private-key");
    expect(JSON.stringify(reply)).not.toContain("private-identifier");
  });
  it("checks origin before reading or modifying the page", async () => {
    expect(await run({ action: "read", origin: "https://chatgpt.com", pageId: "page-1" })).toEqual({
      ok: false,
      code: "origin_changed",
    });
  });
  it("treats supplied fill text as data and invalidates handles after interaction", async () => {
    const reply = await run({ action: "read", pageId: "page-1" });
    const element = reply.elements.find((entry) => entry.label === "Name").handle;
    const value = '";window.arbitraryExecution=true;//';
    expect(await run({ action: "fill", pageId: "page-1", element, value })).toEqual({
      ok: true,
      code: "interaction_completed",
    });
    expect(await page.locator('input[aria-label="Name"]').inputValue()).toBe(value);
    expect(await page.evaluate(() => Boolean(window.arbitraryExecution))).toBe(false);
    expect(await run({ action: "click", pageId: "page-1", element })).toEqual({
      ok: false,
      code: "stale_page",
    });
  });
  it("rejects detached or semantically changed element handles", async () => {
    const reply = await run({ action: "read", pageId: "page-1" });
    const element = reply.elements.find((entry) => entry.label === "Create").handle;
    await page.locator("button").evaluate((node) => {
      node.textContent = "Different action";
    });
    expect(await run({ action: "click", pageId: "page-1", element })).toEqual({
      ok: false,
      code: "stale_element",
    });
  });
  it("blocks anchor navigation outside exact configured destinations", async () => {
    const reply = await run({ action: "read", pageId: "page-1" });
    const element = reply.elements.find((entry) => entry.label === "Continue").handle;
    expect(await run({ action: "click", pageId: "page-1", element })).toEqual({
      ok: false,
      code: "destination_rejected",
    });
  });
  it("rejects a link whose destination changes while its label stays the same", async () => {
    const reply = await run({ action: "read", pageId: "page-1" });
    const element = reply.elements.find((entry) => entry.label === "Continue").handle;
    await page.locator("a").evaluate((node) => {
      node.href = "https://approved.example/new";
    });
    expect(
      await run({
        action: "click",
        pageId: "page-1",
        element,
        destinations: ["https://approved.example/new"],
      }),
    ).toEqual({ ok: false, code: "stale_element" });
  });
  it("rejects a changed input type before filling it", async () => {
    const reply = await run({ action: "read", pageId: "page-1" });
    const element = reply.elements.find((entry) => entry.label === "Name").handle;
    await page.locator('input[aria-label="Name"]').evaluate((node) => {
      node.type = "password";
    });
    expect(await run({ action: "fill", pageId: "page-1", element, value: "sample" })).toEqual({
      ok: false,
      code: "stale_element",
    });
    expect(await page.locator('input[aria-label="Name"]').inputValue()).toBe("");
  });
  it("reports ARIA-disabled controls and refuses interaction when they become disabled", async () => {
    await page.locator("button").evaluate((node) => {
      node.setAttribute("aria-disabled", "true");
    });
    const disabledSnapshot = await run({ action: "read", pageId: "page-1" });
    expect(disabledSnapshot.elements.find((entry) => entry.label === "Create").disabled).toBe(true);
    await page.locator("button").evaluate((node) => {
      node.removeAttribute("aria-disabled");
    });
    const reply = await run({ action: "read", pageId: "page-2" });
    const element = reply.elements.find((entry) => entry.label === "Create").handle;
    await page.locator("button").evaluate((node) => {
      node.setAttribute("aria-disabled", "true");
    });
    expect(await run({ action: "click", pageId: "page-2", element })).toEqual({
      ok: false,
      code: "stale_element",
    });
  });
  it("chooses an approved public option label without exporting its private value", async () => {
    const reply = await run({ action: "read", pageId: "page-1" });
    const element = reply.elements.find((entry) => entry.tag === "select").handle;
    expect(await run({ action: "choose", pageId: "page-1", element, value: "Save" })).toEqual({
      ok: true,
      code: "interaction_completed",
    });
  });
  it("rejects a changed form action even when the submit control stays the same", async () => {
    await page.setContent(
      '<form action="https://approved.example/create"><button type="submit">Create</button></form>',
    );
    const reply = await run({ action: "read", pageId: "page-1" });
    const element = reply.elements[0].handle;
    await page.locator("form").evaluate((node) => {
      node.action = "https://approved.example/delete";
    });
    expect(await run({ action: "click", pageId: "page-1", element })).toEqual({
      ok: false,
      code: "stale_element",
    });
  });
});
it("rejects executable source and invalid tab references at the Host boundary", () => {
  expect(() =>
    validateParameters("safari.read", { windowId: 1, tabIndex: 1, script: "alert(1)" }),
  ).toThrow("Invalid helper parameters");
  expect(() => validateParameters("safari.read", { windowId: 1, tabIndex: -1 })).toThrow(
    "Invalid tab reference",
  );
  expect(() =>
    validateParameters("safari.navigate", { windowId: 1, tabIndex: 1, url: "javascript:alert(1)" }),
  ).toThrow("Invalid helper parameters");
});
