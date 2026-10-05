#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const output = process.argv[2] ?? path.join(tmpdir(), "paseo-browser-check");
await mkdir(output, { recursive: true });
for (const channel of [undefined, "chromium"]) {
  const name = channel ?? "headless-shell";
  const browser = await chromium.launch({ headless: true, channel });
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 560 } });
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>
      body { margin: 0; padding: 64px; background: #211f1d; color: #faf6ef; font: 24px "Liberation Sans", sans-serif; }
      button { padding: 16px 24px; border: 0; border-radius: 8px; background: #dd7958; font: inherit; }
      p { color: #c9c1b9; } code { font-family: "Liberation Mono", monospace; }
      </style></head><body><h1>Browser review is ready</h1><p>Text, fonts, layout, and interaction.</p>
      <button onclick="document.querySelector('p').textContent='Interaction verified'">Check interaction</button>
      <p><code>Chromium runtime</code></p></body></html>`);
    await page.getByRole("button", { name: "Check interaction" }).click();
    assert.equal(await page.locator("p").first().textContent(), "Interaction verified");
    const screenshot = path.join(output, `${name}.png`);
    const png = await page.screenshot({ path: screenshot });
    assert.ok(png.length > 4000, "Screenshot should contain rendered text and controls");
    console.log(`${name}: launch, render, click, screenshot passed (${screenshot})`);
  } finally {
    await browser.close();
  }
}
