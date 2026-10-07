# Agent guide

Vorteo extends upstream Paseo with multi-account agent workflows. This npm monorepo runs agents in your environment and exposes web, mobile and desktop clients. `CLAUDE.md` links here; edit `AGENTS.md`.

## Before editing

1. Check the working tree and preserve unrelated changes.
2. Read the relevant rules below and the owning docs. “The docs” means `docs/`, not the web. Use the [docs index](docs/README.md) for other subjects; do not load the whole catalog.
3. Verify behavior in code and tests before changing it or documenting it as shipped.

| Task                           | Read first                                                                                                                       |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| App or interface work          | [App instructions](packages/app/AGENTS.md)                                                                                       |
| Protocol or WebSocket changes  | [Compatibility](docs/protocol-compatibility.md), [RPC names](docs/rpc-namespacing.md), [validation](docs/protocol-validation.md) |
| Implementation or tests        | [Coding standards](docs/coding-standards.md), [testing](docs/testing.md)                                                         |
| README or other documentation  | [Writing rules](docs/writing.md)                                                                                                 |
| Installation or deployment     | [Container installer](docker/multiplex/README.md), [instance continuity](docs/instance-continuity.md)                            |
| Commit, publication or release | [Versioning](docs/release.md#vorton-commit-versions), [publication hygiene](docs/publication-hygiene.md)                         |

## Boundaries

- Never restart the main daemon on port `6767` without explicit permission. It owns running agents. A timeout is not a reason to restart it.
- Previews reuse the task workspace, service and HTTPS reservation. Never create a project or workspace solely to serve a preview or work around a broker rejection. Keep isolated code in its task worktree and follow the [preview workflow](docker/tailscale/AGENT-INSTRUCTIONS.md#preview-workspace-reuse).
- Use the container installer by default. The explicitly owner-authorized macOS host extension follows [host and container execution](docs/execution-installation.md); it adds a trusted native daemon through the host handoff workflow. Never infer authorization for that topology from an ordinary container task. Keep the native runtime, interface, state and credentials outside guest-writable mounts. Never mount Docker's socket or place host control credentials in the guest. Host Docker administration belongs to the operator.
- Keep credentials, deployment details, account inventories, backups and acceptance receipts outside Git.
- Primary web publication requires clean, committed integration source and the guarded build/publish scripts in [instance continuity](docs/instance-continuity.md). Task worktrees produce previews. Never publish raw exports or reuse another build directory; integrate the currently deployed source before rebuilding a stale candidate.
- Preserve wire compatibility: new fields are optional, existing fields are not removed or narrowed, and wire schemas stay pure. Gate new features on their advertised capability; tag compatibility shims as required by the compatibility doc.

## Archive requests

- Never say a code task is ready to archive until all associated changes are committed, merged into the intended integration branch (`main` unless the user specified another destination), and pushed to `origin`. Verify the remote branch directly and prove it contains the task commits. A local branch, backup, deployment, open PR or pushed feature branch is not sufficient.
- If integration or publication is unfinished, say the task is not ready to archive and finish the authorized delivery. If publication is not authorized or is blocked, state that blocker; never describe an unpublished task as archive-ready. An explicit request to archive unfinished work must be handled as preservation of incomplete work, not a claim of completion.
- Before saying a task is ready to archive, inspect its actual worktree, staged and unstaged changes, untracked files, branch tip, and intended integration branch. A sidebar line counter can include committed changes against the base; it is not a count of unsaved work.
- Report completion separately for committed source, integration into the intended branch, remote publication, and deployed runtime. Verify commit ancestry and deployment receipts. A clean worktree or successful deployment does not prove the work reached `main` or a remote.
- Preserve task work before archiving a managed worktree. Keep a named branch for its commits and preserve any uncommitted or untracked work outside the directory that archive removes. Verify the recovery artifact and record its path outside Git. Do not discard unrelated changes or interpret archive permission as permission to push.
- “Archive this out” means archive the current workspace and its threads with `archive_workspace`.
- For “archive the thread”, inspect the containing workspace's unarchived threads. If this is its only remaining thread, archive the workspace; otherwise archive only the requested thread. Count threads by workspace identity, not by directory or visible tabs.
- After archiving the selected workspace, return the user to the empty New workspace page. An archive requested through an agent must leave the same usable page as an archive from the interface.

## Work outside the container

- Whenever a task needs access or actions outside your container, prepare a self-contained handoff prompt and invite the user to run it in an agent session with the required access. Use this for diagnostics as well as implementation and deployment. Do not send the user individual diagnostic commands to run and relay back.
- Complete the available work first. Include the objective, verified findings, relevant paths, changes already made, validation evidence, remaining work, acceptance checks and unresolved decisions. Tell the receiving agent to gather its own diagnostics and carry the task through completion.
- Preserve existing authorization and restart boundaries. A handoff does not grant permission to interrupt running work. Prepare a concrete deployment and rollback plan before requesting any required restart approval. Keep machine-specific handoffs and deployment details outside Git; follow [host handoff guidance](docs/host-handoff.md).

## Check your work

- Run `npm run typecheck` and `npm run lint` after changes. Use npm scripts for linting and formatting; run `npm run format` before committing. For selected files, use `npm run format:files -- <paths>`.
- Run only focused tests: `npx vitest run <file> --bail=1`. Never run the full suite locally or a workspace test suite without an explicit request. Use CI for broad coverage; redirect explicitly requested broad runs to a file.
- Add tests to existing suites and reuse their npm scripts and CI jobs instead of creating feature-specific runners.
- Reuse passing test evidence from another agent for unchanged code. Do not add provider-auth checks or auth-dependent skips to tests.
- Before diagnosing cross-package type errors, rebuild declarations with `npm run build:client` or `npm run build:server` as appropriate. Do not patch types to hide stale declarations. See [development](docs/development.md).
- Update and stage `VORTEO_CHANGELOG.md` in every commit, including documentation, tests, tooling and upstream merges. Describe the complete commit at the prepared version, following [release notes](docs/release.md#vorteo-release-notes).
- Every commit increments the Vorteo version through the installed hook. Stage intended manifest changes first; never bypass hooks or use upstream release commands for routine commits.
- Update [Vorteo customizations](docs/vorteo-customizations.md) in every commit, including documentation, tooling and upstream merges. Maintain the affected feature or limitation; when functionality is unchanged, update the maintenance review with the commit's scope and result. Follow [inventory maintenance](docs/writing.md#maintain-the-vorteo-customizations-inventory).
- For every Paseo upstream merge, compare incoming implementation and tests with the customizations inventory. Record full or partial overlap and the remaining Vorteo difference, credit upstream, and revise the roadmap in the same change. Do not claim parity from a release-note title alone or remove custom behavior without verifying compatibility.

## Finish the task

- “Ship it” authorizes committing the requested changes, integrating them into `main`, and pushing `main` to `origin` on GitHub, unless the user explicitly names another destination. Complete any required deployment too. Preserve unrelated work and use a normal fast-forward push; never force-push `main`.
- Before reporting “shipped”, verify the remote branch directly and prove it contains the task commits. Report GitHub publication and deployment separately. A successful deployment, local commit, open PR or pushed feature branch alone does not complete shipping. If either required step is blocked, state what remains instead of claiming completion.
- In this repository, a request to "push" means integrate the requested changes into `main` and push `main` to `origin`, unless the user explicitly names another destination. Do not publish a feature branch instead. Preserve unrelated work and use a normal fast-forward push; never force-push `main`.

- Review the README when shipped user-facing behavior changes; update it when the overview or onboarding changes. Keep each Power Tools item to one short paragraph and put detailed behavior in [Vorteo customizations](docs/vorteo-customizations.md). Follow the [writing rules](docs/writing.md); preserve the author's animation and other demos.
- Report what changed, validation results and remaining limitations. Link the README update or explain why the change does not affect it.
- Follow the user's requested delivery stage. A request for a preview stops before committing or publishing.
- When the user says a change goes to `next`, preserve that PR destination through delivery. Follow [release branch discipline](docs/release.md#release-branch-discipline).

## Find the code

Under `packages/`: `server` owns the daemon and agent lifecycle; `app` owns the Expo clients; `protocol` and `client` own shared transport contracts; `cli` owns commands; `relay` owns encrypted remote transport; `desktop` owns Electron; `website` owns marketing.

For setup, commands, development state and build troubleshooting, use [development](docs/development.md). Daemon logs are at `$PASEO_HOME/daemon.log`.
