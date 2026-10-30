import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import type { ExecutionInstallation } from "@getpaseo/protocol/execution-installation";
import { prepareWebUiHtml } from "../web-ui.js";
import { createInstallationNameStore } from "./installation-name.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function store() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "installation-name-"));
  dirs.push(dir);
  return { dir, names: createInstallationNameStore(dir) };
}

test("an unset or cleared name falls back to the default", () => {
  const { names } = store();
  expect(names.read()).toBeUndefined();
  expect(names.write("  Vorteo Lab  ")).toBe("Vorteo Lab");
  expect(names.read()).toBe("Vorteo Lab");
  expect(names.write(null)).toBeUndefined();
  expect(names.read()).toBeUndefined();
});

test("a damaged file never blocks the page, and overlong names are refused", () => {
  const { dir, names } = store();
  writeFileSync(path.join(dir, "installation-name.json"), "{not json");
  expect(names.read()).toBeUndefined();
  expect(() => names.write("x".repeat(41))).toThrow();
});

test("the tab title names the installation, escaped", async () => {
  const installation = {
    version: 1,
    installationId: "791360b7-cb3f-4179-a4d0-fdce8800e2f2",
    name: "Lab <M5>",
    origin: "https://lab.example.test",
    environments: [],
  } as unknown as ExecutionInstallation;
  const result = await prepareWebUiHtml({
    html: "<html><head><title>Vorteo</title></head><body></body></html>",
    req: { headers: { "accept-encoding": "identity" }, protocol: "https" },
    label: "Vorteo",
    installation,
  });
  const html = result.body.toString("utf8");
  expect(html).toContain("<title>Lab &lt;M5&gt;</title>");
  expect(html).toContain('"name":"Lab \\u003CM5\\u003E"');
});
