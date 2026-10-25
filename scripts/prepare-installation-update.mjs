#!/usr/bin/env node
// Invoked only by the protected coordinator after approval of this exact bundle.
import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { writeSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  assertIntegratedSource,
  readLiveState,
  snapshotSource,
  sealArtifact,
} from "./instance-web-artifact.mjs";
import { installDependencies } from "./lib/dependency-cache.mjs";

const input = JSON.parse(await fs.readFile(process.argv[2], "utf8"));
const { update, work, sourceRepository, integrationRef } = input;
const log = await fs.open(path.join(work, "build.log"), "wx", 0o600);
function run(command, args, cwd) {
  return execFileSync(command, args, {
    cwd,
    timeout: 45 * 60_000,
    maxBuffer: 8192,
    env: {
      ...process.env,
      LEFTHOOK: "0",
      APP_VARIANT: "production",
      PASEO_BUILD_COMMIT: update.sourceCommit,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.hooksPath",
      GIT_CONFIG_VALUE_0: "/dev/null",
    },
    stdio: ["ignore", log.fd, log.fd],
  });
}
try {
  const bundle = await fs.readFile(input.bundle);
  if (
    bundle.length !== update.bytes ||
    createHash("sha256").update(bundle).digest("hex") !== update.sha256
  )
    throw new Error("Approved bundle digest changed");
  run("git", ["bundle", "verify", input.bundle], sourceRepository);
  run("git", ["fetch", "--no-tags", input.bundle, integrationRef], sourceRepository);
  const fetched = execFileSync("git", ["rev-parse", "FETCH_HEAD"], {
    cwd: sourceRepository,
    encoding: "utf8",
  }).trim();
  if (fetched !== update.sourceCommit)
    throw new Error("Bundle ref does not match approved source commit");
  run("git", ["merge-base", "--is-ancestor", update.baseCommit, fetched], sourceRepository);
  run("git", ["update-ref", "refs/vorteo-updates/approved", fetched], sourceRepository);
  const repository = path.join(work, "repository");
  // Transfer the approved graph through Git, without copying a changing local object store
  // or importing unrelated branch references into the build repository.
  run("git", ["init", repository], work);
  run("git", ["fetch", "--no-tags", sourceRepository, fetched], repository);
  run("git", ["checkout", "-B", integrationRef.slice("refs/heads/".length), fetched], repository);
  const live = await readLiveState(input.webDirectory);
  if (!live.release?.sourceCommit)
    throw new Error(
      "Adopt the current interface with the guarded publisher before enabling source updates",
    );
  if (live.release.integrationRef !== integrationRef)
    throw new Error("Interface integration branch differs from update configuration");
  assertIntegratedSource(repository, integrationRef, live.release.sourceCommit);
  const { root, sourceHash } = await snapshotSource({
    source: repository,
    sourceCommit: fetched,
    committed: true,
    builds: work,
  });
  const npmCi = ["ci", "--ignore-scripts", "--include=dev", "--no-audit", "--no-fund"];
  if (input.dependencyCache)
    // Clone a cached install of this exact lockfile instead of copying 2.4 GB per release.
    // The cache is private to approved Host builds: only this preparer fills it, with a
    // full integrity-checked npm ci, so a worktree's install can never reach a release.
    installDependencies({
      root,
      mode: "build",
      cache: input.dependencyCache,
      run,
      log: (message) => writeSync(log.fd, `${message}\n`),
    });
  else run("npm", npmCi, root);
  // Dependency install hooks build native addons for this Host after approval.
  run("npm", ["rebuild", "--foreground-scripts"], root);
  run("npm", ["run", "postinstall"], root);
  run("npm", ["run", "build:server"], root);
  run("npm", ["run", "build:app-deps"], root);
  const exported = path.join(root, "web-export");
  run(
    "npx",
    ["expo", "export", "--platform", "web", "--output-dir", exported],
    path.join(root, "packages/app"),
  );
  await sealArtifact(exported, {
    buildId: path.basename(root),
    sourceCommit: fetched,
    sourceHash,
    deployment: {
      destination: await fs.realpath(input.webDirectory),
      expectedRelease: live.token,
      integrationRef,
      repository,
    },
  });
  await fs.writeFile(
    path.join(root, ".installation-source.json"),
    JSON.stringify({ sourceCommit: fetched, sha256: update.sha256 }),
    { mode: 0o600, flag: "wx" },
  );
  // Standalone coordinator bundle, stage 1: inert, and built after the receipt it ships.
  if (process.env.VORTEO_COORDINATOR_BUNDLE === "enabled")
    run(process.execPath, ["packages/server/scripts/build-coordinator-bundle.mjs"], root);
  await fs.writeFile(input.resultFile, JSON.stringify({ release: root, exported }), {
    mode: 0o600,
    flag: "wx",
  });
} catch (error) {
  await log.write(`${error.message}\n`);
  throw new Error(`Approved source build failed. Inspect ${path.join(work, "build.log")}`, {
    cause: error,
  });
} finally {
  await log.close();
}
