// The approved raster masters preserve the signature's contours and hidden turn.
// Requires ImageMagick and Potrace; macOS iconutil builds the native .icns container.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const brand = path.join(root, "packages/app/assets/brand");
const white = path.join(brand, "vorteo-white.png");
const color = path.join(brand, "vorteo-color.png");
const dark = path.join(brand, "vorteo-dark.png");
const hash = crypto.createHash("sha256").update(fs.readFileSync(white)).digest("hex").slice(0, 12);
const magick = (...args) => execFileSync("magick", args, { cwd: root });
function png(source, target, size, background = "none", badge) {
  // Existing content-addressed public URLs must retain their original bytes.
  if (target.startsWith("packages/app/public/") && fs.existsSync(path.join(root, target))) return;
  magick(
    source,
    "-background",
    background,
    "-alpha",
    background === "none" ? "on" : "remove",
    "-resize",
    `${size}x${size}`,
    ...(badge
      ? [
          "-fill",
          badge,
          "-stroke",
          background === "none" ? "#202125" : background,
          "-strokewidth",
          String(size * 0.035),
          "-draw",
          `circle ${size * 0.82},${size * 0.82} ${size * 0.98},${size * 0.82}`,
        ]
      : []),
    target,
  );
}
function svg(source, background, badge) {
  const data = fs.readFileSync(source).toString("base64");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="640" viewBox="0 0 640 640">${background ? `<rect width="640" height="640" rx="140" fill="${background}"/>` : ""}<image width="640" height="640" href="data:image/png;base64,${data}"/>${badge ? `<circle cx="525" cy="525" r="100" fill="${badge}" stroke="${background || "#202125"}" stroke-width="22"/>` : ""}</svg>\n`;
}
const images = "packages/app/assets/images";
for (const name of ["icon", "favicon"])
  png(white, `${images}/${name}.png`, name === "icon" ? 1024 : 256, "#52535b");
png(color, `${images}/splash-icon.png`, 512);
png(white, `${images}/notification-icon.png`, 512);
png(white, `${images}/android-icon-foreground.png`, 1024);
for (const scheme of ["light", "dark"]) {
  const bg = scheme === "dark" ? "#202125" : "#f6f6f7";
  const source = scheme === "dark" ? white : dark;
  for (const [suffix, badge] of [
    ["", null],
    ["-running", "#3b82f6"],
    ["-attention", "#ef4444"],
  ]) {
    const stem = `${images}/favicon-${scheme}${suffix}`;
    png(source, `${stem}.png`, 64, bg, badge);
    fs.writeFileSync(`${stem}.svg`, svg(source, bg, badge));
  }
}
const maskBitmap = magick(white, "-alpha", "extract", "-threshold", "50%", "-negate", "pbm:-");
const pinnedMask = execFileSync(
  "potrace",
  ["--svg", "--flat", "--turdsize", "0", "--output", "-"],
  {
    input: maskBitmap,
  },
)
  .toString()
  .replace(/width="[^"]+" height="[^"]+"/, 'width="16" height="16"');
const publicDir = "packages/app/public";
fs.copyFileSync(white, `${publicDir}/vorteo-logo-white-${hash}.png`);
fs.writeFileSync(`${publicDir}/vorteo-pinned-tab-${hash}.svg`, pinnedMask);
fs.writeFileSync("packages/website/public/safari-pinned-tab.svg", pinnedMask);
png(white, "packages/website/public/apple-touch-icon.png", 180, "#52535b");
png(white, `${publicDir}/vorteo-favicon-${hash}.png`, 256, "#52535b");
for (const size of [192, 512])
  png(white, `${publicDir}/vorteo-icon-${size}-${hash}.png`, size, "#52535b");
png(white, `${publicDir}/vorteo-apple-touch-${hash}.png`, 180, "#52535b");
// Fixed fallback URLs are reviewed publisher aliases, not immutable versioned assets.
fs.copyFileSync(`${publicDir}/vorteo-apple-touch-${hash}.png`, `${publicDir}/apple-touch-icon.png`);
for (const size of [192, 512])
  fs.copyFileSync(
    `${publicDir}/vorteo-icon-${size}-${hash}.png`,
    `${publicDir}/pwa-icon-${size}.png`,
  );
const oldManifest = fs
  .readdirSync(publicDir)
  .find((name) => name.startsWith("manifest-") && name.endsWith(".json"));
const manifest = JSON.parse(fs.readFileSync(`${publicDir}/${oldManifest}`, "utf8"));
manifest.icons = [192, 512].map((size) => ({
  src: `/vorteo-icon-${size}-${hash}.png`,
  sizes: `${size}x${size}`,
  type: "image/png",
  purpose: "any maskable",
}));
fs.writeFileSync(
  `${publicDir}/manifest-vorteo-${hash}.json`,
  JSON.stringify(manifest, null, 2) + "\n",
);
execFileSync("npm", ["run", "format:files", "--", `${publicDir}/manifest-vorteo-${hash}.json`], {
  cwd: root,
  stdio: "inherit",
});
let html = fs.readFileSync(`${publicDir}/index.html`, "utf8");
html = html
  .replace(/href="\/vorteo-favicon-[^"]+\.png"/, `href="/vorteo-favicon-${hash}.png"`)
  .replace(/href="\/manifest-[^"]+\.json"/, `href="/manifest-vorteo-${hash}.json"`)
  .replace(
    /href="\/(?:apple-touch-icon|vorteo-apple-touch-[^"]+)\.png"/,
    `href="/vorteo-apple-touch-${hash}.png"`,
  );
html = html.replace(/\s*<link rel="mask-icon"[^>]*>/g, "");
html = html.replace(
  /(<link rel="icon"[^>]*>)/,
  `$1\n    <link rel="mask-icon" href="/vorteo-pinned-tab-${hash}.svg" color="#3b82f6" />`,
);
fs.writeFileSync(`${publicDir}/index.html`, html);
const desktop = "packages/desktop/assets";
const desktopTile = path.join(brand, "vorteo-desktop.png");
magick(
  "-size",
  "640x640",
  "xc:none",
  "-fill",
  "#52535b",
  "-draw",
  "roundrectangle 40,40 599,599 120,120",
  white,
  "-compose",
  "Over",
  "-composite",
  desktopTile,
);
for (const [name, size] of [
  ["icon", 1024],
  ["icon-dev", 1024],
  ["32x32", 32],
  ["64x64", 64],
  ["128x128", 128],
  ["128x128@2x", 256],
])
  png(desktopTile, `${desktop}/${name}.png`, size);
magick(
  `${desktop}/icon.png`,
  "-define",
  "icon:auto-resize=256,128,64,48,32,16",
  `${desktop}/icon.ico`,
);
if (process.platform === "darwin") {
  const iconset = fs.mkdtempSync(path.join(root, ".vorteo-icon-")) + ".iconset";
  fs.mkdirSync(iconset);
  try {
    for (const size of [16, 32, 128, 256, 512]) {
      png(desktopTile, `${iconset}/icon_${size}x${size}.png`, size);
      png(desktopTile, `${iconset}/icon_${size}x${size}@2x.png`, size * 2);
    }
    execFileSync("iconutil", ["-c", "icns", iconset, "-o", `${desktop}/icon.icns`], { cwd: root });
  } finally {
    fs.rmSync(iconset, { recursive: true });
    fs.rmdirSync(iconset.slice(0, -8));
  }
}
png(white, "fastlane/metadata/android/en-US/images/icon.png", 512, "#52535b");
fs.writeFileSync("packages/website/public/logo.svg", svg(color));
fs.writeFileSync("packages/website/public/logo-white.svg", svg(white));
fs.writeFileSync("packages/website/public/favicon.svg", svg(white, "#52535b"));
magick(
  `${images}/icon.png`,
  "-define",
  "icon:auto-resize=48,32,16",
  "packages/website/public/favicon.ico",
);
fs.copyFileSync("packages/website/public/favicon.ico", `${publicDir}/favicon.ico`);
console.log(`Generated centered Vorteo icons: ${hash}`);
