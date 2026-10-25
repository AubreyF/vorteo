#!/usr/bin/env node
// Build from a source snapshot with platform-local dependencies. Never reuse
// the Mac's node_modules from a Linux container or modify the working checkout.
import { assertBuildsCoordinator } from "./lib/builds-guard.mjs";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { parseArgs } from "node:util";
import {
  assertIntegratedSource,
  git,
  readLiveState,
  sealArtifact,
  snapshotSource,
} from "./instance-web-artifact.mjs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { installationWebEntry } from "./installation-web-entry.mjs";
import { installDependencies } from "./lib/dependency-cache.mjs";
import { preloadWebEntry } from "./preload-web-entry.mjs";
import { webExportEnvironment } from "./lib/web-export.mjs";
import {
  claimBuild,
  pruneInstanceBuildsInBackground,
  trimSealedBuild,
} from "./lib/instance-builds.mjs";
const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({
  options: {
    destination: { type: "string" },
    "integration-ref": { type: "string" },
    "adopt-legacy": { type: "string" },
    "installation-origin": { type: "string" },
  },
});
const integrationRef = values["integration-ref"];
const entry = values["installation-origin"]
  ? installationWebEntry(values["installation-origin"])
  : null;
if (Boolean(values.destination) !== Boolean(integrationRef)) {
  throw new Error(
    "Primary builds require both --destination and --integration-ref; omit both for a preview.",
  );
}
if (values["adopt-legacy"] && !values.destination)
  throw new Error("Legacy adoption requires a destination.");
let deployment = null;
let sourceCommit = git(source, ["rev-parse", "HEAD"]);
if (values.destination) {
  assertBuildsCoordinator("Building for web interface publication");
  const destination = await fs.realpath(values.destination);
  const live = await readLiveState(destination);
  if (live.release?.integrationRef && live.release.integrationRef !== integrationRef) {
    throw new Error("The destination uses a different integration branch.");
  }
  if (live.index && !live.release?.sourceCommit && values["adopt-legacy"] !== live.token) {
    throw new Error(
      `Legacy release has no source lineage. Integrate its changes, then explicitly adopt token ${live.token} with --adopt-legacy.`,
    );
  }
  sourceCommit = assertIntegratedSource(source, integrationRef, live.release?.sourceCommit);
  deployment = { destination, expectedRelease: live.token, integrationRef, repository: source };
}
const builds = path.join(os.homedir(), ".cache", "paseo-instance-builds");
const { root, sourceHash } = await snapshotSource({
  source,
  sourceCommit,
  committed: Boolean(deployment),
  builds,
});
console.log(`Source snapshot: ${root}`);
await claimBuild(root);
pruneInstanceBuildsInBackground(builds);
try {
  await build();
} catch (error) {
  // A failed snapshot has no further use and holds gigabytes of dependencies.
  await fs.rm(root, { recursive: true, force: true });
  throw error;
}
await trimSealedBuild(root);
console.log("Export ready: " + path.join(root, "web-export"));
if (deployment)
  console.log("Publish the export with scripts/publish-instance-web.mjs and the same destination.");
else
  console.log("Preview artifact only. Primary publication requires committed integration source.");

async function build() {
  await fs.writeFile(path.join(root, ".build-source-commit"), sourceCommit + "\n");
  const env = {
    ...process.env,
    LEFTHOOK: "0",
    APP_VARIANT: "production",
    PASEO_BUILD_COMMIT: sourceCommit,
  };
  function run(command, args, cwd = root, environment = {}) {
    execFileSync(command, args, { cwd, env: { ...env, ...environment }, stdio: "inherit" });
  }
  const exported = path.join(root, "web-export");
  if (entry) {
    await fs.mkdir(exported);
    await fs.writeFile(path.join(exported, "index.html"), entry.html);
    await fs.writeFile(path.join(exported, entry.scriptName), entry.script);
  } else {
    // Dependencies are cloned copy-on-write from a cached install of the same
    // lockfile when possible. Generated files stay private to this snapshot.
    installDependencies({ root, mode: "build", run: (command, args) => run(command, args) });
    run("npm", ["run", "postinstall"]);
    console.log("Building application dependencies");
    run("npm", ["run", "build:app-deps"]);
    run(
      "npx",
      ["expo", "export", "--platform", "web", "--output-dir", exported],
      path.join(root, "packages/app"),
      webExportEnvironment(),
    );
  }
  const indexPath = path.join(exported, "index.html");
  await fs.writeFile(
    indexPath,
    preloadWebEntry(await fs.readFile(indexPath, "utf8"), {
      sourceCommit,
      version: JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")).version,
    }),
  );
  await sealArtifact(exported, {
    buildId: path.basename(root),
    sourceCommit,
    sourceHash,
    deployment,
    ...(entry ? { entrypoint: { kind: "installation", origin: entry.origin } } : {}),
  });
}
