import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const consumers = ["metro", "@react-native/metro-config/node_modules/metro"];

function malformedImages() {
  const icns = Buffer.alloc(16);
  icns.write("icns");
  icns.writeUInt32BE(16, 4);
  icns.write("icp4", 8);
  const jxl = Buffer.alloc(32);
  jxl.writeUInt32BE(12, 0);
  jxl.write("JXL ", 4);
  jxl.writeUInt32BE(12, 12);
  jxl.write("ftypjxl ", 16);
  jxl.write("jxlp", 28);
  const heif = Buffer.alloc(20);
  heif.writeUInt32BE(12, 0);
  heif.write("ftypheic", 4);
  heif.write("meta", 16);
  return { icns, jxl, heif };
}

for (const consumer of consumers) {
  const modulePath = new URL(`../node_modules/${consumer}/src/Assets.js`, import.meta.url).pathname;
  for (const [format, input] of Object.entries(malformedImages())) {
    test(`${consumer} rejects malformed ${format} bytes labeled as PNG`, () => {
      // A child-process deadline keeps a regressed parser from hanging the test runner.
      const script = `
        const { getAssetSize } = require(${JSON.stringify(modulePath)});
        try {
          getAssetSize('png', Buffer.from(${JSON.stringify(input.toString("base64"))}, 'base64'), 'fixture.png');
          process.exitCode = 1;
        } catch { process.stdout.write('rejected'); }
      `;
      assert.equal(
        execFileSync(process.execPath, ["--max-old-space-size=32", "-e", script], {
          timeout: 2000,
          encoding: "utf8",
          maxBuffer: 4096,
        }),
        "rejected",
      );
    });
  }
  test(`${consumer} preserves ordinary PNG and multi-image ICNS dimensions`, () => {
    const { getAssetSize } = require(modulePath);
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7xkAAAAASUVORK5CYII=",
      "base64",
    );
    assert.deepEqual(getAssetSize("png", png, "pixel.png"), { width: 1, height: 1 });
    const icons = Buffer.alloc(24);
    icons.write("icns");
    icons.writeUInt32BE(24, 4);
    icons.write("icp4", 8);
    icons.writeUInt32BE(8, 12);
    icons.write("icp5", 16);
    icons.writeUInt32BE(8, 20);
    assert.deepEqual(getAssetSize("png", icons, "icons.png"), { width: 16, height: 16 });
  });
}
