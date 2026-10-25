// Public symbol metadata only. Regenerate after changing the pinned Lucide dependency.
const fs = require("node:fs");
const path = require("node:path");
const { readIconExports } = require("../packages/app/babel-lucide-imports.cjs");
const groups = new Map();
for (const [name, value] of readIconExports()) {
  const group = groups.get(value.canonical) ?? [];
  group.push(name);
  groups.set(value.canonical, group);
}
const file = path.resolve(__dirname, "../packages/app/src/plugins/icon-names.generated.ts");
fs.writeFileSync(
  file,
  "// Generated public icon names; run node scripts/generate-plugin-icon-names.cjs after a Lucide update.\nexport const iconNameGroups: readonly string[] = " +
    JSON.stringify(
      [...groups.values()].map((names) => names.join(",")),
      null,
      2,
    ) +
    ";\n",
);
console.log(`Recorded ${groups.size} icon groups without importing the runtime catalogue.`);
