// Compiles each built-in plugin copied into dist/server/builtin-plugins and stores the bundles
// beside it, so the daemon does not run esbuild for built-ins at every start. The daemon checks
// each bundle's digests and compiles from source when a bundle is missing or stale.
import path from "node:path";
import { fileURLToPath } from "node:url";

const dist = new URL("../dist/server/", import.meta.url);
const load = (module) => import(new URL(`server/${module}`, dist).href);
const { builtinPlugins } = await load("plugins/builtin/index.js");
const { writePrebuiltBundles } = await load("plugins/builtin/prebuilt.js");
const { compilePlugin } = await load("plugins/compiler.js");
const { resolveEntryPaths } = await load("plugins/runtime.js");
const { resolveDaemonVersion } = await load("daemon-version.js");

// The same version the daemon reads at start; a bundle from another version is never used.
const version = resolveDaemonVersion(new URL("server/daemon-version.js", dist).href);
for (const id of builtinPlugins) {
  const directory = path.join(fileURLToPath(dist), "builtin-plugins", id);
  const bundles = await compilePlugin(await resolveEntryPaths(directory));
  await writePrebuiltBundles(directory, version, bundles);
}
console.log(`Prebuilt ${builtinPlugins.length} built-in plugins for ${version}`);
