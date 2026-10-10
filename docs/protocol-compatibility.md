# Protocol Compatibility

The app and the daemon are separate products that ship separately. A user updates the app from an app store or a desktop auto-update; they update the daemon when they feel like it. Every combination happens in the wild: new app against an old daemon, old app against a new daemon, and both sides months apart.

In development both sides are always the same version, which is why this is the constraint contributors miss most often.

Two contracts follow from it.

## The protocol contract: always compatible

A schema change must not break parsing in either direction. An old app still parses messages from a new daemon. A new daemon still parses messages from an old app.

`hello` carries an optional credential. The daemon accepts a client protocol version from its minimum through newer client versions, selects the lower of client and daemon maximum, and reports it as optional `server_info.protocolVersion`. A `hello.rejected` frame precedes an auth close only when the client sent `hello.auth` or advertised `hello_rejection`; older clients receive the existing WebSocket close code and reason. This avoids sending them a new top-level message their validator does not recognize.

- New fields are `.optional()` with a sensible default.
- Never flip optional to required, remove a field, or narrow a type. `string` to `enum` and nullable to non-null are both narrowing.
- A field you stop sending stays accepted. You stop writing it, you don't stop reading it.
- Wire schemas are pure structural declarations. No `.transform()`, `.catch()`, or `.preprocess()` on WebSocket message schemas — normalization happens in an explicit pass after validation. The reason is in [protocol-validation.md](protocol-validation.md): inbound validators are generated, and the generator only compiles pure schemas.
- Plain `z.union()` is forbidden when every branch shares a literal tag. Use `z.discriminatedUnion()`.
- `.default()` belongs on primitive leaves only, never on item schemas inside large arrays or big inbound containers.

Two questions to ask before you commit a schema change:

1. Does a six-month-old app still parse this message?
2. Does a six-month-old daemon still send something this app accepts?

If you can't answer both with yes, the change isn't done.

Schemas live in `packages/protocol/src/messages.ts`. New RPC names follow [rpc-namespacing.md](rpc-namespacing.md).

## The feature contract: per feature, gated once

Features don't have to work across versions. A new feature usually needs a new daemon capability, and old daemons don't have it.

The app checks for the capability and either runs the feature or tells the user to update the host.

- **No fallback paths.** Don't build a degraded version of the feature for old daemons. Don't fan out across legacy RPCs to simulate a capability that isn't there. The user updates or doesn't get the feature.
- **No defensive branches spread through the feature.** Detection happens in one place, and everything downstream reads a clean shape.
- Capability flags live in `features` on the `server_info` message (`packages/protocol/src/messages.ts`, the `server_info` schema).

Existing functionality keeps working across versions because of the protocol contract. Gating a new feature never substitutes for that.

## Client capability ownership

The client package advertises the protocol behavior it implements. Add each new capability to
its exhaustive defaults and implement the associated subscription or decoding behavior there.
The app, CLI, and plugins inherit those defaults; they supply only host resources such as browser
automation, or explicit overrides. A schema accepting a message does not establish support for
its delivery semantics.

On capable daemons, connecting creates no timeline or event demand. Client subscriptions own their network membership,
release it on unsubscribe, and restore it after reconnect. Raw message observers inspect traffic
without requesting streams. Application caches and which agents are visible remain caller-owned.

## Owned observations

`owned_subscriptions` and `server_info.features.ownedSubscriptions` negotiate the source-owned
contract described in [architecture](architecture.md#websocket-protocol). The client selects delivery
behavior once at its connection boundary. App workflows use the same observation interface on both.

With an older daemon, the client uses the existing connection and legacy RPCs. Directory subscriptions
remain shared and last-query-wins. Local handle IDs identify listeners; they do not promise independent
server filters. Timeline and event membership retain their existing shared behavior. Releasing a handle
detaches its listener and uses the old unsubscribe operation where one exists. Broadcast-only hosts keep
broadcasting; readiness there means local attachment, not a daemon acknowledgement. No extra sockets
or multiplexing emulation are introduced.

Preserve established workflows when changing delivery internals. Independent filters and quiet
connections require a capable daemon; opening the app, reading history and using terminals do not.
Pre-registry workspace grouping and legacy event normalization belong inside the client boundary.

Old clients keep their existing wire shapes and slot behavior at the daemon's source boundary.
The adapter keys legacy slots by physical socket, so an old connection cannot replace a modern
sibling's observation even when both use the same logical client ID. Optional wire IDs stay accepted
for parsing compatibility; modern requests cannot select their subscription ID.

## Every shim is tagged and dated

A shim that exists for old-app or old-daemon support carries a comment naming it, the version it arrived in, and when it can go:

```ts
// COMPAT(workspaceFileEditing): added in v0.2.0, remove after 2027-01-18 once daemon floor >= v0.2.0.
```

`rg "COMPAT\("` is the full cleanup backlog, so:

- One tag per shim, at the site that has to be deleted.
- Give it a name, a version, and a removal condition or date. Six months out is the usual default.
- Never bury compatibility in an untagged `??` fallback or an optional-chain tunnel. Untagged back-compat never gets removed, because nobody can find it.

When a tag's condition is met, delete the shim and the tag in the same change.

## QA

Tests don't fully cover compatibility. If you touched `packages/protocol`, say in the pull request why an older app still parses your message and why an older daemon still satisfies your app. See [qa.md](qa.md).

## Schedule configuration revisions

Schedule configuration edits can use `expectedConfigurationRevision` when the host advertises `scheduleConfigurationRevision`. Pass the revision returned by inspection, or explicit `null` for a legacy record without one. The daemon compares it within the serialized update and rejects a stale edit before changing the record. Reload and reconcile edits after a conflict. Omitted revisions retain older clients' partial-update behavior.

Configuration revisions change when the name, prompt, cadence, target configuration, maximum runs or expiration changes. Run history, quota observations and pause/resume activity preserve them. Revisions protect configuration edits; they do not establish quota authority or reset account accounting.

The schedule update CLI inspects the record before editing and supplies its revision on capable hosts, including explicit `null` for a legacy record. It reports conflicts without retrying. Older hosts retain ordinary partial updates when no revision is present; a known revision is never discarded to force a write.

## Schedule quota policies

A client must require `server_info.features.scheduleQuotaPolicy === true` before creating a schedule with `target.config.quotaPolicy` or updating `newAgentConfig.quotaPolicy`, including explicit removal with `null`. An older daemon may discard an unknown policy field and launch ordinary work. The client rejects these writes before transmission rather than retrying without the policy. Schedule writes that omit the policy retain their existing compatibility behavior.

The capability means the daemon recognizes quota policies and fails closed when it cannot execute governed work. It does not certify available usage telemetry, account authority, a ready execution backend, or permission to remove an enforced account policy. Those remain server-side admission requirements. Protected writes use the existing nonqueued request path, so a disconnected client cannot replay them onto a different host after reconnecting.

Policies with `estimatedHourly` also require `estimatedHourlyQuota`. Older
quota-aware hosts may strip that optional field; clients must reject the write
before transmission. The capability recognizes the policy and holds missing
estimates. It does not certify a configured observer or execution backend.

Estimated accounting uses a persisted hour of increases in the bound weekly
allowance window, including usage outside the scheduled execution. It is not
attributable billing. Missing history, a read gap beyond the freshness bound,
an account or authentication change, or a quota reset requires a new continuous
hour before admission. Native observations remain separate from these estimates.
Confirmed execution termination can release an estimated-policy execution slot
without a provider billing receipt; retained estimates still govern subsequent
admission. Strict consumption policies retain their settlement requirements.

## Governed run custody

Before preparation, the scheduler saves an optional `governorPreparation` attempt identifier and occurrence timestamp. This record survives a crash before a run exists. A retained attempt requires trusted reconciliation before another preparation, and blocks deletion or custody-changing edits, including replacement by name. A missing driver cannot clear it. The driver must journal its exact reservation and execution custody before acquiring resources; scheduler metadata is not that authority journal.

A governed run records optional `governorBinding` metadata containing its verified account and reservation identifier. Admission atomically transfers the preparation identifier into `governorPreparationId` on that run. Resumption requires the exact retained binding; a legacy run without one needs reconciliation. These fields link recovery records and do not grant execution authority.

Unused prepared work must revoke dispatch immediately and freeze through trusted custody, including when persistence fails or the schedule expires. Freeze completion means durable state and verified settlement, not an interrupt acknowledgment. It preserves accounting reservations. Failed cleanup retains the preparation or bound run for recovery.

Restart recovery, edit guards and deletion guards recognize unfinished governed work independently of the schedule's editable quota policy. A frozen run remains unfinished. Deletion checks run inside the schedule mutation, and admission verifies the current record before asking the driver to prepare work. Older clients may omit these optional response fields, but replacing the daemon with a policy-unaware version still requires separate installation safeguards.

## Shared provider removal

Clients require `server_info.features.installationProviderRemoval === true` from each configured environment before removing a provider from the shared catalog. The optional `removed` marker preserves identity and credentials while disabling new launches.

Owner settings requests opt into this marker with `X-Vorteo-Provider-Removal: 1`. Responses to older clients omit it because their provider schema rejects unknown fields. While a removed provider exists, older clients cannot replace the provider catalog; they receive a revision conflict and must refresh to the current client. Other shared settings remain editable. Upgraded clients restore a definition explicitly with `removed: false`.

## Blocked checklist items

Daemons advertise `features.checklistBlockedStatus`. Clients require it before writing
`status: "blocked"`, and advertise `checklist_blocked_status` to receive that value.
Older clients receive blocked items as incomplete pending items in checklist replies,
agent snapshots and todo timelines. The stored status and task metadata remain unchanged.
A stale edit using the downgraded snapshot fails its existing `expectedTask` check.
The blocked status is discretionary and independent of `blockedBy` prerequisite edges.

## Thread journals

Daemons advertise `features.agentJournal`. The interface gates the journal card on that capability. Journal entries travel as an optional `journal` array in existing agent snapshots; older clients ignore the field, and newer clients still accept snapshots that omit it. No new WebSocket message type is sent to older clients. The caller-bound MCP tools assign append sequence and timestamp on the server, commit before broadcasting, and deduplicate retries by entry ID. Ordinary agent snapshot writes preserve the durable journal.

## Workspace project membership at creation

Clients require `workspaceCreateProjectMembership` before including optional
`projectMembership` in `workspace.create.request`. The daemon persists membership
before publishing the workspace and retains it in creation receipts and retries.
Requests without membership retain directory-based project placement. Older
clients remain compatible; newer clients refuse project-bound creation on older
daemons rather than creating a workspace under the wrong project.
