# Installation account connections

Status: implementation in progress. Shared account definitions already exist; authentication is still local to each environment.

The current readiness guard detects missing enabled Codex or Claude account bindings without blocking unrelated policy projection. It does not yet verify authentication, transfer credentials, or make a connection installation-wide.

## Required behavior

Connect an account once to the installation. Host and Dev use that same verified provider account by default. The connection flow has no environment choice. An explicit exclusion, configured after connection, is the only supported reason to disable that connection in an environment.

Keep the existing profile selector for environment, account and profile selection. Do not add another environment selector or silently substitute a different account.

A connection is ready only after every non-excluded environment verifies the account. An offline environment leaves synchronization pending and resumes automatically when it returns. The interface must distinguish that state from a fully connected account without requiring a second sign-in or creating a duplicate account record.

## Implementation boundaries

Reuse the canonical installation account catalog, stable account IDs and environment exclusions. Keep credential payloads separate from ordinary shared settings, browser state, logs and source control. Transfer only the selected provider account's authentication through the installation's authenticated transport; never transfer daemon, coordinator, Docker or unrelated Host credentials.

Each provider needs a verified adapter for its supported authentication store, account identity, expiry, refresh and revocation behavior. Preserve active sessions and existing account homes. Do not implement two independent refresh writers for a rotating credential or claim that copying an authentication file once provides lasting synchronization.

Coordinate reconnect, sign-out and recovery under one durable connection operation. Retrying a lost response must retain the same account identity. A stale synchronization result must not restore a signed-out credential or undo a later exclusion.

Existing unlinked accounts require identity verification before consolidation. Matching labels do not prove that accounts are the same. Preserve the original records and rollback material throughout migration.

## Acceptance

- Connect once and verify the same provider account on Host and Dev.
- Reconnect, expire and refresh authentication without a second environment login or competing refresh writers.
- Recover an offline environment and a lost response without duplicate accounts.
- Apply and remove an explicit exclusion without changing another account or resetting profiles.
- Sign out once and prevent stale reconciliation from restoring the connection.
- Preserve running sessions, unsent drafts, queued messages and account selection during migration.
- Validate credential redaction and access boundaries with isolated fixtures, then verify both installed environments. Use the tracked installation workflow for any required interruption.
