# Launch presets and managed workers

Profiles define reusable launch settings. Managed installations keep one authoritative profile library in the installation coordinator. Daemons receive projections, while legacy launch references remain compatible. The web and native clients share editor and composer components.

For the experimental fork's host migration, pending work and destination acceptance checks, read [the host handoff](host-handoff.md).

The Vorteo composer opens the selector with Choose profile on every screen size. The menu shows saved profile names with their model and reasoning summaries. Vorteo has no separate task permission control or command-menu permission override. The profile inspector shows saved profile permissions. Existing chats retain their permissions after profile edits; a warning appears when the saved profile differs, with an optional Recreate chat action that opens the handoff review. Recreation creates a new chat with the selected profile’s permissions and preserves the original chat. Stop the current turn and active workers before recreating. Task permission controls remain available.

## Shared provider preferences

Hosts advertising `sharedProviderPreferences` store versioned preferences in `daemon.sharedProviderPreferences`. Provider type follows configured `extends` ancestry. Generic ACP registrations remain separate provider types. Account credentials, usage and reset operations stay account-scoped.

Provider defaults resolve first, workflow fields override them, and an explicit model or reasoning selection overrides those two fields at launch. Feature values merge by key. Shared launches use the workflow's resolved permission mode; a stale client permission value cannot override it. The daemon checks the selected account's catalog before creating the agent. An unavailable model or reasoning level is an error, never a substitution. Reasoning changes do not select worker teams.

Hosts advertising `accountIndependentProfiles` expose one `shared-profile/<provider-type>/<workflow-id>` identity per profile. The picker chooses an account separately and retains the selected profile when switching compatible accounts. It hides profiles with a model or reasoning level missing from a successfully loaded account catalog. Loading and failed discovery are separate states, with Retry for failures; Manage profiles retains saved definitions with specific compatibility details. The shared editor uses the current account's catalog and labels its scope. It captures the configuration revision when opened, retains edits after a conflict, and requires reopening against the current revision.

Settings shows one provider family at a time. Provider defaults apply to that family's accounts; individual profiles configure worker teams. The worker editor first selects an account, then an eligible profile with an explicit model. Cross-provider delegation remains supported. Saving provider defaults moves any previously inherited worker settings onto existing profiles, preserving their teams. New profiles start without workers. Unavailable saved worker references remain visible and are not silently cleared. Explicit worker account editing requires support from the installation coordinator and every environment. Until then, the editor retains saved teams and explains the required update.

Skill choices are filtered by the provider's discovered inventory in the selected environment. Saved references missing from that inventory remain visible with a removal action. Inherited skills stay collapsed until customization is opened.

A launch freezes the effective profile, worker target and configuration revision. Later edits affect future launches. Existing chats keep their permission snapshots and can use the permission warning's reviewed recreation flow. Shared workflow IDs are opaque launch references; clients must require the capability before submitting them.

### Profiles across execution environments

The protected host and container installation synchronizes shared workflows, provider defaults, and preferred model and reasoning choices through its native coordinator. Synchronization continues with every browser closed. Accounts, credentials, provider commands, and discovered model availability remain local. Selecting a shared workflow still requires its exact model and reasoning choice to be supported by the selected environment.

Every configured environment must support installation profile authority and be reachable for the initial import. The coordinator backs up profile configuration privately before combining the libraries. Imported workflows receive stable installation identities. Environment-local aliases preserve existing shared launch references, including when two libraries used the same ID for different behavior. Local legacy launch bindings remain local and continue to resolve. Imported workflows inherit shared defaults where their behavior matches; differing behavior remains explicit. Legacy account-qualified launches preserve existing worker account references. New canonical launches bind same-provider workers to the parent’s selected account; a worker from another provider, such as Pi, keeps that provider. Worker model and reasoning settings come from the worker profile.

Account labels do not establish identity. Reconcile accounts using authenticated identity observations and retain each environment's provider IDs and credential homes. A profile projection does not authenticate an account or enable a disabled connection. An account without credentials requires sign-in before it is ready in that environment.

The coordinator owns one profile library and persists edits before projecting them to environments. Editors submit the revision they read; stale writes require a reload and review. Environments do not maintain independently editable copies. Profiles are available in both environments by default, with explicit exclusions configured in the profile editor. Exclusions affect new launches; existing chats keep their frozen launch snapshots. Disconnected environments apply the canonical configuration after reconnecting.

Shared daemon settings are checked against the coordinator before an environment accepts changed values. Independent daemon edits and configuration reloads cannot replace shared policy. Local credential and path edits remain available when the coordinator is offline.

Terminal profile names, commands, arguments and icons are shared installation settings. Working directories, environment variables, credentials and provider processes remain local. Excluding a terminal profile preserves its local bindings so re-enabling it does not erase them.

Back up the coordinator's private shared profile journal and migration receipt together with each daemon's provider-preferences migration receipt. Restore matching configuration and artifacts when rolling back a daemon migration. The runtime requires updated daemon and coordinator artifacts; a web-only publication does not activate synchronization.

### Migration and recovery

The host migrates the existing profile list on startup only when no shared preferences exist. It compares behavior including unknown extension fields, preserves model, permission, instruction, feature and worker differences, and preserves reasoning differences as distinct profiles. Exact effective duplicates are consolidated with compatibility aliases; legacy value overrides do not become additional library entries. Names from retained profiles remain editable workflow names. Fields equal to provider defaults inherit those defaults.

Before writing configuration, the store writes a private mode-0600 receipt under `backups/provider-preferences-v1` in the host's Paseo home. It includes the previous persisted configuration, source profiles, merge report and proposed preferences. Startup after a completed migration reuses the saved revision and does not repeat migration. Failed transactional application restores the preceding configuration.

Legacy profile bindings retain account, model and reasoning selections, so worker and legacy launch references remain resolvable without rewriting session history. Schedules currently store explicit launch settings rather than profile IDs; migration leaves those settings unchanged. Workflows with retained legacy bindings cannot be deleted during compatibility support. An older editor's explicit change to a legacy profile detaches that record from its binding and preserves account-specific behavior; it cannot silently rewrite a shared workflow. Shared settings saves use revision checks.

For installation rollback, retain the private receipt together with the preceding daemon and web artifacts. Stop the updated instance through the approved host lifecycle, restore the receipt's `persistedConfig` to its original configuration file, and start the preceding daemon. Restoring old configuration under the new daemon starts migration again. Restoring configuration does not undo workspace edits or change existing chat snapshots. Never copy recovery receipts into Git.

This section describes source behavior. Activating it in an existing installation requires a tested daemon build and coordinated restart; publishing only the web interface cannot enable the capability.

## Configuration and compatibility

A profile can include `instructions`, `workerProfileId`, and `maxWorkers` in addition to its existing provider, model, reasoning and feature values. Worker profiles require an explicit model and cannot reference another worker. Names and model IDs remain user configuration.

New hosts advertise `agentProfileLaunch`. A launch request carries `profileId`; the server resolves the current profile and freezes its instructions and worker configuration into the stored session. Later profile edits affect new tasks, not resumed tasks. The profile supplies the permission mode when the launch has no explicit task override. The Vorteo client applies the profile permission mode to drafts and sends it explicitly on handoff launches. Profiles without a mode use the provider default. Native resumption reapplies the frozen task mode. Governed Factory workers retain their coordinator-selected confinement independently of supervisor permissions.

New editors send `expectedAgentProfiles` for stale-write detection. The server preserves omitted instruction and worker fields from older editors. Empty strings explicitly clear instructions and worker references. An older host does not expose these launch-only controls.

## Supervision

The supervisor uses existing Vorteo agent tools. Its frozen worker reference determines the child profile and maximum concurrent managed workers. Child creation and execution enforce the limit. Managed children cannot detach through `create_agent`; recursive worker presets are rejected. Team presets require agent-tool injection to be enabled explicitly.

This is lifecycle coordination, not a new security sandbox. Pi has no native selectable permission modes. In a per-person container, Pi can access that person's mounted projects and keys. Other processes and native provider subagents are outside the managed-child concurrency limit. See [the optional deployment recipe](../docker/multiplex/README.md).

## Quota stops and explicit successors

The Codex adapter maps structured `usageLimitExceeded` errors to a provider-neutral `quota_exhausted` event. Transport errors do not imply exhausted quota. The manager persists `quotaPausedAt`, blocks subsequent turns and worker creation, cancels active managed teammates, and suppresses completion-triggered wakeups. A confirmed account reset clears earlier quota-exhaustion locks for that provider so you can send the next message in the same thread. It does not send a prompt or clear a reserve stop. Interrupted edits are not rolled back.

Selecting a preset for an existing task opens an editable handoff review and creates a separate successor only after confirmation. It initially copies at most 30 recent text messages and 50,000 characters without making an inference request to the old account. Active managed workers block the handoff. It uses the selected profile’s permission mode for the new task. Attachments, tool outputs, and provider-private state are not copied automatically. The original task remains available for review. Model or reasoning changes made through Classic controls mark the original preset label as modified.

Quota suggestions use fresh reported capacity on a different provider instance. Unknown, stale, and exhausted quotas do not qualify. This is advisory, not account pooling or automatic failover. One account may have multiple aliases; users should avoid treating those as separate allowances.

## Pi model details

The Pi account pane shows saved profiles with their resolved model and reasoning summaries. Manage models and profile configuration in Settings. These values describe Pi’s configuration, not a gateway’s advertised maximum. Discovery does not enable models, change limits, or send an inference request.

## Local endpoint status

Local Pi models with an explicit private or loopback HTTP endpoint can report TCP reachability in preset rows. The daemon probes at most sixteen distinct endpoints per catalog refresh and shares each probe across models on that endpoint. The check sends no inference or authentication request. Reachability does not prove that a model is loaded, authentication works, or inference capacity is available. Observations older than two minutes are displayed as stale. Cloud Pi configurations do not inherit a local or free label.

The active Vorteo composer preloads preset catalogs, usage, and reset credits before the picker opens. It reveals the menu only after the initial reads settle, including explicit unavailable states for failed reads. Local endpoint status refreshes at most once per minute. Catalog discovery failures offer Retry in the profile chooser. Local rows also show running child agents for that configured provider in this Vorteo instance. The daemon samples its live agent manager when responding to usage requests, independently of cached subscription balances. The active composer polls this read every fifteen seconds and marks activity older than thirty seconds stale. Counts include children with an admitted active run before a provider reports running. They exclude supervisors, idle or initializing children without a run, native provider subagents, and other instances. They are provider-wide counts, not model-specific slots or MTPLX queue capacity.

## Account reset credits

On supported hosts, preset rows and provider Usage cards show the number of reset credits reported for that account. Unknown availability is not zero. Credit details include the account identity, grant date, expiry when reported, and last refresh time. The reported total remains authoritative when the provider supplies only a partial list of credits.

Opening the badge only reads account details. Where the provider supports credit selection, the earliest-expiring available credit is selected initially. Review reset opens a separate confirmation showing only the credit bound to the operation. Use 1 reset credit submits that exact credit; an unavailable selection requires another review. Providers without selection support show “Provider chooses the credit.” The daemon verifies the configured account again before submission. Read access alone cannot prepare or redeem a reset, and agent tools do not expose redemption.

Reset management uses separate account-scoped RPCs so older hosts and clients can continue using existing usage messages. The daemon checks the configured CLI's actual reset and idempotency support before enabling redemption. It does not guess support from a version number or use an unrelated desktop account.

Aliases for the same account share a persistent operation record under the Vorteo home. An interrupted confirmation retains its operation key across daemon restarts. Explicit retry reconciles that same operation, including when the available count has already fallen to zero. It does not allocate a new key to resolve uncertainty. Back up these records together with the person's Vorteo home.

Results distinguish applied, already redeemed, no credit, and nothing to reset. A failed balance refresh does not turn a confirmed result into an unknown redemption. Redemption neither buys credits nor switches accounts or resumes work. A successful reset unlocks earlier quota-stopped threads on the selected provider. Newer quota stops remain locked, and duplicate confirmation uses the original operation cutoff. Grant schedules and availability remain provider-controlled.

## Review boundaries

Vorteo has one product behavior. There is no Standard or Paseo mode switch. Legacy mode preferences are discarded without deleting accounts, profiles or running tasks. Installing Vorteo does not install a separate Paseo app; independently installed Paseo is configured through its own interface.

The profile picker shows Environment, Account and Profile cards on desktop, with collapsible sections on mobile. Environment selection chooses where work runs. Profiles are installation-wide, and their availability controls provide explicit environment exclusions. Selecting a different environment in an existing chat opens a handoff review in the same project. Review the working directory before creating the successor. The source chat retains its history, paths, attachments and provider state. Profile editing and account connections remain in the shared Settings interface. Credentials and runtime capabilities remain environment-specific.

Check [implementation and deployment status](#implementation-and-deployment-status) before relying on the reserve policy below.

The Docker recipe is optional. Upstream core does not require Docker, MTPLX, a particular account naming scheme, or an inference gateway. Keep deployment changes reviewable separately from profile UI, launch resolution, and quota lifecycle changes. Local builds must be reviewed before any upstream publication.

## Default configuration

Shared provider settings select a default workflow per provider type. New drafts use an available workflow for the selected account. Saved drafts restore the account and workflow together. A profile exclusion prevents new launches in that environment without deleting the profile or changing existing chats.

Legacy hosts retain their original default-profile marker during migration. The installation editor saves canonical defaults with revision checks; it does not write separate host and container defaults. New installation profile launches require the coordinator to be reachable. Existing tasks retain their frozen launch settings.

## Implementation and deployment status

Source review on September 16, 2026 found reserve policy validation, frozen launch policy, admission checks, usage polling, transitions, persistence and startup reconciliation in the daemon. See `packages/server/src/server/agent/quota-reserve/` and `create-agent/profile.ts`; bootstrap wires the observer into the manager. These foundations have focused tests, including `bootstrap-quota-reserve.e2e.test.ts`.

The app has no reserve-policy controls or launch selection wired to this policy. Complete the Vorteo controls, capability gating, task-control transport and end-to-end acceptance before presenting Cruise Reserve or Redline as available to users. A saved preset alone does not attach reserve protection: the launch must explicitly request a policy. Existing tasks do not acquire one automatically.

This describes the checkout, not an installed image or private web release. Record the tested daemon revision, image digest, served web receipt and feature-specific results in the private handoff. Current deployment status is unverified by this source review. Do not infer it from a version label, an old acceptance note or the existence of tests. The contract below remains the acceptance target.

## Quota reserve implementation contract

Approved September 10, 2026. Cruise Reserve defaults to 15 percent remaining; Redline defaults to 10 percent. Profiles provide defaults, tasks freeze the effective policy at launch, and an explicit task override can disable reserve enforcement. Actual provider quota exhaustion remains enforced with reserve Off. Do not attach the new policy to existing tasks automatically.

Below Cruise Reserve, let already-running turns finish and block new turns and managed workers. At or below Redline, request immediate cancellation of active turns and managed workers. Cancellation and usage-reporting latency can consume allowance beyond Redline; it cannot guarantee a retained balance.

Evaluate every applicable rolling window separately. Only fresh observations with all required windows above Cruise Reserve can automatically continue work paused by that policy. Equality retains an existing pause. Missing or stale usage blocks admission and automatic recovery but does not fabricate a Redline crossing. A Redline stop requires explicit continuation after recovery. Actual quota exhaustion requires a confirmed account reset or a reviewed successor. Completed, manually stopped, archived, and exhausted tasks never wake automatically.

Keep policy state separate from `quotaPausedAt`. Persist stop reason and continuation eligibility before effects, serialize admission against policy transitions, and reconcile interrupted work on daemon startup before permitting continuation. Enforce the policy with every browser closed. Share observations by verified account and quota scope; task thresholds remain independent. Purchased credits and unrelated code-review limits do not establish coding-task capacity.

The third borderless composer control follows permissions and shows both thresholds. Require the daemon capability for presentation and new launch policy attachment. Existing tasks retain their attached policies. New protocol fields stay optional; unsupported hosts require an update rather than browser-only enforcement.

Acceptance includes threshold equality, multiple windows, stale data, manual stops, worker completion races, restart recovery, and duplicate wake prevention. Deploy through the [instance continuity workflow](instance-continuity.md); source and web publication alone cannot activate daemon enforcement.

### Explicit worker accounts

`workerProfileId` identifies the shared worker definition. The optional `workerAccount` field binds it to a specific account; installation edits use a portable installation account reference so each environment can resolve its own local account ID. Existing profiles without this field keep their previous account resolution. Launch refuses a missing, disabled or mismatched explicit account instead of substituting another account. The `explicitWorkerAccounts` daemon capability and the installation snapshot's `workerAccounts` flag gate editing during mixed-version updates.
