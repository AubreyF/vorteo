interface AppearanceFontInput {
  stack: string;
  platform: string;
  systemFont: string;
}

// These reference-stack families are supplied by iOS. Web-only names must not
// be passed to React Native merely because a later fallback matches this list.
// Platform catalog: https://developer.apple.com/fonts/system-fonts/
const IOS_REFERENCE_FAMILIES = new Set([
  "Baskerville",
  "Hoefler Text",
  "Iowan Old Style",
  "Georgia",
  "Didot",
  "Bodoni 72",
  "Optima",
  "Avenir Next",
  "Avenir Next Condensed",
  "Helvetica Neue",
  "Arial",
]);

// Registered before JS starts by native-appearance-fonts.cjs in native builds.
const BUNDLED_REFERENCE_FAMILIES = new Set([
  "Barlow",
  "Barlow Condensed",
  "Manrope",
  "Space Grotesk",
]);

export function resolveAppearanceFont({
  stack,
  platform,
  systemFont,
}: AppearanceFontInput): string {
  if (platform === "web") return stack;
  const families = stack.split(",").map((family) => family.replace(/["']/g, "").trim());
  const installedFamily = families.find((family) => {
    if (BUNDLED_REFERENCE_FAMILIES.has(family)) return true;
    return platform === "ios" && IOS_REFERENCE_FAMILIES.has(family);
  });
  // RCTFont needs a face name to retain the condensed trait while matching weights.
  // Passing the family alone silently selects the regular face for every weight.
  if (platform === "ios" && installedFamily === "Barlow Condensed") {
    return "BarlowCondensed-Regular";
  }
  if (installedFamily) return installedFamily;
  if (platform === "ios") {
    return families.includes("serif") ? "Georgia" : systemFont;
  }
  return families.includes("serif") ? "serif" : systemFont;
}
