# Tracked coordinator bootstrap and maintenance

Status: request contracts, independent owner authentication, private request storage, artifact validation and optional browser transport are implemented as an inert core. Private configuration validation binds the Host daemon and service identity. Complete plan verification combines source receipts, release digests, captured launcher parsing and repeated configuration, mount and process observations. Production admission wiring, interface controls, the lifecycle executor and live acceptance remain unfinished. The first replacement is not authorized by this document. Routine Host automatic approval is implemented separately, but remains inactive until a coordinator that supports it is installed with the protected policy.

## Required result

The Host mount inspector is implemented and validated independently of admission. It queries the configured immutable container through an explicit local Docker socket, verifies writable named-volume records and rejects custom driver options. Host setup must still pin the trusted Docker executable and endpoint, and admission must recheck mount evidence when validating the complete plan. The inspector alone does not enable the bootstrap capability.

The owner can review an exact coordinator replacement in Installation controls, cancel before dispatch, and observe the result in both Settings and the sidebar. Host and Dev daemons keep running. Existing requests, owner sessions, credentials and settings survive. The replacement cannot race another lifecycle operation or replay an ambiguous interruption.

This first upgrade needs a bounded Host bootstrap extension because the installed coordinator cannot represent its own maintenance. After that upgrade, the coordinator owns ordinary maintenance scheduling. The extension must not become another general restart queue or write `restart-jobs.json` alongside the coordinator.

## Verified constraints

- The installed coordinator loads configuration once in `execution-installation/main.ts`. Its supported targets are Host and container daemon. A new interface alone cannot add a backend operation.
- `execution-installation/server.ts` owns the restart journal. Its writes use an atomic replacement and fsync. Source preparation is asynchronous; an empty active-job snapshot does not exclude a later approval or preparation result.
- The native daemon already has an authenticated browser transport and namespaced request handling. The bootstrap can use that transport for display and decisions, without a new public listener or guest credential.
- The daemon's `session-admission-auth.ts` retains a legacy relay path that can classify a session as owner without password proof. `principalId: owner` or `daemon.manage` alone is therefore insufficient for bootstrap approval. The new operation needs independent installation-owner authentication.
- A disposable macOS LaunchAgent probe verified that freezing the service stops its writes, and that bootout can return before the process and service disappear. Replacement must wait for both verified termination and service removal. The probe changed no production service.

## Delivery sequence

1. Install a Host runtime containing the inert bootstrap request and status API through the existing reviewed Host source-update workflow. Publish its matching interface through the guarded publisher. This initial update does not touch the coordinator or enable automatic approval.
2. Prepare the exact replacement, private plan and rollback artifacts on Host. Validate the candidate with isolated state and ports. Register one pending bootstrap request. Creating the request must not freeze anything, change a launcher or select a release.
3. Show **Coordinator bootstrap** in Installation controls and the sidebar. The summary names the interruption and reason in one paragraph. Details contain source, artifact and plan digests, the fixed service, previous selection, rollback and policy change. A separate approval button authorizes this operation. Ordinary daemon approval cannot substitute for it.
4. After the owner approves that exact revision, the bounded executor acquires exclusive lifecycle ownership as specified below. Busy or changed installations return to review without touching daemons.
5. Activate and verify the coordinator, retain the old release and configuration, and report the actual selected and running revisions. Enable the protected Host policy only if its activation is included in the approved plan.
6. Use the replacement coordinator for subsequent maintenance. Disable new bootstrap submissions after successful ownership transfer; retain read-only history and recovery status.

## Approval and transport

Prepared release verification binds the Node executable, entrypoint, configuration, launcher and complete runtime tree. Configuration verification compares the current, rollback and candidate settings privately, preserving all settings except an explicitly planned Host restart policy. It requires the existing journal and owner-session paths. These checks remain separate from loaded-process and launcher verification; passing them alone does not admit a production bootstrap request.

The Host daemon advertises bootstrap support only when it has a valid private Host-only configuration and verifies its pinned installation identity. Dev does not register the API. Add explicit namespaced query, prepare, decide and status messages rather than routing generic commands or shell text.

Preparation and observation use the appropriate Host permissions. Approval additionally validates the installation owner password against the protected coordinator configuration and binds it to the exact request ID, revision and plan digest. Never infer approval from an unlocked label, a caller-supplied origin, Host request credentials, a relay role, or a successful status query. Passwords must not enter receipts, logs, queued payloads or the guest.

The existing HTTP-only owner cookie is scoped to the coordinator and cannot safely be forwarded through the daemon WebSocket. For the first bootstrap, the interface may need owner reauthentication in its approval dialog. It must say why. This is a one-time authentication requirement, not a second chat approval. A future explicit owner-session delegation protocol could remove the extra authentication, but is outside this bootstrap.

Approval consumes one immutable revision. Cancellation is supported until dispatch ownership is claimed. A changed plan, source, dependency tree, executable, configuration or selected base invalidates approval. Agents prepare requests and observe recorded decisions; they never click the owner's approval control.

## Immutable plan

The protected preparation record binds:

- Installation ID and expected coordinator service identity, including loaded executable, arguments and configuration path.
- Source commit and complete prepared artifact digest, including runtime dependencies, entrypoint, helper and Node executable.
- Candidate and previous release paths, fixed LaunchAgent identity, exact previous and candidate configuration and launcher digests.
- Restart-journal location and expected schema, owner-session store and other state paths to preserve. State contents are not copied into the plan or rolled back.
- The proposed Host approval policy, if any, and its activation boundary.
- A fixed rollback selection and bounded readiness checks, timeouts and recovery behavior.

Reject guest-writable or symlink-substituted control files, paths outside the protected installation, unexpected owners and mismatched installed identity. The executor accepts a prepared request identifier, not arbitrary paths, commands, arguments or environment overrides. Recheck the bytes actually used immediately before each selection change.

## First ownership transfer

The legacy process cannot honor a new filesystem fence, so a lock file alone is not exclusion. The first transfer needs an explicitly approved, bounded freeze of the fixed coordinator service. This operation belongs to the visible bootstrap executor and is never an agent-issued shell workaround.

1. Persist and fsync approval and dispatch intent in a single bootstrap record before interruption. This record tracks only the one-time operation; it does not modify the existing restart journal.
2. Verify the loaded service and process identity against the approved plan. Freeze that exact installation-owned service, then verify it is stopped and still the expected process. A watchdog must release a pre-transfer freeze if its executor fails.
3. Read the stable restart journal. If any approved or running daemon/supervisor job, unresolved restart hold or dispatched update exists, resume the coordinator and report busy. Preserve all requests. Pending unapproved requests are retained.
4. Account for preparation subprocesses. A frozen Node event loop does not stop an already running child. Refuse transfer while a child or an unresolved preparation owner remains; do not kill it or infer safety from a quiet journal. The child inventory and timeout behavior need isolated acceptance before this step is implemented.
5. Fsync the accepted journal and transfer intent. Unload only the fixed coordinator service. Wait for verified old-process exit and service removal; bootout's return value is not sufficient. Never start a replacement while the old writer might still exist.
6. Select the prepared launcher and configuration atomically, start the exact candidate, and let it claim the durable ownership generation before queue dispatch or reconciliation begins. The candidate must understand the handoff and keep dispatch fenced during readiness checks.
7. Verify installation identity, executable/artifact, source, state locations, listener, owner-session continuity and recovered journal. Only then release the dispatch fence and mark success.

A freeze watchdog must not resume the old process after ownership has advanced to unload or replacement. Its decision comes from the durable stage and process identity, never elapsed time alone. The executor and watchdog must share an exclusive claim and test every crash boundary.

## Failure and rollback

Before the old coordinator is unloaded, failure resumes the same verified process and preserves its selection. After unload, failures retain the dispatch fence until the executor identifies which process, if any, is running. The preapproved rollback can restore only the recorded coordinator executable and configuration, with explicit outcome verification. It cannot restart Host or Dev, roll back databases, restore an old restart journal, or erase pending requests.

If process identity, artifact integrity or ownership is ambiguous, expose **Recovery required** with the last durable stage and current observations. A plan may authorize one automatic restoration of its exact previous release. The independent watchdog must fence the recorded updater generation and acquire lifecycle ownership before that restoration; persist intent and verify the result. Never repeat an interrupted rollback. Recovery outside that approved scope needs its own exact tracked decision. Restarting the bootstrap Host daemon or reconnecting the browser must recover the record without replaying an operation.

Rollback must also preserve exclusivity: an old coordinator that cannot read the new fence must not start while the new coordinator or executor can still dispatch. Successful rollback ends the bootstrap attempt and leaves automatic Host approval disabled unless it was already present in the verified previous configuration.

## Implementation and acceptance checklist

- [ ] Add strict optional protocol contracts and Host-only service admission. Prove Dev credentials, unauthenticated relay sessions, forged origins and stale revisions cannot approve. Preserve old clients.
- [ ] Add the one-time protected plan store and bounded executor, with immutable byte verification and a single durable ownership generation. Prove duplicate submissions and concurrent decisions do not create two executors.
- [ ] Implement and verify the legacy freeze, child-process accounting, journal inspection and watchdog. Prove an approval arriving immediately before freeze is preserved and blocks transfer, and that a freeze failure does not leave hidden holds.
- [ ] Add replacement-coordinator dispatch fencing and generation claim. Cover late source preparation, cancellation during awaits, active jobs, loaded-service removal delay and startup with the wrong executable.
- [ ] Add Settings and sidebar display through the Host transport. Test desktop and compact layouts, exact approval, authentication failure, cancellation, reconnect and recovery-required state. Keep details collapsed by default.
- [ ] Test crashes before and after every durable stage, readiness failure and preapproved rollback in disposable fixtures. Verify only one journal writer and no repeated disruption.
- [ ] Prepare the real private candidate and rollback, submit the visible bootstrap request, and wait for its owner button decision. Verify the installed coordinator and preserved state after activation.
- [ ] Run tracked Host and Dev restart cycles. Prove that goals and only restart-held threads resume once, keyed messages and attachments retain identity and order, and manually paused, blocked and completed work stays untouched. Preserve Factory work and verify its connection without sending it prompts.

No item is complete merely because source compiles or a fixture process exits. Live activation remains pending until the owner-approved operation and its actual runtime outcomes are verified.
