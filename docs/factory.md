# Bundled Factory

The first source candidate bundles a read-only Factory observer in `plugins/factory/`.
It does not install or adopt a controller, create coordinators, launch workers or change
schedules. Live installation requires an independent review and coordinated deployment.

## Observation contract

`shared/contracts.ts` owns the plugin RPC schemas. `factory.snapshot` verifies that the
requested project appears in the serving daemon's active project registry. Its `serverId`
comes from the plugin session handshake, never the request. Clients must match that identity
to their selected host. Until a trusted controller binding exists, controller freshness and
coverage are unknown, installation and revision are null, allowance measurements are null,
and every action capability is false.

`activity.receipts` currently returns unavailable with `receipts: null`, incomplete coverage
and no continuation cursor. It does not read journals. A supplied cursor is expired and
reports a gap. Empty arrays must never substitute for unavailable receipt observation.

The receipt schema separates the source event time, observation time and independent
verification time. Merge and publication records require repository, immutable source commit
and delivery identity. A verified shipment also requires retained independent verification;
schema validation only checks structure and consistency, not source authenticity. Native
thread observations cannot count as verified shipment. The eventual producer must verify
canonical repository links and bind pagination to the serving host, project and filter.

Snapshot collections have fixed bounds and independent coverage declarations. A producer
that caps a collection must disclose incomplete coverage. `builds.latestRelease.publishedAt`
is the original publication time; verification time cannot advance a daily release clock.

## Controller adoption

The existing controller uses the native governed schedule runtime, captured selected-account
clients and launcher-held ownership fencing. Its startup may recover executions and configure
accounting. Importing that runtime to observe status would mutate state and could create a
second owner. The bundled observer therefore does not import or start it.

Adoption must preserve the installed controller's singleton, durable journals, selected
account, worker profile, existing native schedules and exactly two coordinator identities.
Retained uncertain execution custody must be reconciled before any owner replacement.
Controller source packaging and installation are separate operations. A plugin reload must
not revoke or replace the existing runtime owner merely to reconnect its interface.

The native startup adapter can restore observation for an exact completed installation after
a restart. It verifies the retained owner, checkpoint, configured profile and both coordinator
identities without rebinding membership or admitting execution. Incomplete checkpoints and
reconciliation holds refuse restoration. A hold raised during verification also rejects the
operation. The private startup caller must supply the reconciled owner; this adapter does not
make an unconfigured installation operational.

The native source boundary accepts an optional read-only projection from that same startup-owned
runtime. Only the loaded built-in Factory can delegate its two observation RPCs to it. The service
checks captured owner generation, serving host, active native project, repository, persisted
coordinator membership and exact agent identities before and after each read. A mismatch rejects
the read. A plugin reload resolves the same observer and does not replace or stop its owner.

The service parses bounded canonical DTOs and validates GitHub delivery links against the bound
repository. Current snapshots require a coherent revision and observation time. Archived
coordinators require a visible recovery hold. All action capabilities remain false. The retained-controller provider and native startup boundary are implemented in source.
Production owner attachment, installation and independently verified delivery evidence remain
required. The projection must exclude journal records, credentials, account inventories
and private paths. Reading a release journal does not establish a verified publication.

## Native binding and lifecycle boundary

The optional wire relationship is `WorkspaceDescriptor.factoryMembership`, containing
`installationId`, `projectId`, `serverId` and `role` (`factory`, `builds` or `worker`).
The proposed capability is `factoryWorkspaceMembership`. Native source now persists the
relationship through an internal authority seam and reserves coordinator roles in the registry
transaction. Ordinary archive and removal reject retained ownership, including archived
backing paths shared with an ordinary sibling. The native authority adapter, atomic coordinator binder and initial installation service are
implemented in source. A production owner reconciliation permit and installation remain
unavailable; the daemon does not advertise membership support merely because source exists. The interface cannot infer membership from titles, directories, labels
or Standing state.

A later native binding service must validate the exact relationship and persist it before
controller admission. Ordinary workspace archive, thread archive, bulk archive and project
removal must reject managed members at the daemon boundary. Generic protection toggles must
not remove this ownership. Supported worker cleanup must establish completion, retained
evidence and reconciled execution custody before retiring the relationship. Owner disable
must reconcile active work before removing it. Neither operation may accept a worker-supplied
boolean bypass or create another registration to evade a refusal.

## Installation and CLI boundary

The source candidate adds `paseo factory status <project-id>` with the existing host
selector and table, JSON and YAML output. It reads the same `factory.snapshot` contract
as the interface, checks the serving host and exact project, and preserves unavailable
measurements. It does not substitute fixtures when transport or validation fails.
Setup and guarded initial installation also use the shared native service when the selected daemon supports it.
The server package builds and exports the canonical plugin contracts for the CLI;
the schemas remain authored in `plugins/factory/shared/contracts.ts`.

Install, status, configure, pause, resume, upgrade and disable must share one native installation
service with the project menu. An observer without a reconciled native adapter cannot advertise installation or dispatch a successful mutation. Repeat installation must discover and adopt an existing identity instead
of creating another controller or coordinator. Commands need the expected installation identity
and coherent observed revision; a null revision does not establish mutation preconditions.

Pause stops new admission while admitted work continues. Stop retains recovery custody. Disable
and upgrade reconcile ownership before replacing or shutting down coordination. These operations
must use native schedule, account and execution mechanisms; they do not add a scheduler, quota
polling loop or merge cap.

### Native owner controls

The built-in interface reads `factory.controls` and dispatches `factory.control` through the
same installed native adapter. Optional startup-owned control ports provide pause, resume and
stop. Without those ports or completed membership, the interface reports controls unavailable.
The legacy setup response keeps its existing false lifecycle flags.

Each action binds the serving host, project, installation, revision and operation identity.
The interface refreshes state before dispatch. Resume requires the displayed revision; pause
and stop can interrupt an outstanding resume using the fresh revision. Lost responses remain
visible and are never retried automatically. Private diagnostics are not returned to clients.
The retained owner must persist intent and reconcile interrupted operations before resuming;
these ports do not create another controller or renew account authorization.

### Guarded CLI installation

`paseo factory setup <project-id>` reports the serving identity, native revision, setup state
and install availability. It reads no fixtures. `paseo factory install <project-id>` requires
`--expected-server-id`, `--expected-revision` and a stable `--operation-id` from that attempt.
The command reads setup again from the selected host and rejects changed, held or already
installed state before dispatch. The native adapter supplies the selected account, configured
profile and exact coordinator pair; the command has no selectors for those values.

A refused or uncertain result exits with an error and retains its correlated native details
in structured output. Transport loss or invalid identity after dispatch requires reconciliation
of the original operation. The command never retries installation. These source commands do
not authorize controller adoption, deployment, account changes or a daemon restart. Other
operations remain unavailable until their reconciled native handlers exist.

### Time-limited prepaid execution

The native policy source supports optional `prepaidAuthorization` for one exact weekly
allowance window. Its start and expiry bound a positive interval of at most 24 hours.
The trusted account envelope and the worker policy must both authorize that window;
native admission intersects their intervals. A worker request cannot create account authority.
SDK schedule changes require the advertised `prepaidQuotaAuthorization` capability.

During that interval, the matching weekly reserve floor and occupancy estimate do not stop
prepaid execution. They do not measure prepaid spending. Other windows, configured consumption
meters, fresh authenticated account observations, native custody, concurrency and manual pause
remain enforced. Expiry refuses admission and resume, revokes dispatch permits and freezes
active execution even if a telemetry read stalls. Settlement of already stopped work remains
possible with its required accounting evidence after expiry.

This source support does not establish prepaid balance, a monetary spending ceiling or model
billing attribution. While the matching authorization is active, Factory reports null usage and
limit points rather than displaying allowance occupancy as prepaid cost or an enforced paid limit.
The original native measurement timestamp remains distinct from snapshot time. The owner authorization and exact account identity stay in private native
configuration and evidence. Installing this source and applying an account policy are separate
operations; an older installed governor still enforces its existing weekly policy.
