# Managed preview monitor replacement

The Dev preview monitor is `/home/paseo/.local/bin/paseo-preview`, one root:root file with mode 0755 in the existing immutable Dev container. It is separate from the signed macOS permission helper. Replacing the monitor does not start, stop, hold or restart a service.

The coordinator accepts a distinct `preview-monitor` journal record. Only the trusted Host request credential can prepare or inspect requests. Only owner-authenticated Installation controls can approve or cancel the exact operation, request UUID, revision and plan SHA-256. Automatic Host restart policy never approves monitor work. Cancellation remains available through validation until durable dispatch intent.

## Activation preparation

Prepare a coordinator release and a compatible recovery release that both include the monitor journal reader. Keep recovery configuration identical to the previous configuration, including private Factory adoption settings. The candidate's optional `previewMonitor` configuration binds Docker, its socket, immutable container ID, fixed home, protected filesystem-worker path and digest, and the retained recovery Node executable, journal reader and queue module paths and digests.

Activation uses the existing coordinator bootstrap operation and its own exact owner button. Bootstrap review advertises `coordinatorBootstrapPreviewMonitor`; clients opt in with `previewMonitor: true` on list, preparation and decision requests. Without opt-in, replies omit monitor configuration changes while preserving the original plan digest and cancellation. Hidden enable and explicit removal changes both reject approval before calling the decision service. Clients refuse preparation of either change on a Host without the advertised capability. Set `previewMonitorConfiguration` to that reviewed configuration. Admission binds the container and recovery executable to the bootstrap plan. Capability advertisement and every monitor validation execute the retained reader and fenced in-memory queue against a complete monitor record and exercise the running reader and queue. Missing or incompatible recovery support leaves the capability unavailable. A parser marker alone is insufficient. Existing coordinators reject the new plan and journal target rather than interpreting them as daemon work.

Do not write live configuration or activate services while preparing this source workflow. Coordinator activation, monitor replacement and native-helper installation each require their own request and approval.

## Monitor preparation

Use `monitor-inspect` with the Host client to read the fixed selection, ownership, bytes digest and full ancestry digest. This inspection does not replace bytes or create a lifecycle request. Retain the exact selected monitor bytes and prepare candidate bytes in protected Host files outside all guest-writable mounts. Record the source commit, immutable container ID, current digest, root ownership and 0755 mode, and the inspected full directory-ancestry digest in a version 1 `preview-monitor-replace` plan. The fixed target and distinct candidate/before digests are mandatory. Preparation reads and verifies artifacts without replacing the target.

After managed activation advertises `previewMonitor.available`, submit an authorized replacement using the installed Host client:

```sh
node installation-agent.mjs --config /protected/host-agent.json request-monitor --request-file /protected/monitor-request.json
node installation-agent.mjs --config /protected/host-agent.json monitor-status REQUEST_UUID
```

The client returns the exact Installation review URL. Opening it grants no approval. Review the reason, container, target, source, candidate digest, retained-before digest, ancestry and plan digest. Click **Replace preview monitor** or **Cancel**. Do not use another environment's credentials to change provenance.

## Filesystem commit and uncertainty

The protected worker executes as uid:gid 0:0 against the immutable container ID. It permits the existing Dev uid 1000 home ancestors without changing ownership or mode. Each ancestor must remain a directory without group/world write permission. Target ownership stays root:root, mode 0755, regular and single-linked. The worker pins directory descriptors, binds their identities to the reviewed ancestry, and revalidates the full selected pathname and every edge before and after commit. Holding a descriptor alone does not establish that the selected live path still names it.

The worker exclusively creates a private request directory under `/var/lib/vorteo/preview-monitor-maintenance`, retains and fsyncs the before bytes, and saves an uncertain receipt before commit. It exclusively acquires a monitor lock, stages the approved bytes, fsyncs them, rechecks the selected file and staged identity, saves durable commit intent, rechecks again, then atomically exchanges the staged and selected entries within the pinned parent and fsyncs that directory. Linux requires `renameat2` with `RENAME_EXCHANGE`; unsupported filesystems fail closed without ordinary rename. The displaced entry remains at the staged name and its exact bytes are also retained in the private request directory. Its inode identity and bytes must match the reviewed before selection, otherwise the receipt remains uncertain and no automatic rollback occurs. Existing uid 1000 parent ownership does not serialize other writers; the exchange preserves an entry replaced inside the final commit boundary. Selected ancestry, installed bytes and receipt are checked again before success. The Host transport performs another selected-path inspection before returning success.

Changed ancestry never produces installed success. Writes remain relative to pinned descriptors, so replacement ancestors cannot redirect them. An interrupted request, existing request directory, abandoned lock, transport error, changed selection or receipt mismatch requires inspection. The coordinator fences further lifecycle dispatch and records `recovery_required` after ambiguous dispatch. It never replays or rolls back automatically. Retained bytes and the request receipt are evidence for a separately reviewed recovery operation; this workflow provides no automatic cleanup or uncertainty-clearing button.

Monitor dispatch shares the coordinator's single lifecycle exclusion. Unreleased restart holds, native-helper uncertainty and Factory recovery fences prevent monitor dispatch. Monitor uncertainty prevents further lifecycle dispatch. Coordinator maintenance rejects unresolved monitor work.

## Validation boundary

Filesystem tests use disposable mapped roots owned by the test account. Transport tests use injected commands; HTTP tests use a disposable loopback coordinator and fake executors. They never execute Docker against the protected target. No live monitor installation, security change, coordinator submission, service invocation or publication is part of source preparation.
