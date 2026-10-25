import { afterEach, expect, inject, test } from "vitest";
import { page } from "vitest/browser";

const frames: HTMLIFrameElement[] = [];
afterEach(() => {
  for (const frame of frames.splice(0)) frame.remove();
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
    .toContain("interface script could not load or execute");
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
