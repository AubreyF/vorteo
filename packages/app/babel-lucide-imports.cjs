const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");

let cachedExports;
let cachedContext;
function readContextExports() {
  if (cachedContext) return cachedContext;
  const appRequire = createRequire(path.join(__dirname, "package.json"));
  const entry = appRequire.resolve("lucide-react-native");
  const esm = path.resolve(path.dirname(entry), "../esm");
  const source = fs.readFileSync(path.join(esm, "lucide-react-native.mjs"), "utf8");
  // The public provider barrel eagerly imports every icon in Metro. Resolve its
  // original context module, retaining the same context as per-icon imports.
  if (
    !/export\s*\{\s*LucideProvider\s*,\s*useLucideContext\s*\}\s*from\s*['"]\.\/context\.mjs['"]/.test(
      source,
    )
  )
    throw new Error("Lucide context export layout changed; review the web import mapping.");
  const context = path.join(esm, "context.mjs");
  if (
    !/export\s*\{\s*LucideProvider\s*,\s*useLucideContext\s*\}/.test(
      fs.readFileSync(context, "utf8"),
    )
  )
    throw new Error("Lucide context implementation changed; review the web import mapping.");
  cachedContext = { path: context, names: new Set(["LucideProvider", "useLucideContext"]) };
  return cachedContext;
}
function readIconExports() {
  if (cachedExports) return cachedExports;
  const appRequire = createRequire(path.join(__dirname, "package.json"));
  const entry = appRequire.resolve("lucide-react-native");
  const source = fs.readFileSync(
    path.resolve(path.dirname(entry), "../esm/lucide-react-native.mjs"),
    "utf8",
  );
  const exports = new Map();
  for (const declaration of source.matchAll(
    /export\s*\{([^}]+)\}\s*from\s*['"]\.\/icons\/([a-z0-9-]+)\.mjs['"]/g,
  )) {
    const names = [...declaration[1].matchAll(/default\s+as\s+([A-Za-z0-9_]+)/g)].map(
      (name) => name[1],
    );
    for (const name of names)
      exports.set(name, {
        path: `lucide-react-native/icons/${declaration[2]}`,
        canonical: names[0],
      });
  }
  if (exports.size < 1000)
    throw new Error("Lucide export layout changed; review the icon import mapping.");
  cachedExports = exports;
  return exports;
}

module.exports = function modularLucideImports({ types: t }) {
  const exports = readIconExports();
  const context = readContextExports();
  return {
    name: "vorteo-web-icon-imports",
    visitor: {
      ImportDeclaration(statement) {
        if (
          statement.node.source.value !== "lucide-react-native" ||
          statement.node.importKind === "type"
        )
          return;
        const retained = [];
        const direct = [];
        for (const specifier of statement.node.specifiers) {
          const imported = t.isImportSpecifier(specifier)
            ? (specifier.imported.name ?? specifier.imported.value)
            : undefined;
          if (specifier.importKind !== "type" && context.names.has(imported)) {
            direct.push(
              t.importDeclaration(
                [t.importSpecifier(specifier.local, t.identifier(imported))],
                t.stringLiteral(context.path),
              ),
            );
            continue;
          }
          const icon =
            t.isImportSpecifier(specifier) && specifier.importKind !== "type"
              ? exports.get(imported)
              : undefined;
          if (icon)
            direct.push(
              t.importDeclaration(
                [t.importDefaultSpecifier(specifier.local)],
                t.stringLiteral(icon.path),
              ),
            );
          else retained.push(specifier);
        }
        if (!direct.length) return;
        if (retained.length) {
          statement.node.specifiers = retained;
          statement.insertAfter(direct);
        } else statement.replaceWithMultiple(direct);
      },
    },
  };
};
module.exports.readIconExports = readIconExports;
module.exports.readContextExports = readContextExports;
