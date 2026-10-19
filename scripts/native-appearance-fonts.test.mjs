import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../packages/app");
const require = createRequire(resolve(appRoot, "package.json"));
const config = require("./native-appearance-fonts.cjs");
const manifest = require("./assets/appearance-fonts/manifest.json");
const { getXmlSpecs, groupByFamily, generateFontManagerCalls } = require(
  resolve(dirname(require.resolve("expo-font")), "../plugin/build/withFontsAndroid.js"),
);

test("native appearance assets retain their licensed, pinned bytes", () => {
  assert.equal(manifest.nativeFonts.length, 20);
  for (const asset of manifest.nativeFonts) {
    const bytes = readFileSync(resolve(appRoot, "assets/appearance-fonts", asset.file));
    assert.equal(bytes.length, asset.bytes, asset.file);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), asset.sha256, asset.file);
    assert.equal(bytes.readUInt32BE(0), 0x00010000, "Native assets must be TrueType fonts");
  }
  for (const license of manifest.files.filter((entry) => entry.file.endsWith("OFL.txt"))) {
    const bytes = readFileSync(resolve(appRoot, "assets/appearance-fonts", license.file));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), license.sha256);
  }
});

test("Expo emits distinct Android weight resources and registers authored family names", () => {
  const families = groupByFamily(config.android.fonts);
  const specs = getXmlSpecs("/font-resources", families);
  assert.equal(specs.length, 4);
  const resourceNames = new Set();
  for (const spec of specs) {
    const entries = spec.xml["font-family"].font.map((entry) => entry.$);
    assert.deepEqual(
      entries.map((entry) => entry["app:fontWeight"]),
      ["300", "400", "500", "600", "700"],
    );
    for (const entry of entries) {
      assert.equal(entry["app:fontStyle"], "normal");
      assert.match(entry["app:font"], /^@font\/[a-z0-9_]+$/);
      assert.ok(!resourceNames.has(entry["app:font"]));
      resourceNames.add(entry["app:font"]);
    }
  }
  const registration = generateFontManagerCalls(families, "kt").join("\n");
  for (const family of ["Barlow", "Barlow Condensed", "Manrope", "Space Grotesk"]) {
    assert.ok(registration.includes(`"${family}"`), family);
  }
  assert.equal(config.ios.fonts.length, 20);
  assert.deepEqual(
    new Set(config.ios.fonts),
    new Set(
      config.android.fonts.flatMap((family) => family.fontDefinitions.map((font) => font.path)),
    ),
  );
});
