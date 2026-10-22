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
const { root, sourceHash } = await snapshotSource({
  source,
  sourceCommit,
  committed: Boolean(deployment),
  builds: path.join(os.homedir(), ".cache", "paseo-instance-builds"),
});
console.log(`Source snapshot: ${root}`);
await fs.writeFile(path.join(root, ".build-source-commit"), sourceCommit + "\n");
const env = {
  ...process.env,
  LEFTHOOK: "0",
  APP_VARIANT: "production",
  PASEO_BUILD_COMMIT: sourceCommit,
};
function run(command, args, cwd = root) {
  execFileSync(command, args, { cwd, env, stdio: "inherit" });
}
const exported = path.join(root, "web-export");
if (entry) {
  await fs.mkdir(exported);
  await fs.writeFile(path.join(exported, "index.html"), entry.html);
  await fs.writeFile(path.join(exported, entry.scriptName), entry.script);
} else {
  // Only npm's download cache is shared. Installed dependencies and generated files are private.
  run("npm", ["ci", "--ignore-scripts", "--include=dev", "--no-audit", "--no-fund"]);
  run("npm", ["run", "postinstall"]);
  console.log("Building application dependencies");
  run("npm", ["run", "build:app-deps"]);
  run(
    "npx",
    ["expo", "export", "--platform", "web", "--output-dir", exported],
    path.join(root, "packages/app"),
  );
}
await sealArtifact(exported, {
  buildId: path.basename(root),
  sourceCommit,
  sourceHash,
  deployment,
  ...(entry ? { entrypoint: { kind: "installation", origin: entry.origin } } : {}),
});
console.log("Export ready: " + exported);
if (deployment)
  console.log("Publish the export with scripts/publish-instance-web.mjs and the same destination.");
else
  console.log("Preview artifact only. Primary publication requires committed integration source.");
