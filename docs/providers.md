# Adding a New Provider to Vorteo

Add new providers through the plugin SDK. The core adapter patterns below describe the existing
server integrations.

## Plugin providers

Keep a bundled provider in `plugins/<id>/` and register it through
`@getpaseo/plugin/server/provider`. Antigravity and Muse Code follow this pattern. Built-in loading and SDK
import rules belong to [plugins.md](plugins.md#built-in-plugins); the
[public provider guide](../public-docs/plugins/providers.md) covers the provider contract.

The plugin owns the CLI transport, session state, catalog, and capabilities. The daemon owns
executable resolution and applies `agents.providers.<provider-id>.command` and `env` before
connecting. Register the provider's icon with the plugin rather than adding it to the app's
provider icon map. You do not need a core manifest entry or provider factory.

| Provider    | Transport                                  | Setup and limitations                                            |
| ----------- | ------------------------------------------ | ---------------------------------------------------------------- |
| Antigravity | Installed `agy` CLI                        | [Antigravity](../public-docs/supported-providers.md#antigravity) |
| Muse Code   | MSP over one `muse serve` host per session | [Muse Code](../public-docs/muse-code.md)                         |

## CLI compatibility warnings

Catalogs can include optional `cliUpdate` information in provider snapshots without changing
the provider's ready status. Claude derives this from the same manifest requirements used to
filter models, using the version of the resolved executable in that environment. Connected
account wrappers preserve the warning. A successful refresh replaces it, so upgrading clears
the warning without reconnecting the account or restarting the daemon.

Vorteo shows these warnings in provider settings, profile choices and the model browser.
The optional snapshot field also survives compact encoding; older clients ignore it and older
daemons can omit it. This check describes known model compatibility, not whether every installed
CLI matches its vendor's latest release. An unreadable version does not establish that a CLI is
outdated. Providers with replacement model catalogs retain their existing discovery behavior.

## Provider-native session options

The provider owns validation and application of the opaque record in
`AgentSessionConfig.providerOptions`. The registry supplies the effective options
at session startup. See [provider configuration](custom-providers.md#provider-options)
for defaults and merge rules, and the [SDK guide](../public-docs/sdk/provider-options.md)
for native keys and examples.

Exact MCP preapproval is a separate daemon-owned contract. A new provider must fail
closed for Hub unattended execution until it can approve one exact injected MCP
server and tool identity without approving native tools.

## Native goals

Keep scheduling, completion, budgets, and durable goal storage in the provider. Vorteo projects
native state and forwards controls; it must not run a second continuation loop. Goal updates can
arrive outside a foreground turn, including after a turn was canceled. Route them as agent state,
not transcript events tied to that turn.

Native goal operations currently require Codex with goals enabled. Pause prevents automatic
continuation and preserves accounting; it does not interrupt the current turn. Attachments use
the ordinary prompt path while the goal is paused, followed by a native read before activation.
Do not reactivate a goal that completed or changed while its context was being delivered.

Persist accepted user goal submissions with the agent record. Native goal events do not identify
the submitter, and a paused goal may have no native user turn. Merge submissions into history by
message identity so restart preserves the goal marker without inventing user messages for tools.

## Core adapter patterns

### ACP (Agent Client Protocol) -- recommended

Extend `ACPAgentClient` from `packages/server/src/server/agent/providers/acp-agent.ts`. The base class handles process spawning, stdio transport, session lifecycle, streaming, permissions, and model discovery. You provide configuration (command, modes, capabilities) and optionally override `isAvailable()` for auth checks.

The only built-in ACP provider today is `copilot` (`copilot-acp-agent.ts`). `GenericACPAgentClient` (`generic-acp-agent.ts`) is also ACP-based but is used for user-defined custom providers configured via `extends: "acp"` overrides — see [docs/custom-providers.md](custom-providers.md).

Copilot custom agents are exposed through ACP session config, not the slash-command list. When custom agents are available, Copilot returns a select config option with `id: "agent"` and `category: "_agent"`; Vorteo maps that to the `agent` provider feature. Copilot uses the agent display name as the option value, and the blank value means the default Copilot agent.

ACP permission options are rendered as ordered actions and Vorteo returns the selected option's exact `optionId`. Agents can therefore encode a single-choice question as multiple options of the same allow kind. Auto-accept does not resolve those chooser requests; they always wait for the user.

ACP shims can own model discovery through `catalogModelResolver`; the shared client owns the probe
process and refresh deadline. Keep vendor RPCs in the shim. Cursor uses
`cursor/list_available_models` because switching models during discovery writes its saved CLI
preferences and selection history. Cursor versions without that extension must be updated. Kimi
still probes model selections in its own shim. The initial session supplies modes and the current
model; it does not override the model list returned by a resolver.

### Direct

Implement the `AgentClient` and `AgentSession` interfaces from `agent-sdk-types.ts` yourself. This gives full control but requires you to handle process management, streaming, permissions, and session persistence from scratch.

Core direct providers: `claude` (in `providers/claude/agent.ts`), `codex` (`codex-app-server-agent.ts`), `opencode` (`opencode/runtime-client.ts`), `pi` (`providers/pi/agent.ts`), and `omp` (`providers/omp/agent.ts`). The dev-only `mock` provider (`mock-load-test-agent.ts`) is also direct.

Claude first-party model metadata lives in `packages/server/src/server/agent/providers/claude/model-manifest.ts`. When adding or updating a Claude model, update that manifest only; the model picker thinking options and Claude-specific feature gates are derived from the manifest. Do not add model-specific Claude capability lists in feature code.

Vorteo tools are not implemented as MCP tools internally. They live in a shared tool catalog under `packages/server/src/server/agent/tools/`; MCP is only the fallback adapter. The daemon resolves `agents.providers.<provider>.paseoTools` by the exact provider ID. The catalog policy belongs to the caller: it filters the tools exposed to the current agent. When that agent calls `create_agent`, the child receives the policy for the child provider ID; the caller's policy is not inherited.

A provider that can register runtime tools directly should set `supportsNativePaseoTools: true` and consume the already-filtered `launchContext.paseoTools` in `createSession`/`resumeSession`. When native tools are present, `AgentManager` strips the internal Vorteo MCP server from the provider launch config so the provider does not receive the same tools twice. Providers that only know MCP should keep `supportsMcpServers: true` and let the daemon inject `/mcp/agents`; the MCP server builds the same policy-filtered catalog for that caller. Filtering is enforced at catalog registration in both paths. Browser tools remain subject to the daemon browser-tools setting and browser-host availability.

Pi is a process-backed provider. Vorteo requires the user to have the `pi` binary installed and talks to it through `pi --mode rpc`; the server package does not embed Pi's SDK/runtime packages.

Pi extension adapters live under `packages/server/src/server/agent/providers/pi/extensions/<extension>/`. Each adapter turns Pi RPC facts into Vorteo tool, timeline, subagent, or question mappings through the [extension contract](../packages/server/src/server/agent/providers/pi/extensions/contract.ts). To add one, create its directory, add one entry to `extensions/registry.ts`, and test it with fixtures captured from the real extension in Pi that record package, version, source commit, Pi version, and capture date. `agent.ts`, `history-mapper.ts`, and `tool-call-mapper.ts` never name an extension.

Vorteo's per-agent and daemon-wide system prompts are appended by its generated Pi integration extension. Vorteo deliberately does not pass `--append-system-prompt`, because that flag replaces Pi's automatic `APPEND_SYSTEM.md` discovery instead of composing with it.

Pi model records expose input capabilities through `model.input`. Only send raw RPC `images` when the current model explicitly includes `"image"` in that list. Text-only Pi/OMP models reject image content and persist the rejected image in JSONL history, so image prompts for those models must be materialized to a local file and passed as a text path hint instead.

Probe Pi MCP support with Pi RPC `get_commands` for the agent cwd. Pi 0.99 and later ship MCP as a built-in extension, which registers an extension command named `mcp` with `sourceInfo.path` `builtin:mcp`. Register injected servers through `pi.registerMcpServer` in Vorteo's generated extension; the built-in extension rejects SSE servers and names with characters other than letters, digits, `_`, and `-`, and a server of the same name in Pi's `mcp.json` takes precedence.

The open-source `pi-mcp-adapter` extension replaces the built-in one and registers its own `mcp` command (often with `sourceInfo.source` containing `pi-mcp-adapter`). When it is loaded, write a per-agent MCP config and pass it with `--mcp-config` instead of modifying user or project MCP files. Because that flag replaces the Pi global config layer, preserve the existing `<Pi agent dir>/mcp.json` in the generated file before overlaying injected servers. For local HTTP servers such as Vorteo's own `/mcp/agents` endpoint, explicitly disable adapter OAuth (`auth: false`, `oauth: false`) in the generated config.

Pi control-plane RPCs wait 60 seconds by default. Override `params.rpcTimeoutMs` when extension or MCP startup on a slow host needs more time. Timeout errors name the pending RPC phase and report both elapsed time and the configured deadline. This setting does not govern long-running Pi compaction or Pi extension UI results. See [OMP profiles and Pi-compatible forks](custom-providers.md#omp-profiles-and-pi-compatible-forks) for OMP startup and RPC deadlines.

Pi import discovery reads Pi's persisted JSONL session files because Pi RPC does not expose a recent-session listing command. Resume and full history hydration still go through `pi --mode rpc` using the session file as `nativeHandle`.

OMP is a first-class built-in provider, disabled by default. Its launch contract, typed runtime, agent/session behavior, history, permissions, imports, and test fake live under `providers/omp/`; only the provider-neutral JSONL child-process transport is shared with Pi. It launches `omp --mode rpc-ui`, uses OMP's `get_available_commands` RPC for slash-command discovery, bridges OMP `rpc-ui` approval dialogs into Vorteo permissions, and imports terminal-started sessions from `~/.omp/agent/sessions` when enabled.

OMP supports native Vorteo host tools. The adapter registers the full caller-scoped Vorteo tool catalog directly with OMP, matching providers such as Claude that expose the full catalog through MCP. Serialize every OMP host definition with `loadMode: "essential"` so `create_agent`, `send_agent_prompt`, `wait_for_agent`, and related tools remain direct calls; omitting the field makes OMP mount non-built-in names under `xd://` instead. OMP's provider-managed task subagents are surfaced as Vorteo subagents through `child_session` imports; the parent keeps the subagents track while the child runtime stays owned by OMP. Custom OMP profiles should extend `omp`; other Pi-compatible forks can still extend `pi`, override `command`, and set `params.sessionDir` to their JSONL session directory.

Pi RPC extension UI dialog requests (`select`, `input`, `editor`, `confirm`) are bridged into Vorteo question permissions and answered with `extension_ui_response`. Pi extensions such as `ask_user` may chain dialogs: for example, a `select` can be followed by an optional-comment `input`. When an `ask_user` tool call declares `allowComment: true`, Vorteo presents the selection and optional comment as one question permission, answers Pi's initial `select` immediately, then auto-answers the follow-up optional `input` with the comment the user already supplied (or an empty string). Preserve placeholders and optional/skip semantics for standalone optional inputs so the app can still distinguish "skip this optional input" from "cancel the whole dialog." Fire-and-forget extension UI requests such as notifications are intentionally ignored by the provider adapter unless Vorteo grows first-class UI for them.

OpenCode adapters target v1.14.46 and v2.0.10. V2 rejects binaries older than the tested 2.0.10 SDK at runtime selection. Runtime selection uses the configured command and environment. A recognized version is cached until provider configuration reload; a failed, timed-out, or unrecognized probe retains the v1 path and retries detection on the next operation. Load v2 code and materialize its plugin only after positive v2 selection; v1 sessions remain undecorated. Keep upstream SDK types inside the version-specific adapter. OpenCode owns storage migration; a missing native session must fail resume rather than create a replacement. V2 has no native archive/unarchive operation: archiving affects Vorteo only. V1 retains native archiving.

Use OpenCode v2 execution events to trigger turn completion, with active-state and durable-log reconciliation after admission, reconnect, and while a turn remains active. Do not use `session.wait`: a healthy turn exceeding Node's HTTP headers deadline produces a transport error while OpenCode keeps working. The live event feed has no replay, and shutdown interruption preserves the previous idle outcome, so the session snapshot alone cannot recover missed execution events. Quiet streams are healthy: v2 heartbeats are SSE comments, not application events.

V2.0.4 also removed the activation endpoint that gated a cold location, and a cold location registers its config-derived commands, skills, and providers asynchronously. Wait until `plugin.list` returns a populated inventory before reading the catalog or commands; an empty inventory means the location is still warming. Fail when the readiness deadline expires, including when an inventory request stalls.

Paseo installs its OpenCode tool bridge through `OPENCODE_CONFIG_CONTENT`. V1 accepts a plugin file; v2 silently skips configured files and requires a package directory with a server entry point. Both versions use the daemon's private loopback bridge for caller-scoped tools. Bridge context lives only in daemon memory and is removed when the Paseo session closes. The content-addressed plugin artifacts contain no session data or secrets. V2 also needs this plugin when native Paseo tools are disabled: its prompt API has no structured-output format, so the plugin supplies a schema-validated final-answer tool.

An agent with custom environment variables or user-configured MCP servers gets a dedicated OpenCode server. V2 supports session environment, but its MCP configuration remains location-scoped, so separate servers still prevent one agent from changing another agent's MCP setup. Configure custom MCP with `mcp.add`; do not follow it with `mcp.connect`, which only toggles config-backed servers.

OpenCode owns user message IDs. Do not pass Vorteo-generated IDs to OpenCode prompt APIs; let OpenCode create `msg*` IDs and record the user timeline item from the `message.updated` event.

`AgentManager` owns the one canonical timeline row for a foreground prompt carrying a Vorteo `clientMessageId`. It records that row when `startTurn` accepts, with the wire `messageId` set to the same value. Provider adapters still emit their native user-message echo with the same `clientMessageId` when available; the manager records its provider identity on the internal row without changing or redispatching the wire item. If an adapter emits the echo before `startTurn` resolves, the manager records the provider identity with the row at acceptance. Provider adapters continue to own externally initiated user rows that have no Vorteo client identity. Do not perform global transcript text dedupe.

Active-turn steering is an optional `AgentSession.steerActiveTurn` operation. The manager owns admission against its exact foreground turn, canonical user-message creation, echo reconciliation, and falls back to the normal interrupt-and-replace path only when the adapter reports `unavailable`. An adapter error leaves the steer's fate ambiguous and must surface without an interrupt or retry. Codex calls `turn/steer` with the native expected turn and Vorteo client user-message ID. Claude pushes an admitted steer into the exact active SDK query input; isolated control commands remain unavailable. OpenCode calls `session/prompt_async` with an OpenCode-generated message ID; the server queues the prompt while busy and the next LLM call in the same Vorteo turn includes it. Pi sends its native `steer` RPC, which queues the message for delivery after the in-flight assistant turn's tool calls. Slash-command inputs report `unavailable` because pi rejects extension commands on the steer path, and echo identity is correlated by message text because pi's steer RPC takes no message ID. A missing session reports `unavailable` and uses the normal interrupt fallback.

A steering adapter also owes its interrupt: stopping a turn must discard the steers the provider has not read yet, or one of them resumes the turn the user just stopped. Codex clears pending input when it aborts a turn; Claude does not, so its adapter cancels the SDK messages it queued before calling `query.interrupt()`. Pi requires `clear_queue` before `abort`; older binaries without that RPC retain their native queue behavior until the pi compatibility floor reaches 0.84.4.

`SteerActiveTurnOptions.clearPendingPermissions` makes permission release part of the provider contract. A provider that accepts such a steer queues it first, denies permissions blocking its delivery, and stops once the steer is read. Steers without the flag leave permissions open. A denied plan remains in the timeline because the pending card was the only other copy of its text.

Rewind accepts the canonical wire `messageId` and resolves it to the provider identity before calling the adapter. A submitted prompt cannot be rewound until its provider echo supplies that identity.

Submitted user-message wire items carry the same Vorteo ID in `messageId` and `clientMessageId`. Provider adapters attach `clientMessageId` only to the echo for that foreground submission; provider history and externally initiated user rows do not have a Vorteo client ID.

Provider adapters must terminalize every transient timeline row before emitting the turn's terminal event. Codex may omit the completed `contextCompaction` item when a turn ends during compaction, so its adapter closes any pending root compaction before forwarding `turn_completed`, `turn_failed`, or `turn_canceled`. A terminal turn must never leave the client showing an operation as still loading.

Draft metadata lookups should avoid creating provider sessions when the upstream provider has top-level APIs for that metadata. Prefer `AgentClient.fetchCatalog`, `listCommands`, or `listFeatures` over creating a scratch `AgentSession`; scratch sessions can show up as empty native sessions in provider import/history UIs. `fetchCatalog` is the single discovery API for models and modes — provider implementations may use one process, separate upstream calls, or static data internally, but callers outside the provider do not get separate runtime model/mode probes. Draft command listing and scratch-session feature listing require an explicit draft model. Do not resolve a default model through catalog discovery. A client-level `listFeatures` implementation may return features from an incomplete, model-less draft and owns which features are valid in that state.

Provider session import has its own contract. The picker calls `listImportableSessions` and receives rows only: provider handle, cwd, title, prompt previews, and last activity. Import calls `importSession({ providerHandleId, cwd })` for the selected row and must not call listing again. The provider returns the resumed session, storage config, persistence handle, and hydrated timeline for that one native session; `AgentManager.importProviderSession` seeds the daemon timeline and publishes the Vorteo agent only after it is ready.

## Provider Helper Processes

Provider-owned helper processes that can outlive an individual agent session must be recorded in the daemon's managed-process registry. Store provider/kind metadata, the PID, launch command/args, and process identity captured from the platform process table. Remove the record on normal exit or shutdown.

If a helper process has a readiness phase, the provider's lifecycle model must own the process immediately after `spawn`, before readiness succeeds. Startup timeout, startup exit, and daemon shutdown must all clean up through that owned generation. Do not keep a spawned helper only inside a readiness promise; that creates a live process outside the manager/reaper contract.

Daemon bootstrap reconciles that ledger in the background, without blocking startup: dead PIDs are deleted, PID identity mismatches are deleted without killing anything, only positively matched Vorteo-owned leftovers are terminated, and a record whose process cannot be inspected is left in place for the next reconcile rather than deleted. Do not add broad process-name sweepers for provider cleanup; cleanup starts from records Vorteo previously wrote.

---

## Provider Snapshot Refresh Contract

Provider snapshots are views of the catalogues needed for a target. Before looking up cached
results or discovery in flight, the manager calls optional `AgentClient.getCatalogCacheKey(options)`.
The provider owns equivalence: equal keys must mean the same availability, models and modes,
including the effective configuration and execution environment. `force` does not change identity.
Omitting the method or returning `undefined` keeps target-specific caching. Codex and Claude's
current host clients share across directories; configured provider identities remain isolated.

The key chooses storage, never execution. Availability and catalogue discovery receive the actual
`{ scope: "global", force }` or `{ scope: "workspace", cwd, force }` request, including when another
target can share its result. Runtime-aware adapters must use that target for both probing and key
resolution. An explicit home-directory workspace is distinct from a semantic global request.
Plugin callbacks follow the same contract; see [plugin providers](plugins.md#contribute-a-provider).

`ProviderSnapshotManager` owns one refresh deadline per provider. The deadline starts before the
availability check and covers that check plus the complete catalog probe. Providers that make
multiple catalog requests must not apply this deadline separately to each request. The manager
aborts the shared refresh signal at the deadline. Providers name active catalog operations and
finish subprocess, server, or session cleanup before rejecting. Timeout errors list the operations
that were still active when the deadline expired.

Catalogue results stay cached by identity until explicit refresh or a change to that provider's configuration.
Keys are resolved on each read so project configuration can select a different cached catalogue.
Selector opening may read a loading or stale query, but does not force provider probing.

Saved provider/model choices are user intent. Catalogue failure must not erase them or substitute
another model. Creation reads the caller's host and directory directly; an earlier global snapshot
must not settle a project form's initial selection.

The server's provider keys never cross the wire. Clients advertising `provider_snapshot_references`
receive directory-to-hash announcements; an unknown hash uses the existing snapshot request.
The manager detaches each fresh result once and publishes its content identity with the entry;
readers share these values read-only. Each target keeps its published snapshot until membership,
content or discovery freshness changes. All affected targets commit before subscribers run;
subscriber failures are logged without changing discovery or configuration outcomes.
The session compares both sides of a committed transition under the client's current visibility
policy and sends only visible changes. It combines result identities with the client's encoding
and icon policy, without traversing models. Reference hashes exclude freshness;
legacy embedded hashes include it. Only responses that send a body compact the catalogue.
Per-provider `fetchedAt` travels separately for reference clients and still means when discovery succeeded. `generatedAt`
remains the time the response or announcement was generated. Refresh keeps settled entries visible
until the next result, so unchanged discovery sends freshness without another model body.

The app's snapshot cache owns compact expansion and stores one body per server/hash, with separate
directory/hash/freshness records under the same byte budget. Missing bodies share a React Query
request; directory queries cancel superseded pulls before accepting pushes. Default SDK clients
keep expanded entries and full updates. Only callers that own materialization opt into wire snapshots.
Keep the full encoding for older clients; compact-snapshot support alone does not imply reference support.

Settings refresh invalidates requested providers across known targets and refreshes them in their
actual execution context, so every connected client receives the refreshed view. Discovery shares
work by provider key and admits at most four concurrent catalogue probes per configured provider, so a stalled provider does not block discovery for others. Configuration replacement invalidates
only changed providers; unchanged entries, clients, and discovery in flight survive. Preparation
leaves installed reads untouched until commit. Plugin replacement uses registration runtime
identity, so unchanged registrations and builtins keep their results. Await the refresh or warmup
promise for completion: equal results, including equal discovery timestamps, emit no transition.

---

## Usage sources

See the [public usage source reference](../public-docs/plugins/reference.md#usage-sources) for the
contract, account and window identity, provider-derived period names, login fallback, and
read-only credential rules. Usage adapters own the interpretation of provider fields; the app
renders their names and resolves pins without provider-specific duration guesses.

Account sign-in uses a dedicated Codex app-server process with the configured provider environment. Never reuse an active agent transport: closing a sign-in panel must not stop an agent. The daemon owns pending device-code attempts so a browser disconnect or panel close does not abandon sign-in; explicit cancellation and expiry dispose only that dedicated process.

### Account evidence for schedules

Use `paseo schedule quota --provider <configured-account>` to inspect authenticated quota evidence. Add `--json` for the account identity, observation timestamp, reported windows and consumption meters. This command reads metadata and does not launch an agent or change schedule policy.

Clients use `provider.quota.get_observation.request` after checking `server_info.features.providerQuotaObservation`. Both request and response require `daemon.read`. A configured provider name alone is not authenticated account identity. Bind schedule policy to the returned account, and revalidate that binding at execution admission.

Window occupancy and token activity do not establish gross daily consumption in quota percentage points. Missing consumption meters remain unavailable. Inspection is evidence for configuration; a launch still requires fresh quota checks, execution authority and a governed dispatch permit.

### Governed native process custody

Governed session construction accepts a trusted process-custody binding. The
launcher supplies the complete process environment; provider and task environment
overlays do not enter that launch. Transport shutdown delegates to the captured
custody binding instead of killing its supervisor. A failed startup cannot clear
the account fence until retained cleanup succeeds.

The Linux implementation requires a trusted Python executable with subreaper,
pidfd signaling and wait support. Its packaged helper must remain outside worker
writes. Store its journal in an owner-only physical directory outside worker
access, on a filesystem that supports file and directory synchronization. A
filesystem that presents different ownership to the coordinator and its clean
child environment fails this requirement. Do not relax ownership checks to make
such a mount work.

Persist the launch directory and full execution/attempt identity before starting
work. Missing, invalid or mismatched settlement receipts require recovery and
must not release execution capacity. Supervisor death can leave descendants;
absence of a live supervisor is not settlement. Automatic takeover remains
unsupported without additional custody evidence.

Captured native worker launches require a named permission profile and disable
apps, plugins, browser/computer control, hooks and shell snapshots. Before thread
creation, effective configuration must show no MCP servers, shell environment
assignments, login/profile sourcing, live web search or notification commands.
Per-thread configuration cannot restore these tools or weaken launch controls.
The same checks run at each inference admission, including cached threads.

The accepted filesystem profile has no parent, one explicit workspace root equal
to the session cwd, root and temporary-directory denial, minimal system reads,
workspace writes, denied `.codex` access and read-only `.git` access. Workers
either disable networking or use the native managed proxy with an empty
destination allowlist, no socket grants and no upstream proxy or credential
broker. The latter preserves Node subprocess IPC within the native tool network
namespace. Additional grants are rejected. Native thread start and
resume must report that same single runtime workspace root.
The workspace and its precreated `.codex` directory must resolve to their exact
physical paths. Missing targets, files and symlinked paths fail before thread
creation; the provider does not repair them.

These checks do not establish the complete worker boundary. The trusted
coordinator must still materialize the protected `.codex` directory before
launch and keep native configuration and its parents outside
worker writes. A linked worktree's external Git metadata is not granted by this
profile; Git inspection and publication need a verified preparation layout and
trusted custody. Bind authentication and project configuration for the attempt,
then attach quota supervision before inference. The production schedule backend
is not connected by this component alone.

### Trusted governed schedule runtime

The supervised daemon worker can load one installed `.mjs` module from
`PASEO_GOVERNED_RUNTIME_MODULE` at startup. The module exports
`createGovernedScheduleRuntime`. This is trusted daemon code with daemon
authority, not a sandboxed plugin. Keep the complete installation, dependencies,
configuration and parent directories outside worker writes. The loader checks
the entry file's physical path, ownership and write permissions; it does not
authenticate a package or its imports. An invalid configured module fails startup.
There is no hot reload or schedule/RPC field for selecting the module.

The factory receives the durable quota store, raw metadata reader and a narrow
governed-client capture operation. It supplies preflight observations with the
captured authentication binding and persisted hourly estimate, plus the existing
schedule preparation/reconciliation/execution contract. Initialize without
starting workers. Constructor failure must retain or settle anything it acquired.
Provider replacement, disable/re-enable and daemon shutdown invalidate captured
clients. Registry generation is not an authentication generation; the runtime
must bind and verify account credentials separately.

Runtime `stop()` must revoke authority synchronously before awaiting settlement.
Rejection preserves the recovery condition while independent daemon cleanup
continues. The daemon worker's forced-exit deadline is not settlement evidence.
Without a configured runtime, protected schedules continue to hold without
falling back to ordinary agent execution. Loading a runtime does not establish
claim authority, worker isolation, review or publication acceptance.

---

## ACP Provider Checklist

### 1. Create the provider class

Create `packages/server/src/server/agent/providers/{name}-agent.ts`.

Define capabilities, modes, and a thin subclass of `ACPAgentClient`:

```ts
import type { Logger } from "pino";
import type { AgentCapabilityFlags, AgentMode } from "../agent-sdk-types.js";
import type { ProviderRuntimeSettings } from "../provider-launch-config.js";
import { ACPAgentClient } from "./acp-agent.js";

const MY_PROVIDER_CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsDynamicModes: true,
  supportsMcpServers: true,
  supportsReasoningStream: true,
  supportsToolInvocations: true,
};

const MY_PROVIDER_MODES: AgentMode[] = [
  {
    id: "default",
    label: "Default",
    description: "Standard agent mode",
  },
  // Add more modes as needed
];

type MyProviderClientOptions = {
  logger: Logger;
  runtimeSettings?: ProviderRuntimeSettings;
};

export class MyProviderACPAgentClient extends ACPAgentClient {
  constructor(options: MyProviderClientOptions) {
    super({
      provider: "my-provider", // Must match the ID used everywhere else
      logger: options.logger,
      runtimeSettings: options.runtimeSettings,
      defaultCommand: ["my-agent-binary", "--acp"], // CLI command to spawn
      defaultModes: MY_PROVIDER_MODES,
      capabilities: MY_PROVIDER_CAPABILITIES,
    });
  }

  // Override isAvailable() if the provider needs specific auth/env vars
  override async isAvailable(): Promise<boolean> {
    if (!(await super.isAvailable())) {
      return false; // Binary not found
    }
    return Boolean(process.env["MY_PROVIDER_API_KEY"]);
  }
}
```

The `super.isAvailable()` call checks that the binary from `defaultCommand` is on `$PATH`. Override only to add credential checks on top.

For reference, here is how Copilot does it -- no auth override needed because the CLI handles auth itself:

```ts
export class CopilotACPAgentClient extends ACPAgentClient {
  constructor(options: CopilotACPAgentClientOptions) {
    super({
      provider: "copilot",
      logger: options.logger,
      runtimeSettings: options.runtimeSettings,
      defaultCommand: ["copilot", "--acp"],
      defaultModes: COPILOT_MODES,
      capabilities: COPILOT_CAPABILITIES,
    });
  }

  override async isAvailable(): Promise<boolean> {
    return super.isAvailable();
  }
}
```

### 2. Add to the provider manifest

In `packages/protocol/src/provider-manifest.ts`, add mode definitions with UI metadata (icons, color tiers) and a provider definition entry.

First, define the modes with visual metadata:

```ts
const MY_PROVIDER_MODES: AgentProviderModeDefinition[] = [
  {
    id: "default",
    label: "Default",
    description: "Standard agent mode",
    icon: "ShieldCheck",
    colorTier: "safe",
  },
  {
    id: "autonomous",
    label: "Autonomous",
    description: "Runs without prompting",
    icon: "ShieldOff",
    colorTier: "dangerous",
  },
];
```

Available `colorTier` values: `"safe"`, `"moderate"`, `"dangerous"`, `"planning"`.
Available `icon` values: `"ShieldCheck"`, `"ShieldAlert"`, `"ShieldOff"`.

Then add to the `AGENT_PROVIDER_DEFINITIONS` array:

```ts
export const AGENT_PROVIDER_DEFINITIONS: AgentProviderDefinition[] = [
  // ... existing providers ...
  {
    id: "my-provider",
    label: "My Provider",
    description: "Short description of the provider",
    defaultModeId: "default",
    modes: MY_PROVIDER_MODES,
    // Optional: enable voice
    voice: {
      enabled: true,
      defaultModeId: "default",
      defaultModel: "some-model",
    },
  },
];
```

### 3. Add the factory to the provider registry

In `packages/server/src/server/agent/provider-registry.ts`, import your class and add a factory entry to `PROVIDER_CLIENT_FACTORIES`:

```ts
import { MyProviderACPAgentClient } from "./providers/my-provider-agent.js";

const PROVIDER_CLIENT_FACTORIES: Record<string, ProviderClientFactory> = {
  // ... existing factories ...
  "my-provider": (logger, runtimeSettings) =>
    new MyProviderACPAgentClient({
      logger,
      runtimeSettings,
    }),
};
```

The factory is invoked with `(logger, runtimeSettings, options)`; `options.workspaceGitService` is also available if you need it (see the `codex` factory for an example). The registry already passes the per-provider runtime settings slice through, so you don't index into the map yourself.

### 4. Add a provider icon (app)

Create `packages/app/src/components/icons/my-provider-icon.tsx` following the pattern from existing icons (e.g., `claude-icon.tsx`):

```tsx
import Svg, { Path } from "react-native-svg";

interface MyProviderIconProps {
  size?: number;
  color?: string;
}

export function MyProviderIcon({ size = 16, color = "currentColor" }: MyProviderIconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill={color}>
      <Path d="..." />
    </Svg>
  );
}
```

Then register it in `packages/app/src/components/provider-icons.ts` by adding an entry to the existing `PROVIDER_ICONS` map (which already covers the built-in providers):

```ts
import { MyProviderIcon } from "@/components/icons/my-provider-icon";

const PROVIDER_ICONS: Record<string, typeof Bot> = {
  // ... existing entries ...
  "my-provider": MyProviderIcon as unknown as typeof Bot,
};
```

If no icon is registered, `getProviderIcon()` falls back to a generic `Bot` icon from lucide.

### 5. Add E2E test config

In `packages/server/src/server/daemon-e2e/agent-configs.ts`, add your provider:

```ts
export const agentConfigs = {
  // ... existing configs ...
  "my-provider": {
    provider: "my-provider",
    model: "default-model-id",
    modes: {
      full: "autonomous", // Mode with no permission prompts
      ask: "default", // Mode that requires permission approval
    },
  },
} as const satisfies Record<string, AgentTestConfig>;
```

Add an availability check in `isProviderAvailable()`. Note `isCommandAvailable` is async, so all branches `await` it:

```ts
case "my-provider":
  return (
    (await isCommandAvailable("my-agent-binary")) &&
    Boolean(process.env.MY_PROVIDER_API_KEY)
  );
```

Add to the `allProviders` array (current built-ins are `claude`, `codex`, `copilot`, `opencode`, `pi`, `omp`):

```ts
export const allProviders: AgentProvider[] = [
  "claude",
  "codex",
  "copilot",
  "opencode",
  "pi",
  "my-provider",
];
```

### 6. Run typecheck

```bash
npm run typecheck
```

This is required after every change per project rules.

---

## Direct Provider Checklist

If your agent does not speak ACP, implement the interfaces from `agent-sdk-types.ts` directly.

### Interfaces to implement

The interfaces below are abridged signatures — read `agent-sdk-types.ts` for the full source of truth (option bag types, generics, etc.).

**`AgentClient`** -- factory for sessions and model/mode listing:

```ts
interface AgentClient {
  readonly provider: AgentProvider;
  readonly capabilities: AgentCapabilityFlags;
  createSession(
    config: AgentSessionConfig,
    launchContext?: AgentLaunchContext,
    options?: AgentCreateSessionOptions,
  ): Promise<AgentSession>;
  resumeSession(
    handle: AgentPersistenceHandle,
    overrides?: Partial<AgentSessionConfig>,
    launchContext?: AgentLaunchContext,
  ): Promise<AgentSession>;
  fetchCatalog(options: FetchCatalogOptions): Promise<ProviderCatalog>;
  isAvailable(): Promise<boolean>;
  // Optional:
  listImportableSessions(
    options?: ListImportableSessionsOptions,
  ): Promise<ImportableProviderSession[]>;
  importSession(
    input: ImportProviderSessionInput,
    context: ImportProviderSessionContext,
  ): Promise<ImportedProviderSession>;
  getDiagnostic?(): Promise<{ diagnostic: string }>;
}
```

**`AgentSession`** -- a running agent conversation:

```ts
interface AgentSession {
  readonly provider: AgentProvider;
  readonly id: string | null;
  readonly capabilities: AgentCapabilityFlags;
  readonly features?: AgentFeature[];
  run(prompt: AgentPromptInput, options?: AgentRunOptions): Promise<AgentRunResult>;
  startTurn(prompt: AgentPromptInput, options?: AgentRunOptions): Promise<{ turnId: string }>;
  steerActiveTurn?(prompt: AgentPromptInput, options: SteerActiveTurnOptions): Promise<SteerResult>;
  subscribe(callback: (event: AgentStreamEvent) => void): () => void;
  streamHistory(): AsyncGenerator<AgentStreamEvent>;
  getRuntimeInfo(): Promise<AgentRuntimeInfo>;
  getAvailableModes(): Promise<AgentMode[]>;
  getCurrentMode(): Promise<string | null>;
  setMode(modeId: string): Promise<void | AgentProviderNotice>;
  getPendingPermissions(): AgentPermissionRequest[];
  respondToPermission(
    requestId: string,
    response: AgentPermissionResponse,
  ): Promise<AgentPermissionResult | void>;
  describePersistence(): AgentPersistenceHandle | null;
  interrupt(): Promise<void>;
  close(): Promise<void>;
  // Optional:
  listCommands?(): Promise<AgentSlashCommand[]>;
  setModel?(modelId: string | null): Promise<void>;
  setThinkingOption?(thinkingOptionId: string | null): Promise<void | AgentProviderNotice>;
  setFeature?(featureId: string, value: unknown): Promise<void>;
  tryHandleOutOfBand?(prompt: AgentPromptInput): {
    run(ctx: { emit: (event: AgentStreamEvent) => void }): Promise<void>;
  } | null;
}
```

`setMode` and `setThinkingOption` may return an `AgentProviderNotice` when the provider knows the change needs user-facing context. For example, providers that stage changes until the next turn should return an `info` notice while a turn is already running. The app renders the notice generically as a toast; provider-specific lifecycle behavior stays in the provider implementation.

### Steps

1. Create `packages/server/src/server/agent/providers/{name}-agent.ts` implementing both interfaces
2. Add to the provider manifest (same as ACP step 2 above)
3. Add factory to the registry (same as ACP step 3 above)
4. Add icon (same as ACP step 4 above)
5. Add E2E config (same as ACP step 5 above)
6. Run typecheck

---

## Testing

### Manual testing with the CLI

Start the daemon if not already running, then:

```bash
# Launch an agent with your provider
paseo run --provider my-provider

# Launch with a specific model and mode
paseo run --provider my-provider --model some-model --mode default

# List running agents
paseo ls -a -g

# Check if the provider reports models
paseo models --provider my-provider
```

### E2E test patterns

The E2E configs in `agent-configs.ts` expose two helpers:

- `getFullAccessConfig(provider)` -- returns config for a session with no permission prompts
- `getAskModeConfig(provider)` -- returns config for a session that triggers permission requests

Tests use `isProviderAvailable(provider)` to skip when the binary or credentials are missing, so CI will not fail for providers that are not installed.

---

## Gotchas

**Mode IDs can be URIs.** ACP providers like Copilot use full URIs as mode IDs (e.g., `"https://agentclientprotocol.com/protocol/session-modes#agent"`). Never assume mode IDs are simple strings. The manifest `defaultModeId` must match exactly.

**Models and modes are discovered dynamically.** ACP providers report available models and modes at runtime via the protocol. The static definitions in `provider-manifest.ts` are used for UI scaffolding (icons, color tiers) but the runtime values from the agent process are the source of truth.

**`AgentProvider` is always `string`.** The type alias is `type AgentProvider = string`. Provider IDs are validated against the manifest at runtime, not at the type level.

**Auth patterns vary.** Some providers need API keys in env vars (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`), some use OAuth tokens (`CLAUDE_CODE_OAUTH_TOKEN`), some use auth files (`~/.codex/auth.json`), and some handle auth entirely in their CLI binary (Copilot). Your `isAvailable()` method should check whatever is needed.

**The manifest mode list and the agent class mode list are separate.** The manifest in `provider-manifest.ts` includes UI metadata (`icon`, `colorTier`). The agent class defines modes without UI metadata (just `id`, `label`, `description`). Keep them in sync.

**`defaultCommand` is a tuple.** The first element is the binary name, the rest are default arguments. The base class uses this to find the executable and spawn the process.

**Runtime settings can override the command.** Users can configure custom binary paths or environment variables per provider via `ProviderRuntimeSettings`. Your factory in the registry should pass `runtimeSettings?.["your-provider"]` through to the constructor.

**Session-scoped cancellation needs a stop boundary inside the provider.** Some agents cancel the whole session rather than one turn — OpenCode's `session.abort` is the example. A cancel that is still in flight when the next run starts will kill that replacement run, which is what makes "stop, then immediately prompt again" (`replaceRunning`, `notifyOnFinish` wakes, schedules) flaky. Own this in the provider session, not in `AgentManager`:

- Model the stop as an explicit `stopping` turn-state variant carrying the canceled run's terminal and the cancellation the caller is still owed. Pressing Stop again retries the stop already in progress rather than opening a second one; never fire a detached retry, it will outlive its boundary.
- **Scope the cancel settlement the way the provider scopes the cancel.** If cancellation is session-scoped, so is its settlement: track it on the session, accumulating every request issued, and let it outlive the stop that issued it. A request still in flight lands on the runner whenever the server gets to it — however many stops have come and gone since. Scoping it to the current stop looks right and quietly drops older requests from the gate. Only the newest may hold the gate closed, since recovering from a failed cancel is what pressing Stop again is for.
- Gate the operations **the daemon issues** (prompt, slash command, summarize) on both the terminal and cancel settlement. Permission and question responses are not runner operations and must stay outside the gate, or an auto-approve deadlocks the stop. Runs the _provider_ starts on its own — plugin or autonomous wakes — are observed, not gated: the daemon does not choose when they begin, and holding their events back does not protect them from a cancel already in flight, it only hides a run that may already be dead.
- Fail closed: if the cancel never succeeded you never proved the run stopped, so refuse new runs until the next Stop issues a fresh cancel. `AgentManager` already turns a rejected `interrupt()` into a refused cancel.
- Suppress the canceled run's residue only until its authoritative terminal. Anything the provider publishes after that terminal is a new run by construction and must take the normal live path — buffering it and replaying it later is how autonomous/plugin wakes get lost.
