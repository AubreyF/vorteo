import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron } from "playwright";
import { expect } from "@playwright/test";

// Build the desktop main modules first. This fixture never loads the desktop
// entry point, registers daemon commands, or touches the installed app profile.
const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = await mkdtemp(path.join(tmpdir(), "vorteo-navigation-security-"));
let externalRequests = 0;
const external = createServer((_request, response) => {
  externalRequests++;
  response.end("<h1>Outside application</h1>");
});
await new Promise((resolve) => external.listen(0, "127.0.0.1", resolve));
const externalUrl = `http://127.0.0.1:${external.address().port}/`;
const trusted = createServer((request, response) => {
  if (request.url === "/redirect") {
    response.writeHead(302, { Location: externalUrl });
    response.end();
    return;
  }
  response.end(`<a id="external" href="${externalUrl}">Outside</a>
    <a id="redirect" href="/redirect">Redirect</a>
    <a id="internal" href="/settings">Settings</a>
    <a id="popup" href="${externalUrl}" target="_blank">Popup</a>`);
});
await new Promise((resolve) => trusted.listen(0, "127.0.0.1", resolve));
const trustedUrl = `http://127.0.0.1:${trusted.address().port}/`;
await writeFile(
  path.join(fixture, "main.cjs"),
  `const { app, BrowserWindow } = require('electron');
   const { registerAppNavigationGuards } = require(${JSON.stringify(path.join(desktop, "dist/window/navigation.js"))});
   app.setPath('userData', ${JSON.stringify(path.join(fixture, "profile"))});
   globalThis.navigationEvents = [];
   app.whenReady().then(async () => {
     const win = new BrowserWindow({show:false, webPreferences:{
       preload:${JSON.stringify(path.join(desktop, "dist/preload.js"))},
       contextIsolation:true, nodeIntegration:false, webviewTag:true
     }});
     registerAppNavigationGuards(win.webContents, ${JSON.stringify(trustedUrl)});
     for (const name of ['will-navigate', 'will-redirect']) {
       win.webContents.on(name, (event,url) => globalThis.navigationEvents.push({name,url,blocked:event.defaultPrevented}));
     }
     await win.loadURL(${JSON.stringify(trustedUrl)});
   });`,
);

let electron;
try {
  electron = await _electron.launch({
    args: [path.join(fixture, "main.cjs")],
    ...(process.env.ELECTRON_EXECUTABLE ? { executablePath: process.env.ELECTRON_EXECUTABLE } : {}),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
  });
  const page = await electron.firstWindow();
  await page.waitForURL(trustedUrl);
  await page.waitForLoadState("domcontentloaded");
  assert.equal(await page.evaluate(() => typeof window.paseoDesktop.invoke), "function");

  // Electron cancels these in the main process. Playwright's navigation watcher
  // otherwise waits for a document load that must never happen.
  await page.evaluate(() => document.querySelector("#external").click());
  await expect
    .poll(() => electron.evaluate(() => globalThis.navigationEvents.at(-1)))
    .toEqual({ name: "will-navigate", url: externalUrl, blocked: true });
  assert.equal(page.url(), trustedUrl);

  await page.evaluate(() => document.querySelector("#redirect").click());
  await expect
    .poll(() => electron.evaluate(() => globalThis.navigationEvents.at(-1)))
    .toEqual({ name: "will-redirect", url: externalUrl, blocked: true });
  assert.equal(page.url(), trustedUrl);

  await page.evaluate(() => document.querySelector("#internal").click());
  await page.waitForURL(`${trustedUrl}settings`);
  assert.equal(await page.evaluate(() => typeof window.paseoDesktop.invoke), "function");

  assert.equal(await page.evaluate((url) => window.open(url) === null, externalUrl), true);
  assert.equal(
    await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
    1,
  );
  assert.equal(externalRequests, 0);
  console.log("Main-window navigation, redirects, popup isolation and application routes passed.");
} finally {
  await electron?.close();
  await Promise.all([
    new Promise((resolve) => trusted.close(resolve)),
    new Promise((resolve) => external.close(resolve)),
  ]);
  await rm(fixture, { recursive: true, force: true });
}
