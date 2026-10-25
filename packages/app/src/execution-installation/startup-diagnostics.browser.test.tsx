import { afterEach, expect, inject, test } from "vitest";
import { page } from "vitest/browser";

const frames: HTMLIFrameElement[] = [];
afterEach(async () => {
  for (const frame of frames.splice(0)) frame.remove();
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

async function openLoader() {
  const origin = new URL(inject("passwordlessRelayUrl").replace("ws:", "http:")).origin;
  const html = await fetch(`${origin}/startup-fixture`).then((response) => response.text());
  const frame = document.createElement("iframe");
  frame.style.cssText = "position:fixed;inset:0;width:100%;height:100%;border:0";
  frame.allow = "clipboard-write 'none'";
  frame.srcdoc = html.replace("<head>", `<head><base href="${origin}/">`);
  frames.push(frame);
  document.body.appendChild(frame);
  await expect
    .poll(() => frame.contentDocument?.getElementById("boot-diagnostics")?.textContent)
    .toContain("HTML and diagnostic script loaded");
  const doc = frame.contentDocument;
  if (!doc) throw new Error("Startup document missing");
  return { doc, origin };
}

test.each([390, 1133])(
  "the real HTML loader exposes bounded diagnostics and controls at width %s without an app bundle",
  async (width) => {
    await page.viewport(width, 844);
    const { doc } = await openLoader();
    await expect
      .poll(() => doc.getElementById("boot-help")?.hidden, { timeout: 15000 })
      .toBe(false);
    const check = doc.querySelector<HTMLButtonElement>("#boot-check");
    if (!check) throw new Error("Endpoint button missing");
    check.click();
    expect(check.disabled).toBe(true);
    await expect
      .poll(() => doc.getElementById("boot-diagnostics")?.textContent)
      .toContain("Passed — installation endpoint responded");
    expect(check.disabled).toBe(false);
    expect(doc.getElementById("boot-diagnostics")?.textContent).toContain(
      "Unknown — requires the app connection",
    );
    expect(check.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    const status = doc.getElementById("boot-status");
    if (!status) throw new Error("Startup status missing");
    expect(status.getBoundingClientRect().right).toBeLessThanOrEqual(width);
    expect(status.getBoundingClientRect().left).toBeGreaterThanOrEqual(0);
    const copy = doc.getElementById("boot-copy");
    if (!copy) throw new Error("Copy action missing");
    copy.scrollIntoView({ block: "nearest" });
    expect(copy.getBoundingClientRect().bottom).toBeLessThanOrEqual(844);
    expect(copy.getBoundingClientRect().top).toBeGreaterThanOrEqual(0);
    await page.screenshot({ path: `startup-diagnostics-${width}.png` });
  },
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
