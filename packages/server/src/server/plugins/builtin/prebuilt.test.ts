import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PREBUILT_BUNDLES_FILE, readPrebuiltBundles, writePrebuiltBundles } from "./prebuilt.js";

const bundles = { serverBundle: "(function(require){return {}})", clientBundle: null };

describe("prebuilt built-in plugin bundles", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "prebuilt-plugin-"));
    await writeFile(path.join(directory, "paseo.plugin.json"), '{"id":"example"}');
    await mkdir(path.join(directory, "server"));
    await writeFile(path.join(directory, "server", "index.ts"), "export {};\n");
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("loads bundles written for the same source and daemon version", async () => {
    await writePrebuiltBundles(directory, "1.0.0", bundles);

    await expect(readPrebuiltBundles(directory, "1.0.0")).resolves.toEqual({
      status: "loaded",
      bundles,
    });
  });

  it("reports a missing prebuilt file so the daemon compiles", async () => {
    await expect(readPrebuiltBundles(directory, "1.0.0")).resolves.toEqual({ status: "missing" });
  });

  it.each([
    [
      "an edited source file",
      () => writeFile(path.join(directory, "server", "index.ts"), "export const x = 1;\n"),
    ],
    ["an added source file", () => writeFile(path.join(directory, "server", "extra.ts"), "")],
    [
      "a renamed source file",
      async () => {
        await rm(path.join(directory, "server", "index.ts"));
        await writeFile(path.join(directory, "server", "main.ts"), "export {};\n");
      },
    ],
  ])("refuses bundles after %s", async (_label, change) => {
    await writePrebuiltBundles(directory, "1.0.0", bundles);
    await change();

    await expect(readPrebuiltBundles(directory, "1.0.0")).resolves.toEqual({
      status: "stale",
      reason: "plugin source or daemon version changed",
    });
  });

  it("refuses bundles built for another daemon version", async () => {
    await writePrebuiltBundles(directory, "1.0.0", bundles);

    await expect(readPrebuiltBundles(directory, "1.0.1")).resolves.toMatchObject({
      status: "stale",
    });
  });

  it("refuses a bundle whose content no longer matches its digest", async () => {
    await writePrebuiltBundles(directory, "1.0.0", bundles);
    const file = path.join(directory, PREBUILT_BUNDLES_FILE);
    const record = JSON.parse(await readFile(file, "utf8"));
    await writeFile(file, JSON.stringify({ ...record, serverBundle: "(function(){})" }));

    await expect(readPrebuiltBundles(directory, "1.0.0")).resolves.toEqual({
      status: "stale",
      reason: "bundle digest mismatch",
    });
  });

  it("refuses an unreadable prebuilt file", async () => {
    await writeFile(path.join(directory, PREBUILT_BUNDLES_FILE), "{not json");

    await expect(readPrebuiltBundles(directory, "1.0.0")).resolves.toEqual({
      status: "stale",
      reason: "unreadable prebuilt file",
    });
  });
});
