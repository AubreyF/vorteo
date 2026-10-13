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
  `const { app, BrowserWindow, session, dialog } = require('electron');
   const { registerAppNavigationGuards } = require(${JSON.stringify(path.join(desktop, "dist/window/navigation.js"))});
   const { handleDesktopCommand, registerTrustedDesktopWindow } = require(${JSON.stringify(path.join(desktop, "dist/desktop-ipc.js"))});
   const { createBrowserPermissionStore } = require(${JSON.stringify(path.join(desktop, "dist/features/browser-permissions.js"))});
   const { installBrowserPermissionHandlers } = require(${JSON.stringify(path.join(desktop, "dist/features/browser-permissions-electron.js"))});
   app.setPath('userData', ${JSON.stringify(path.join(fixture, "profile"))});
   app.commandLine.appendSwitch('use-fake-device-for-media-stream');
   globalThis.navigationEvents = [];
   globalThis.commandCalls = 0;
   handleDesktopCommand('paseo:invoke', (_event, command) => {
     if (command !== 'security-probe') throw new Error('Unexpected test command');
     globalThis.commandCalls++;
     return 'allowed';
   });
   app.whenReady().then(async () => {
     globalThis.permissionPrompts = [];
     dialog.showMessageBox = async (...args) => {
       globalThis.permissionPrompts.push(args.at(-1));
       return { response: 0, checkboxChecked: true };
     };
     globalThis.permissionStore = await createBrowserPermissionStore(app.getPath('userData'));
     installBrowserPermissionHandlers(session.fromPartition('persist:paseo-browser'), globalThis.permissionStore);
     const win = new BrowserWindow({show:false, webPreferences:{
       preload:${JSON.stringify(path.join(desktop, "dist/preload.js"))},
       contextIsolation:true, nodeIntegration:false, webviewTag:true
     }});
     registerTrustedDesktopWindow(win.webContents, ${JSON.stringify(trustedUrl)});
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
  assert.equal(await page.evaluate(() => window.paseoDesktop.invoke("security-probe")), "allowed");

  const strangerResult = await electron.evaluate(
    async ({ BrowserWindow }, input) => {
      const stranger = new BrowserWindow({
        show: false,
        webPreferences: { preload: input.preload, contextIsolation: true, nodeIntegration: false },
      });
      try {
        await stranger.loadURL(input.url);
        return await stranger.webContents.executeJavaScript(
          "window.paseoDesktop.invoke('security-probe').then(() => 'unexpected success', error => error.message)",
        );
      } finally {
        stranger.destroy();
      }
    },
    { url: trustedUrl, preload: path.join(desktop, "dist/preload.js") },
  );
  assert.match(strangerResult, /Desktop commands require the trusted application window/);

  // Main-process loadURL bypasses navigation events. The independent IPC gate
  // must still reject a registered renderer whose current document is outside.
  await electron.evaluate(async ({ BrowserWindow }, url) => {
    await BrowserWindow.getAllWindows()[0].loadURL(url);
  }, externalUrl);
  await assert.rejects(
    page.evaluate(() => window.paseoDesktop.invoke("security-probe")),
    /Desktop commands require the trusted application window/,
  );
  assert.equal(await electron.evaluate(() => globalThis.commandCalls), 1);
  // Exercise real Chromium permission APIs in the embedded-site partition. All
  // requests are denied by the simulated native dialog; no device is opened.
  const browserPagePromise = electron.waitForEvent("window");
  await electron.evaluate(async ({ BrowserWindow }, url) => {
    globalThis.permissionWindow = new BrowserWindow({
      show: false,
      webPreferences: {
        partition: "persist:paseo-browser",
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    await globalThis.permissionWindow.loadURL(url);
  }, trustedUrl);
  const browserPage = await browserPagePromise;
  await browserPage.waitForURL(trustedUrl);
  const permissionStates = () =>
    browserPage.evaluate(async () => {
      const result = {};
      for (const name of ["camera", "microphone", "geolocation", "notifications"]) {
        result[name] = (await navigator.permissions.query({ name })).state;
      }
      return result;
    });
  assert.deepEqual(await permissionStates(), {
    camera: "denied",
    microphone: "denied",
    geolocation: "denied",
    notifications: "denied",
  });
  const requests = await browserPage.evaluate(async () => ({
    notifications: await Notification.requestPermission(),
    microphone: await navigator.mediaDevices.getUserMedia({ audio: true }).then(
      () => "unexpected access",
      (error) => error.name,
    ),
    camera: await navigator.mediaDevices.getUserMedia({ video: true }).then(
      () => "unexpected access",
      (error) => error.name,
    ),
    location: await new Promise((resolve) =>
      navigator.geolocation.getCurrentPosition(
        () => resolve("unexpected access"),
        (error) => resolve(error.code),
      ),
    ),
  }));
  assert.deepEqual(requests, {
    notifications: "denied",
    microphone: "NotAllowedError",
    camera: "NotAllowedError",
    location: 1,
  });
  const prompts = await electron.evaluate(() => globalThis.permissionPrompts);
  assert.equal(prompts.length, 4);
  assert.ok(
    prompts.every(
      (prompt) =>
        prompt.checkboxLabel === "Remember for this site" &&
        prompt.checkboxChecked === false &&
        prompt.defaultId === 0,
    ),
  );
  await browserPage.reload();
  await browserPage.evaluate(() =>
    navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => {}),
  );
  assert.equal(await electron.evaluate(() => globalThis.permissionPrompts.length), 4);
  await electron.evaluate(async () => {
    await globalThis.permissionStore.reset();
  });
  await browserPage.reload();
  await browserPage.evaluate(() =>
    navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => {}),
  );
  assert.equal(await electron.evaluate(() => globalThis.permissionPrompts.length), 5);
  // A stored camera choice affects query state, never microphone and never a
  // different origin. Querying does not attempt to access either device.
  await electron.evaluate(async (_runtime, url) => {
    const origin = new URL(url).origin;
    await globalThis.permissionStore.remember(
      { origin, topOrigin: origin },
      "camera",
      true,
      globalThis.permissionStore.generation,
    );
  }, trustedUrl);
  await browserPage.reload();
  assert.deepEqual(await permissionStates(), {
    camera: "granted",
    microphone: "denied",
    geolocation: "denied",
    notifications: "denied",
  });
  await browserPage.goto(externalUrl);
  assert.equal((await permissionStates()).camera, "denied");
  await browserPage.evaluate((url) => {
    const frame = document.createElement("iframe");
    frame.allow = "camera; microphone";
    frame.src = url;
    document.body.append(frame);
  }, trustedUrl);
  await expect
    .poll(() =>
      browserPage
        .frames()
        .find((frame) => frame.url() === trustedUrl)
        ?.url(),
    )
    .toBe(trustedUrl);
  const embedded = browserPage.frames().find((frame) => frame.url() === trustedUrl);
  assert.equal(
    await embedded.evaluate(
      async () => (await navigator.permissions.query({ name: "camera" })).state,
    ),
    "denied",
  );
  assert.equal(
    await embedded.evaluate(() =>
      navigator.mediaDevices.getUserMedia({ video: true }).then(
        () => "unexpected access",
        (error) => error.name,
      ),
    ),
    "NotAllowedError",
  );
  const embeddedPrompt = await electron.evaluate(() => globalThis.permissionPrompts.at(-1));
  assert.ok(embeddedPrompt.message.startsWith(new URL(trustedUrl).origin));
  assert.ok(embeddedPrompt.detail.includes(new URL(externalUrl).origin));
  await electron.evaluate(async () => {
    await globalThis.permissionStore.reset();
  });
  await browserPage.goto(trustedUrl);
  assert.equal((await permissionStates()).camera, "denied");
  console.log("Navigation, redirects, popups and trusted desktop command boundaries passed.");
  console.log(
    "Site prompts, remembered blocks, permission isolation and reset passed without device access.",
  );
} finally {
  await electron?.close();
  await Promise.all([
    new Promise((resolve) => trusted.close(resolve)),
    new Promise((resolve) => external.close(resolve)),
  ]);
  await rm(fixture, { recursive: true, force: true });
}
