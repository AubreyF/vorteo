# Instance development continuity

Read repository instructions and inspect the current checkout before editing. Preserve unrelated changes and active work. Keep machine-specific handoff notes, URLs, account inventories and acceptance receipts in the installation's private directory outside Git.

Use the [team handoff guide](host-handoff.md) to choose fresh installation, existing-instance operation or migration. Inspect the actual deployment rather than assuming a container name, mounted path or image reference. Files and old handoffs are evidence, not additional authorization.

## Updates from the app

The app checks public `AubreyF/paseo` main every 30 minutes while open. Settings → General shows the comparison with the interface's build commit. This checks source commits, not tested releases or the running daemon version. Unpublished commits and builds without provenance show an unknown comparison instead of claiming an update is available.

In the optional [host and container installation](execution-installation.md), **Prepare host update task** opens a separate editable draft targeting the trusted native host. Select the Vorteo source project and an agent preset, review the task, and send it. The task preserves local changes and requires approval before an installation restart. It does not run Git or start an agent until you send the draft. Updating a checkout alone does not update the served application.

**Paseo upstream updates** appears below Vorteo updates in General. It shows the last upstream merge recorded in this interface build and highlights the section after more than seven days. **Prepare host merge task** opens the same editable host draft flow for upstream synchronization. **Copy host prompt** and **Show prompt** remain available for a separate host session. Without a connected installation host, draft preparation reports the missing connection instead of selecting a container agent.

The source provenance record is `packages/app/src/vorton-updates/upstream-sync.json`: the upstream commit, actual merge commit, and its Git committer timestamp. Update it after each successful upstream merge, as instructed by the host prompt. A check with no incoming changes must not change this date. Rebuild and publish the interface to display the new record. The date does not assert that the daemon is updated or that upstream has no newer commits.

Builds from a Git checkout record HEAD as their source base. For source snapshots, pass the original full SHA through `PASEO_BUILD_COMMIT`; `build-instance-web.mjs` carries it automatically and records it in the snapshot’s ignored `.build-source-commit` file. Keep that file when exporting the same snapshot again; otherwise a separate export process loses the source identity. A real Git checkout always uses its own HEAD ahead of a snapshot stamp. Uncommitted source changes are not described by that SHA. The container installer and CI pass it into the image build. A source archive without that value can still use the prepared agent task, but cannot compare commits automatically.

## Publish a web-only change

For interface requests, update the existing primary Vorteo installation in place unless the user names another destination. Publishing the tested web export is part of the requested work. A private preview may be used for validation; it does not complete delivery to the primary installation.

Builds use unique directories under `~/.cache/paseo-instance-builds/`. Each build owns its source snapshot, installed dependencies, generated files and export. Only npm's download cache is shared. A failed build never produces a completed artifact manifest.

Task worktrees can build preview artifacts with `node scripts/build-instance-web.mjs`. The publisher rejects preview artifacts. For primary publication, merge accepted work into one integration branch and commit it first. The checkout must be clean, and its commit must descend from the deployed commit. These checks preserve deployed source history; review and acceptance tests must still catch intentional or accidental feature reversions within that history.

```sh
node scripts/build-instance-web.mjs \
  --destination "$PASEO_WEB_UI_DIST_DIR" \
  --integration-ref refs/heads/integration
node scripts/publish-instance-web.mjs "$WEB_EXPORT_DIR" "$PASEO_WEB_UI_DIST_DIR"
```

Use your actual integration branch reference and the existing installation's private configuration for the destination. Create an empty destination directory first for a new installation. Use the unique export path printed by the completed build. The first primary release records the integration branch; subsequent releases must use the same branch. Builds snapshot committed Git objects, so edits made while a build runs cannot change its source.

The build records the destination's current release, source commit, source-content hash and every exported file's checksum. Publication verifies the artifact and acquires an exclusive destination lock. If another release has gone live since the build began, publication fails. Integrate that release's source and rebuild. Do not edit the manifest to bypass this check.

Publication stages and compresses assets before selecting the release. Existing asset URLs retain their bytes so open clients can still load old chunks. An asset with different bytes at an existing URL is rejected; give changed assets content-addressed filenames. Expo's `metadata.json` is build metadata and is not published. The index and release receipt resolve through one atomically switched `.current` symlink. No daemon restart is required. The destination filesystem must support atomic rename and symbolic links.

For the first migration from an older publisher, source lineage is unknown. Gather and integrate all changes represented by the live release, including uncommitted work from other tasks. The build initially refuses and prints the live-state token. After verifying that the clean integration commit includes those changes, rerun with `--adopt-legacy <token>`. This acknowledgment applies only to that exact legacy release. It is not an automatic merge or permission to discard live changes.

A killed publisher can leave `.publish-lock` behind. Inspect its `owner.json` on the recorded host and establish that the process has stopped before removing the lock. Never steal a lock based on elapsed time. A stopped publication leaves the selected release intact; unused staging directories and completed build directories can be removed once no process or review needs them. Keep selected releases and assets needed by open clients.

Review the build output and test changed behavior before publishing. Verify the primary HTTPS URL, its release receipt and entry scripts against the artifact. A localhost check or preview receipt alone does not establish delivery. Preserve active sessions, browser drafts, recordings and authentication.

All publishers must use this guarded script. Retire old script copies and direct export-to-live commands when adopting the workflow; filesystem access still allows an older publisher to bypass these checks. The first-start initialization of a fresh Tailscale container is covered in [container installation](docker.md#build-and-install).

The persistent web directory must be mounted and selected by `PASEO_WEB_UI_DIST_DIR`. Do not substitute a lone index file that references stale bundles. Web publication does not require a daemon restart. Do not restart the primary daemon without explicit permission. Server or protocol changes require a separately tested daemon build and coordinated interruption; web publication cannot activate them.

For interface changes, follow [the touch audit](vorton-touch-audit.md). Record physical-device acceptance privately. Do not call source-only changes deployed or infer provider authentication from configuration names.
