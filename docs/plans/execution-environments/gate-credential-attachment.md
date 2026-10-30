# Gate credential attachment

Status: planned fast follow after the one-command installation, October 30, 2026. Not implemented.

## Goal

Each provider connection exists exactly once per installation, on the Host. Environments use it without ever holding a copy. The [network gate](network-gate.md) attaches the credential to each request, so there is nothing to synchronize, nothing to revoke from a container, and every use is recorded.

This replaces the current copy-and-sync design, where the Host signs in, refreshes and delivers access tokens into Dev (`claudeHostRefresh`, `codexHostRefresh`).

## Design

- **One custody point.** The Host holds every provider connection: Claude and Codex subscription sign-ins and API keys. It is the only refresh writer.
- **Environments hold placeholders.** Dev's provider CLIs point at gate routes instead of provider hosts, for example `ANTHROPIC_BASE_URL=http://gate/connections/<id>/` for Claude Code and Codex's base-URL settings, with placeholder credentials.
- **The gate attaches.** For an allowed environment and connection, the gate fetches the current credential from the Host over a private channel, adds the provider's authorization header, and forwards the request over TLS to the provider. It never logs the credential.
- **Allow and deny lists.** Access is a gate rule per connection and environment: allowed environments use it, others receive a clear refusal naming the connection. Changing access changes one rule, never files in a container.
- **Audit.** Every attachment is a gate log entry with connection, environment, attributed agent when known, destination, status and timing. This answers which requests used a credential and when.
- **Host agents** use the credential directly, since the Host is the trusted environment that holds it.

## Gains

- One credential per connection, no delivery or sync status, no per-environment refresh guards.
- A compromised Dev holds nothing reusable outside the gate.
- Complete use audit for every Dev request that carries a credential.
- Removes the copy-and-sync code once every provider is attached.

## Risks to resolve first

- Each provider CLI must accept a custom endpoint for subscription sign-ins, not only for API keys. Verify Claude Code and Codex first.
- Some CLIs refuse to start without a local login file. Find the smallest harmless placeholder per provider.
- Streaming, WebSocket and long-lived requests must pass through the gate unchanged.
- Provider terms for relaying a subscription token through a local proxy owned by the same account holder.

## Plan

1. Prove Claude Code and Codex end to end through a gate route with subscription sign-ins, in the lab. Stop and report if either CLI cannot be pointed at the gate.
2. Add connection routes, Host custody fetch and attachment logging to the gate.
3. Add allow and deny rules to Accounts & profiles, replacing environment exclusion.
4. Move installations from copy-and-sync to attachment, then remove the delivery code.

Estimate: 3 to 4 days, mostly step 1.

Related: [credential broker](credential-broker.md), [provider authentication](provider-auth.md), [network gate](network-gate.md).
