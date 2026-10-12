const manifest = require("./assets/appearance-fonts/manifest.json");

const fontPath = (font) => `./assets/appearance-fonts/${font.file}`;
const families = [...new Set(manifest.nativeFonts.map((font) => font.family))];

module.exports = {
  ios: { fonts: manifest.nativeFonts.map(fontPath) },
  android: {
    fonts: families.map((fontFamily) => ({
      fontFamily,
      fontDefinitions: manifest.nativeFonts
        .filter((font) => font.family === fontFamily)
        .map((font) => ({ path: fontPath(font), weight: font.weight, style: "normal" })),
    })),
  },
};
