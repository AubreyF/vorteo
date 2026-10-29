import fs from "node:fs/promises";
import ts from "typescript";

// Keep recovery usable without downloading another script or the app bundle.
const source = new URL("../packages/app/src/utils/duration.ts", import.meta.url);
const template = new URL("../packages/app/public/index.html", import.meta.url);
const { outputText } = ts.transpileModule(await fs.readFile(source, "utf8"), {
  compilerOptions: {
    target: ts.ScriptTarget.ES2015,
    module: ts.ModuleKind.ESNext,
    removeComments: true,
  },
});
const inline = outputText.replace("export function", "function").trim();
const html = await fs.readFile(template, "utf8");
const updated = html.replace(
  /<script id="boot-duration-format">[\s\S]*?<\/script>/,
  `<script id="boot-duration-format">\n${inline}\n    </script>`,
);
if (process.argv.includes("--check")) {
  const current = html.match(/<script id="boot-duration-format">([\s\S]*?)<\/script>/)?.[1];
  if (current?.replace(/\s/g, "") !== inline.replace(/\s/g, "")) {
    throw new Error("Run node scripts/sync-boot-duration.mjs and format the HTML template.");
  }
} else {
  await fs.writeFile(template, updated);
}
