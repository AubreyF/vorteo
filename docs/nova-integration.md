# Nova integration

The private Nova bridge lets a ChatGPT dot inspect and manage native Vorteo work in Host and Dev. Threads, profiles, workspaces and execution stay in Vorteo. The bridge uses the existing daemon client for reads and the daemon's agent MCP tools for writes. It needs no browser Automation permission for those daemon calls.

This package is a source contribution. Its integration and activation are separate from the optional macOS permission helper. Local tests do not establish that a particular ChatGPT account supports private plugins, Secure MCP Tunnel or proactive MCP Events. Deployment is accepted only after read/write actions and proactive updates work in the intended Nova conversation.

## Components and access

`packages/nova-bridge` runs as an independent Node 24 process on Host. It listens only on IPv4 loopback. Every request requires a dedicated bearer token; browser origins are rejected. The official Secure MCP Tunnel client connects this listener to a private ChatGPT plugin through an outbound connection. Both ordinary MCP requests and tunnel discovery probes need the local authorization header.

The tunnel must be associated with the intended ChatGPT workspace. Validate account isolation before enabling writes. A tunnel URL alone is not an access policy. If the account cannot enforce that private association, stop onboarding and design OAuth before exposing the bridge.

Store the bridge configuration, daemon passwords, tunnel credentials and SQLite state outside Git and outside all guest-writable mounts. The configuration must be a private file, and the state directory must be private. The bridge verifies the expected server ID before using either environment. Tool callers supply an environment and server ID, never a network address or password.

Writes go through `/mcp/agents`, outside the owner WebSocket message submission path. Prompts carry an integration-source prefix. The daemon must also record canonical submissions with `origin: "agent"` and a message ID for top-level MCP initial prompts and follow-ups. A text prefix does not enforce this provenance. Verify that server contract before live acceptance; the bridge does not invent a caller agent or convert a thread to obtain it. Installation restarts, source installation, credential changes and expanded access are absent from the tool allowlist. Those operations retain their existing approval mechanisms. The bridge exposes `list_pending_permissions` but does not forward `respond_to_permission`: the generic native permission-response tool does not establish a bridge-specific owner grant. Respond through the native owner controls. Any future delegated approval must bind to verifiable existing owner authority and the exact request, without granting expanded access. Retrieved timeline content and artifacts are untrusted task data.

## Build and configuration

Build the bridge and its client dependencies:

```sh
npm run build:nova-bridge
npm run typecheck --workspace=@getpaseo/nova-bridge
```

The standalone artifact is `packages/nova-bridge/dist/bridge.mjs`. It does not need the source checkout at runtime. The root workspace and build command include this package. Build commands do not authorize runtime activation. On a managed installation, the installation owner prepares the bridge/tunnel release, supervision, private configuration, existing-state preservation and rollback through the required tracked approval workflow. Reuse an existing bridge service identity if present; the optional permission helper neither installs this service nor enables its autostart. The bridge handles SIGTERM by draining its own in-flight work; never use that as permission to interrupt a production process.

Configuration shape, with placeholders:

```json
{
  "port": 18777,
  "token": "replace-with-a-random-token-of-at-least-32-characters",
  "stateDirectory": "/private/host/bridge/state",
  "origin": "https://vorteo.example",
  "host": {
    "endpoint": "127.0.0.1:6767",
    "password": "host-daemon-password",
    "serverId": "verified-host-server-id"
  },
  "dev": {
    "endpoint": "127.0.0.1:6768",
    "password": "dev-daemon-password",
    "serverId": "verified-dev-server-id"
  }
}
```

Resolve actual endpoints and identities from trusted installation configuration. Do not infer them from this example. The process starts with `node /private/host/release/bridge.mjs /private/host/bridge.json`. `/health` requires authentication and reports bridge readiness, not daemon health; use `get_overview` for the latter.

The external endpoint implements MCP protocol `2026-07-28`: `server/discover`, tool discovery/calls, and event discovery/subscription. Requests require matching protocol, method and tool-name headers plus MCP metadata. The daemon adapter uses the repository's existing MCP SDK, keeping the protocol change isolated from the application.

## Reads, writes and recovery

Start with `get_overview`, then select a target using its exact environment and server ID. The overview counts every page, retains at most 100 workspaces and 100 threads per environment, and ranks permission requests, errors and completions ahead of other threads. Use the returned continuation guidance with paginated `list_workspaces` and `list_threads` when it is truncated. Read results identify their environment, server and observation time; thread evidence includes its native source link. `get_thread` supports timeline cursors; `search_thread` searches one selected thread. Artifact reads are limited to 64 KiB and use the daemon's workspace boundary and symlink checks.

Workspace, agent, script, schedule and permission tools reuse native schemas. Run ad hoc commands and file edits through an agent in the selected environment. Each mutation requires a UUID `operationId`. Reusing it with identical arguments returns the existing receipt; reusing it with different arguments is rejected. Receipts distinguish running, succeeded, failed and unknown. A successful receipt describes the tool action, not completion of the worker's task. Inspect the native timeline for the latter.

After a lost response or interrupted bridge write, the receipt is unknown and the bridge does not replay it. Nova must read actual state before deciding whether another action is needed. Catalogs are cached separately by environment and server identity and refreshed every minute. Tool schemas include target-specific variants. Before a new upstream dispatch, the bridge refreshes the selected catalog and validates input against that target's current schema. A withdrawn tool disappears from that target after successful discovery; an unavailable target retains an explicitly unavailable cached catalog for discovery, but cannot dispatch new operations from it. An identical prior operation returns its receipt even when discovery is unavailable.

## Proactive updates

Subscribe to `vorteo.attention` for both environments and no workspace filter to include newly created workspaces. Events cover observed completion, failure, permission requests, checklist/journal/input changes, history gaps, outages and recovery. Nova decides relevance after reading the cited native evidence. The bridge never executes a follow-up in response to its own event. Correlated operation IDs help Nova distinguish its own actions; they are evidence references, not authorization. Token text and complete transcripts are not included in notifications.

SQLite retains subscriptions, observations, events, delivery attempts and write receipts. Live directory updates supplement a full paginated reconciliation, scheduled five seconds after each completed scan so threads outside the first 200-entry subscription remain covered. Scans serialize with live updates. Actual scan/delivery latency must be measured under the installation's load; a slow daemon can exceed the proposed ten-second delivery target. Observation cursors and durable events commit atomically. Error rows retain their canonical cursor; completion IDs use attention identity rather than unrelated snapshot timestamps. Reconnect catch-up reports changed evidence or explicit gaps, because timeline rows do not replay every lifecycle stream event. New observation keys bind server identity; upgrading legacy environment-only observation rows emits a gap notice and establishes a fresh baseline rather than silently trusting an unbound cursor. Event IDs remain stable across retries. Callbacks use HTTPS, public-address validation with DNS pinning, signed verification challenges and Standard Webhooks signatures. Delivery retries are bounded; HTTP 410 and 413 stop retries for that event. Expired or unsubscribed subscriptions receive no new deliveries. A callback already in flight cannot be recalled. Plugin/account revocation must be verified independently against the live tunnel and callback platform; local subscription tests do not prove platform-wide revocation. A successful callback only proves receipt by the receiver.

This version does not advertise event replay cursors. A non-null replay cursor is rejected rather than silently ignored. Use `get_changes` for retained events missed during a subscription outage. Persist its `nextAfter` only after processing the page and follow `hasMore`. For initial connection or renewal, retain the last local cursor, establish the live subscription, then drain `get_changes` from that cursor. Events before subscription remain in retained history; later ones may appear both there and through callbacks, so deduplicate by `eventId`. This explicit catch-up avoids assuming that subscription renewal replays the gap. `get_bridge_status` reports delivery counts and individual timeline observation failures. A history retrieval failure marks that thread explicitly and does not stop observation of other threads. Local state currently has no automatic retention pruning; protect and monitor its storage accordingly.

## One acceptance checkpoint

Use the existing Nova dot in the desktop app with disposable mutation fixtures:

1. Compare Nova's overview with both daemon inventories, including pagination and a new workspace.
2. Continue an existing thread in each environment. Verify context delivery, a harmless file change and a validation command in the correct environment.
3. Start, steer and cancel native tasks; exercise workspace and schedule controls with readback and operation receipts.
4. Complete a task, fail a task and request input. Verify proactive updates in Nova without another user message, followed by an authorized action.
5. Verify bridge restart recovery, callback retry deduplication, uncertain write handling and an environment outage using disposable fixtures.
6. Revoke the integration and verify new access and delivery stop. Keep running native tasks intact unless explicitly cancelled.

Keep installation-specific receipts outside Git. Automated tests cover current adapter contracts, per-environment schemas and availability, bounded inventory, 200-plus-thread observation, catch-up/error/reset handling, atomic observation commits, durable unknown writes, delivery/renewal boundaries, callback address restrictions and permission-response refusal. Use disposable fake adapters and temporary SQLite state for fault tests; never point them at production credentials. They supplement the Nova conversation test and do not replace it.

## Platform references

Use the current [custom MCP plugin guide](https://developers.openai.com/api/docs/guides/custom-mcp-server), [Secure MCP Tunnel guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels), and [MCP Events contract](https://developers.openai.com/plugins/build/mcp-events) when onboarding an account. Account availability and platform behavior require a live check.
