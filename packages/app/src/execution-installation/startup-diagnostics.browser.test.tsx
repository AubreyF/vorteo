import { afterEach, expect, inject, test } from "vitest";
import { page } from "vitest/browser";
import { formatDuration } from "@/utils/time";

const frames: HTMLIFrameElement[] = [];
afterEach(async () => {
  for (const frame of frames.splice(0)) frame.remove();
  localStorage.removeItem("vorteo-data-saver-v1");
  const origin = new URL(inject("passwordlessRelayUrl").replace("ws:", "http:")).origin;
  await fetch(`${origin}/startup-test-mode`, { method: "POST", body: "normal" });
});

test.each([
  ["invalid", "Failed — response was not valid installation health"],
  ["disconnected", "Failed — network request rejected; no timeout was observed"],
  ["slow", "Timed out — no complete health response after 8 seconds"],
])(
  "health checks distinguish %s responses from a deadline",
  async (mode, expected) => {
    const { doc, origin } = await openLoader();
    await fetch(`${origin}/startup-test-mode`, { method: "POST", body: mode });
    doc.getElementById("boot-check")?.click();
    await expect
      .poll(() => doc.getElementById("boot-diagnostics")?.textContent, { timeout: 10000 })
      .toContain(expected);
  },
  15000,
);

test("an interrupted entry script retries once without duplicating execution or reloading the page", async () => {
  const { doc, origin } = await openLoader();
  const script = doc.createElement("script");
  script.src = `${origin}/_expo/static/js/web/interrupted-0123456789abcdef.js`;
  script.crossOrigin = "anonymous";
  script.referrerPolicy = "no-referrer";
  script.nonce = "startup-test-nonce";
  const bytes = new TextEncoder().encode(
    "window.__startupFixtureEntryCount = (window.__startupFixtureEntryCount || 0) + 1;",
  );
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  script.integrity = `sha256-${btoa(String.fromCharCode(...hash))}`;
  doc.body.appendChild(script);
  await expect
    .poll(() => doc.getElementById("boot-diagnostics")?.textContent)
    .toContain("Failed — interface script download failed");
  const retry = doc.querySelector<HTMLButtonElement>("#boot-retry-script");
  if (!retry) throw new Error("Targeted retry action missing");
  expect(retry.hidden).toBe(false);
  retry.click();
  await expect.poll(() => Reflect.get(doc.defaultView!, "__startupFixtureEntryCount")).toBe(1);
  expect(retry.disabled).toBe(true);
  const replacement = Array.from(doc.querySelectorAll("script")).find(
    (entry) => entry.src === script.src,
  );
  expect(replacement).not.toBe(script);
  expect(replacement?.integrity).toBe(script.integrity);
  expect(replacement?.nonce).toBe(script.nonce);
  expect(replacement?.crossOrigin).toBe("anonymous");
  expect(replacement?.referrerPolicy).toBe("no-referrer");
  retry.click();
  expect(Reflect.get(doc.defaultView!, "__startupFixtureEntryCount")).toBe(1);
  expect(doc.getElementById("boot-overlay")).not.toBeNull();
});

test("execution errors retain safe location details without exposing private exception text or offering download retry", async () => {
  const { doc, origin } = await openLoader();
  const script = doc.createElement("script");
  script.src = `${origin}/_expo/static/js/web/throws-0123456789abcdef.js`;
  script.crossOrigin = "anonymous";
  doc.body.appendChild(script);
  await expect
    .poll(() => doc.getElementById("boot-diagnostics")?.textContent)
    .toContain("Failed — interface JavaScript raised TypeError");
  doc.getElementById("boot-copy")?.click();
  const report = doc.querySelector<HTMLTextAreaElement>("#boot-report");
  await expect.poll(() => report?.value).toContain('"errorName": "TypeError"');
  expect(report?.value).toContain("throws-0123456789abcdef.js");
  expect(report?.value).not.toContain("private-session-value-must-not-leak");
  expect(doc.querySelector<HTMLButtonElement>("#boot-retry-script")?.hidden).toBe(true);
});

test("recognized engine errors preserve a concrete safe message and the failed asset path", async () => {
  const { doc, origin } = await openLoader();
  const script = doc.createElement("script");
  script.src = `${origin}/_expo/static/js/web/safe-error-0123456789abcdef.js`;
  script.crossOrigin = "anonymous";
  doc.body.appendChild(script);
  await expect
    .poll(() => doc.getElementById("boot-diagnostics")?.textContent)
    .toContain("JavaScript raised TypeError");
  doc.getElementById("boot-copy")?.click();
  const report = doc.querySelector<HTMLTextAreaElement>("#boot-report");
  await expect.poll(() => report?.value).toContain("Cannot convert undefined or null to object");
  expect(report?.value).toContain("safe-error-0123456789abcdef.js");
});

async function openLoader(fixturePath = "/startup-fixture", setup = "") {
  const origin = new URL(inject("passwordlessRelayUrl").replace("ws:", "http:")).origin;
  const html = await fetch(`${origin}${fixturePath}`).then((response) => response.text());
  const frame = document.createElement("iframe");
  frame.style.cssText = "position:fixed;inset:0;width:100%;height:100%;border:0";
  frame.allow = "clipboard-write 'none'";
  frame.srcdoc = html.replace("<head>", `<head><base href="${origin}/"><script>${setup}</script>`);
  frames.push(frame);
  document.body.appendChild(frame);
  await expect
    .poll(() => frame.contentDocument?.getElementById("boot-diagnostics")?.textContent)
    .toContain("HTML and diagnostic script loaded");
  const doc = frame.contentDocument;
  if (!doc) throw new Error("Startup document missing");
  return { doc, origin };
}

test("delayed startup probes once and reports an in-flight deferred entry before its timing exists", async () => {
  const origin = new URL(inject("passwordlessRelayUrl").replace("ws:", "http:")).origin;
  await fetch(`${origin}/startup-test-mode`, { method: "POST", body: "normal" });
  const { doc } = await openLoader("/startup-held-fixture");
  await expect
    .poll(() => doc.getElementById("boot-diagnostics")?.textContent, { timeout: 13000 })
    .toContain("Passed — installation endpoint responded");
  doc.getElementById("boot-copy")?.click();
  const reportText = doc.querySelector<HTMLTextAreaElement>("#boot-report");
  await expect.poll(() => reportText?.value).toContain('"diagnosticsRevision": 3');
  const report: unknown = JSON.parse(reportText?.value ?? "null");
  expect(report).toMatchObject({
    assetError: null,
    scriptResources: [],
    endpointProbe: { attempts: 1, trigger: "automatic", state: "complete" },
    scriptElements: [
      {
        path: "/_expo/static/js/web/held-0123456789abcdef.js",
        defer: true,
        loadEventObserved: false,
        timingEntryPresent: false,
      },
    ],
  });
  expect(
    await fetch(`${origin}/startup-fixture-stats`).then((response) => response.json()),
  ).toEqual({ startupHealthRequests: 1, heldScriptRequests: 1 });
  await fetch(`${origin}/startup-release-held-script`, { method: "POST" });
  await expect.poll(() => Reflect.get(doc.defaultView!, "__startupHeldEntryCount")).toBe(1);
  expect(
    await fetch(`${origin}/startup-fixture-stats`).then((response) => response.json()),
  ).toEqual({ startupHealthRequests: 1, heldScriptRequests: 1 });
}, 25000);

test("a completed startup cancels the delayed automatic probe", async () => {
  const { doc, origin } = await openLoader();
  await fetch(`${origin}/startup-test-mode`, { method: "POST", body: "normal" });
  const finish: unknown = Reflect.get(doc.defaultView!, "__vorteoFinishBoot");
  if (typeof finish !== "function") throw new Error("Boot completion hook missing");
  finish();
  await new Promise((resolve) => setTimeout(resolve, 4000));
  expect(
    await fetch(`${origin}/startup-fixture-stats`).then((response) => response.json()),
  ).toEqual({ startupHealthRequests: 0, heldScriptRequests: 0 });
}, 15000);

test.each([
  [390, 620],
  [1133, 844],
  [1133, 1200],
])(
  "the real HTML loader exposes bounded diagnostics and controls at width %s and height %s without an app bundle",
  async (width, height) => {
    await page.viewport(width, height);
    const { doc } = await openLoader("/startup-fixture", controlledClock);
    Reflect.set(
      doc.defaultView!,
      "__startupNow",
      Number(Reflect.get(doc.defaultView!, "__startupNow")) + 11000,
    );
    doc.defaultView!.dispatchEvent(new Event("pageshow"));
    await expect.poll(() => doc.getElementById("boot-help")?.hidden).toBe(false);
    const help = doc.getElementById("boot-help");
    if (!help) throw new Error("Diagnostic panel missing");
    await Promise.all(help.getAnimations().map((animation) => animation.finished));
    expect(getComputedStyle(help).opacity).toBe("1");
    const check = doc.querySelector<HTMLButtonElement>("#boot-check");
    if (!check) throw new Error("Endpoint button missing");
    check.click();
    await expect
      .poll(() => doc.getElementById("boot-diagnostics")?.textContent)
      .toContain("Passed — installation endpoint responded");
    expect(check.disabled).toBe(false);
    expect(doc.getElementById("boot-connection-details")?.textContent).toContain(
      "Unknown — requires the app connection",
    );
    expect(check.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    const status = doc.getElementById("boot-status");
    if (!status) throw new Error("Startup status missing");
    expect(status.getBoundingClientRect().right).toBeLessThanOrEqual(width);
    expect(status.getBoundingClientRect().left).toBeGreaterThanOrEqual(0);
    const copy = doc.getElementById("boot-copy");
    if (!copy) throw new Error("Copy action missing");
    const saver = doc.getElementById("boot-data-saver");
    if (!saver) throw new Error("Data saver action missing");
    const controls = Array.from(help.querySelectorAll("button")).filter((button) => !button.hidden);
    expect(controls.map((button) => button.textContent?.replace(/\s+/g, " ").trim())).toEqual([
      "Enable data saver",
      "Check endpoint",
      "Copy diagnostics",
      "Reload",
    ]);
    const statusBounds = status.getBoundingClientRect();
    if (height >= 844) {
      expect(statusBounds.height).toBeLessThan(height);
      expect(Math.abs(statusBounds.top - (height - statusBounds.bottom))).toBeLessThan(1);
    }
    const rows: DOMRect[][] = [];
    for (const button of controls) {
      const bounds = button.getBoundingClientRect();
      const row = rows.find((entry) => Math.abs(entry[0].top - bounds.top) < 1);
      if (row) row.push(bounds);
      else rows.push([bounds]);
    }
    for (const row of rows) {
      for (let index = 1; index < row.length; index++) {
        expect(row[index].left - row[index - 1].right).toBeCloseTo(12, 1);
      }
    }
    for (let index = 1; index < rows.length; index++) {
      expect(rows[index][0].top - rows[index - 1][0].bottom).toBeCloseTo(12, 1);
    }
    const icon = doc.getElementById("boot-data-saver-icon")!;
    expect(icon.getBoundingClientRect().width).toBe(16);
    expect(getComputedStyle(icon).visibility).toBe("visible");
    expect(getComputedStyle(doc.getElementById("boot-data-saver-check")!).visibility).toBe(
      "hidden",
    );
    const measurements = [];
    // System fonts can place a control on a fractional pixel while scrolling can
    // round to an integer. Exercise those positions without depending on the host's font.
    for (const inset of [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875]) {
      help.style.paddingTop = `${inset}px`;
      status.scrollTop = 0;
      copy.scrollIntoView({ block: "nearest" });
      expect(copy.getBoundingClientRect().bottom).toBeLessThanOrEqual(height);
      expect(copy.getBoundingClientRect().top).toBeGreaterThanOrEqual(0);
      measurements.push({
        inset,
        bottom: copy.getBoundingClientRect().bottom,
        scrollTop: status.scrollTop,
        clientHeight: status.clientHeight,
      });
      for (const button of controls) {
        button.focus();
        const rect = button.getBoundingClientRect();
        expect(rect.height).toBeGreaterThanOrEqual(44);
        expect(rect.left).toBeGreaterThanOrEqual(0);
        expect(rect.right).toBeLessThanOrEqual(width);
        expect(rect.top).toBeGreaterThanOrEqual(0);
        expect(rect.bottom).toBeLessThanOrEqual(height);
        expect(doc.activeElement).toBe(button);
      }
    }
    console.info("Startup control scroll geometry", { width, height, measurements });
    await page.screenshot({ path: `startup-diagnostics-${width}.png` });
  },
  22000,
);

test("script load failures remain actionable and clipboard denial exposes a sanitized selectable report", async () => {
  const { doc, origin } = await openLoader();
  const script = doc.createElement("script");
  script.src = `${origin}/missing-bundle.js?token=must-not-leak`;
  doc.body.appendChild(script);
  await expect
    .poll(() => doc.getElementById("boot-diagnostics")?.textContent)
    .toContain("interface script download failed");
  doc.getElementById("boot-copy")?.click();
  await expect
    .poll(() => doc.getElementById("boot-copy-feedback")?.textContent)
    .toContain("Clipboard unavailable");
  const report = doc.querySelector<HTMLTextAreaElement>("#boot-report");
  if (!report) throw new Error("Selectable report missing");
  expect(report.hidden).toBe(false);
  expect(report.value).toContain("vorteo-startup-diagnostics-v1");
  expect(report.value).not.toContain("must-not-leak");
  expect(report.value).not.toContain(origin);
  expect(report.value).toContain("Unknown — requires the app connection");
});

const controlledClock =
  "window.__startupNow=Date.now(); Date.now=function(){return window.__startupNow;};";

test.each([
  [390, 620],
  [1280, 900],
])(
  "three-second reveal keeps the logo and content on one continuous transition at %s by %s",
  async (width, height) => {
    await page.viewport(width, height);
    const { doc, origin } = await openLoader("/startup-held-fixture", controlledClock);
    const win = doc.defaultView!;
    await expect
      .poll(() => fetch(`${origin}/startup-fixture-stats`).then((r) => r.json()))
      .toEqual({ startupHealthRequests: 0, heldScriptRequests: 1 });
    const emblem = doc.querySelector<HTMLElement>(".boot-emblem");
    const help = doc.querySelector<HTMLElement>("#boot-help");
    if (!emblem || !help) throw new Error("Startup transition elements missing");
    const initial = emblem.getBoundingClientRect();
    const started = Number(Reflect.get(win, "__startupNow"));
    Reflect.set(win, "__startupNow", started + 2999);
    win.dispatchEvent(new Event("pageshow"));
    expect(help.hidden).toBe(true);
    expect(await fetch(`${origin}/startup-fixture-stats`).then((r) => r.json())).toEqual({
      startupHealthRequests: 0,
      heldScriptRequests: 1,
    });
    Reflect.set(win, "__startupNow", started + 3000);
    win.dispatchEvent(new Event("pageshow"));
    expect(help.hidden).toBe(false);
    const animations = doc
      .getAnimations()
      .filter(
        (animation) =>
          animation instanceof win.CSSAnimation &&
          ["boot-emblem-reveal", "boot-reveal"].includes(animation.animationName),
      );
    expect(animations).toHaveLength(2);
    await Promise.all(animations.map((animation) => animation.ready));
    expect(animations[0].startTime).toBe(animations[1].startTime);
    for (const animation of animations) animation.pause();
    const geometry = [];
    for (const elapsed of [0, 80, 160, 240, 320]) {
      for (const animation of animations) animation.currentTime = elapsed;
      const rect = emblem.getBoundingClientRect();
      geometry.push({
        elapsed,
        x: rect.x,
        y: rect.y,
        width: rect.width,
        bottom: rect.bottom,
        helpY: help.getBoundingClientRect().y,
        opacity: Number(win.getComputedStyle(help).opacity),
      });
      if ([0, 160, 320].includes(elapsed))
        await page.screenshot({ path: `startup-transition-${width}-${elapsed}.png` });
    }
    expect(geometry[0].width).toBeCloseTo(initial.width, 1);
    expect(geometry[0].x).toBeCloseTo(initial.x, 1);
    expect(geometry[0].y).toBeCloseTo(initial.y, 1);
    expect(geometry[4].width).toBeCloseTo(80, 1);
    expect(geometry[4].opacity).toBe(1);
    const finalGap = geometry[4].helpY - geometry[4].bottom;
    for (const frame of geometry) expect(frame.helpY - frame.bottom).toBeCloseTo(finalGap, 1);
    for (let index = 1; index < geometry.length; index++) {
      expect(geometry[index].width).toBeLessThan(geometry[index - 1].width);
      expect(geometry[index].y).toBeLessThan(geometry[index - 1].y);
      expect(geometry[index].opacity).toBeGreaterThan(geometry[index - 1].opacity);
      const shrinkProgress = (initial.width - geometry[index].width) / (initial.width - 80);
      expect(Math.abs(shrinkProgress - geometry[index].opacity)).toBeLessThan(0.02);
    }
    expect(doc.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    expect(
      help.querySelector<HTMLButtonElement>("#boot-copy")?.getBoundingClientRect().height,
    ).toBeGreaterThanOrEqual(44);
    console.info("Startup reveal geometry", { width, height, geometry });
    await expect
      .poll(() => doc.getElementById("boot-diagnostics")?.textContent)
      .toContain("Passed — installation endpoint responded");
  },
);

test("offline startup defers automatic probes and deduplicates repeated online/resume events", async () => {
  const { doc, origin } = await openLoader(
    "/startup-fixture",
    controlledClock +
      "window.__startupOnline=false;Object.defineProperty(navigator,'onLine',{get:function(){return window.__startupOnline;}});",
  );
  const win = doc.defaultView!;
  Reflect.set(win, "__startupNow", Number(Reflect.get(win, "__startupNow")) + 11000);
  win.dispatchEvent(new Event("pageshow"));
  expect(doc.getElementById("boot-diagnostics")?.textContent).toContain(
    "Deferred — browser reports offline",
  );
  expect(await fetch(`${origin}/startup-fixture-stats`).then((r) => r.json())).toEqual({
    startupHealthRequests: 0,
    heldScriptRequests: 0,
  });
  Reflect.set(win, "__startupOnline", true);
  for (let count = 0; count < 5; count++) {
    win.dispatchEvent(new Event("online"));
    win.dispatchEvent(new Event("pageshow"));
  }
  await expect
    .poll(() => doc.getElementById("boot-diagnostics")?.textContent)
    .toContain("Passed — installation endpoint responded");
  expect(await fetch(`${origin}/startup-fixture-stats`).then((r) => r.json())).toEqual({
    startupHealthRequests: 1,
    heldScriptRequests: 0,
  });
});

test("a foreground clock gap starts overdue checks without retrying a slow but progressing entry", async () => {
  const { doc, origin } = await openLoader("/startup-held-fixture", controlledClock);
  const win = doc.defaultView!;
  await fetch(`${origin}/startup-progress-held-script`, { method: "POST" });
  Reflect.set(win, "__startupNow", Number(Reflect.get(win, "__startupNow")) + 2000);
  doc.dispatchEvent(new Event("visibilitychange"));
  expect(await fetch(`${origin}/startup-fixture-stats`).then((r) => r.json())).toEqual({
    startupHealthRequests: 0,
    heldScriptRequests: 1,
  });
  Reflect.set(win, "__startupNow", Number(Reflect.get(win, "__startupNow")) + 1000);
  doc.dispatchEvent(new Event("visibilitychange"));
  await expect
    .poll(() => doc.getElementById("boot-diagnostics")?.textContent)
    .toContain("Passed — installation endpoint responded");
  const progress = doc.querySelector<HTMLProgressElement>("#boot-progress");
  expect(progress?.hasAttribute("value")).toBe(false);
  expect(doc.querySelector<HTMLButtonElement>("#boot-retry-script")?.hidden).toBe(true);
  doc.getElementById("boot-copy")?.click();
  const report = doc.querySelector<HTMLTextAreaElement>("#boot-report");
  await expect.poll(() => report?.value).toContain('"received": null');
  expect(report?.value).not.toContain("must-not-leak");
  await fetch(`${origin}/startup-release-held-script`, { method: "POST" });
  await expect.poll(() => Reflect.get(win, "__startupHeldEntryCount")).toBe(1);
  expect(await fetch(`${origin}/startup-fixture-stats`).then((r) => r.json())).toEqual({
    startupHealthRequests: 1,
    heldScriptRequests: 1,
  });
});

test("saved data saver skips optional fonts before app code and toggles without duplicating the pending entry", async () => {
  const { doc, origin } = await openLoader(
    "/startup-held-fixture",
    controlledClock + 'localStorage.setItem("vorteo-data-saver-v1","on");',
  );
  expect(doc.documentElement.dataset.vorteoDataSaver).toBe("true");
  expect(doc.querySelector("#vorteo-optional-fonts")?.hasAttribute("href")).toBe(false);
  expect(await fetch(`${origin}/startup-font-stats`).then((r) => r.json())).toEqual({
    requests: 0,
  });
  const button = doc.getElementById("boot-data-saver");
  if (!button) throw new Error("Data saver control missing");
  expect(button.getAttribute("aria-pressed")).toBe("true");
  expect(doc.querySelector<HTMLImageElement>(".boot-mark")?.src).toMatch(/^data:image\/svg\+xml/);
  button.click();
  expect(button.getAttribute("aria-pressed")).toBe("false");
  await expect
    .poll(async () => fetch(`${origin}/startup-font-stats`).then((r) => r.json()))
    .toEqual({ requests: 1 });
  expect(doc.getElementById("boot-data-saver-feedback")?.hidden).toBe(true);
  expect(button.textContent).toContain("Enable data saver");
  expect(getComputedStyle(doc.getElementById("boot-data-saver-check")!).visibility).toBe("hidden");
  button.click();
  expect(button.getAttribute("aria-pressed")).toBe("true");
  expect(getComputedStyle(doc.getElementById("boot-data-saver-check")!).visibility).toBe("visible");
  expect(button.nextElementSibling?.id).toBe("boot-check");
  expect(getComputedStyle(doc.getElementById("boot-data-saver-icon")!).visibility).toBe("visible");
  expect(await fetch(`${origin}/startup-fixture-stats`).then((r) => r.json())).toEqual({
    startupHealthRequests: 0,
    heldScriptRequests: 1,
  });
  await fetch(`${origin}/startup-release-held-script`, { method: "POST" });
  await expect.poll(() => Reflect.get(doc.defaultView!, "__startupHeldEntryCount")).toBe(1);
});

test("data saver reports session-only success when browser storage refuses saving", async () => {
  const { doc } = await openLoader(
    "/startup-fixture",
    'Object.defineProperty(window,"localStorage",{value:{getItem:function(){return null;},setItem:function(){throw new Error("fixture quota");}}});',
  );
  doc.getElementById("boot-data-saver")?.click();
  expect(doc.documentElement.dataset.vorteoDataSaver).toBe("true");
  expect(doc.getElementById("boot-data-saver-feedback")?.textContent).toContain(
    "Applied to this page only",
  );
});

test("the inline V vector preserves the original mark silhouette without a logo download", async () => {
  await page.viewport(390, 620);
  const { doc, origin } = await openLoader();
  const candidate = doc.querySelector<HTMLImageElement>(".boot-mark");
  if (!candidate) throw new Error("Default V mark missing");
  expect(candidate.src).toMatch(/^data:image\/svg\+xml/);
  const original = doc.createElement("img");
  const body = await fetch(`${origin}/startup-original-mark`).then((r) => r.json());
  original.src = body.dataUrl;
  await Promise.all([candidate.decode(), original.decode()]);
  function mask(image: HTMLImageElement) {
    const canvas = doc.createElement("canvas");
    canvas.width = 144;
    canvas.height = 144;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas unavailable");
    context.drawImage(image, 0, 0, 144, 144);
    const data = context.getImageData(0, 0, 144, 144).data;
    return Array.from({ length: 144 * 144 }, (_, i) => data[i * 4 + 3] > 127);
  }
  const a = mask(original),
    b = mask(candidate);
  let intersection = 0,
    union = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] || b[i]) union++;
    if (a[i] && b[i]) intersection++;
  }
  expect(union).toBeGreaterThan(100);
  // The existing traced vector allows antialiasing differences while retaining the V outline.
  expect(intersection / union).toBeGreaterThanOrEqual(0.95);
  console.info("V mark silhouette overlap", { intersection, union, ratio: intersection / union });
  original.style.cssText = "width:144px;height:144px";
  const comparison = doc.createElement("div");
  comparison.style.cssText = "display:flex;justify-content:center;gap:16px";
  comparison.append(original, candidate.cloneNode());
  const cloned = comparison.lastElementChild as HTMLElement;
  cloned.style.cssText = "position:static;width:144px;height:144px";
  doc.getElementById("boot-status")?.append(comparison);
  await page.screenshot({ path: "v-vector-comparison.png" });
});

test("elapsed time uses the shared formatter directly beneath the progress bar", async () => {
  const { doc } = await openLoader("/startup-fixture", controlledClock);
  const win = doc.defaultView!;
  const started = Number(Reflect.get(win, "__startupNow"));
  expect(doc.getElementById("boot-progress")?.nextElementSibling?.id).toBe("boot-elapsed");
  expect(doc.getElementById("boot-help")?.textContent).not.toContain("Connection details");
  expect(doc.getElementById("boot-help")?.textContent).not.toContain("Use system fonts");
  expect(doc.getElementById("boot-progress-label")).toBeNull();
  for (const elapsed of [3000, 59000, 60000, 75000, 3600000, 12530000]) {
    Reflect.set(win, "__startupNow", started + elapsed);
    win.dispatchEvent(new Event("pageshow"));
    expect(doc.getElementById("boot-elapsed")?.textContent).toBe(
      `${formatDuration(elapsed)} elapsed`,
    );
  }
});
