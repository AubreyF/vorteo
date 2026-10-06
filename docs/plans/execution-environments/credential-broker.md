# Credential broker and first GitHub connector

Status: future project, coordinated with the credential-management planning task.

Keep credentials and protected connector workers outside untrusted environments. Start with a small reviewed set of typed GitHub operations. Decide exact operations and approval rules before implementation. Do not offer arbitrary URLs, headers, shell execution, repository hooks, or guest-defined connector code under broker authority.

Consume host-issued environment/task grants. The protected interface approves the exact request revision. Log bounded audit metadata without credential contents; implement cancellation, revocation, retry idempotency, and clear outcomes for partial external effects.

The minimum protected installation and client boundary is shared with the first release. Identity and grants belong to the environment-grant project and must be built once. A broker can first serve a fixed test environment; generalized container orchestration is not a prerequisite.

Acceptance: guest cannot read tokens or replace workers/UI; forged grants and replay fail; approval cannot be retargeted; connector failures leak no credentials; completed actions remain attributable after reconnect.

Owner-account full-access agents are not isolated from owner-accessible broker credentials. Stronger protection from those agents requires a different OS authority boundary and is outside this design.

The earlier connector-only allowance was 3 to 5 engineering days assuming protected UI and grants already existed. The broader credential review budgets 16 to 25 days for the combined foundation/runtime/connector effort. Re-estimate the chosen operation set before scheduling. HTTPS interception, browser credentials, and provider migration each have separate project plans.

## Design rationale and limits

The discussion began with [Meta's published Muse design](https://research.meta.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse): credentials outside the agent runtime, protected connector execution, and separately enforced action approval. Treat that description as architectural inspiration, not an independently verified security guarantee or a requirement to reproduce the entire system.

The first broker executes typed requests itself. Transparent token substitution for arbitrary tools belongs to [HTTPS mediation](https-mediation.md). Protecting a service token does not prevent an agent from transmitting workspace data over another available network path. General data-exfiltration prevention is outside this connector's guarantee.

Reuse protected release placement, service ownership and client admission from the host foundation after their acceptance is verified. Installation descriptors, server IDs and restart request tokens remain routing or lifecycle metadata. They confer no connector authority. Define broker approvals independently of restart approvals. Keep broker state, connector code and owner UI outside every guest-writable mount; audit daemon-supplied plugins as well as browser automation.

## First workflow and unresolved decisions

Proposed first operations are repository reads and draft pull-request creation for explicitly selected repositories. These are candidates for review, not a frozen API. Initially a draft may target an already published branch. Git fetch/push and publishing local changes require separately scoped transport work.

Evaluate a GitHub App first, including repository-limited permissions and short-lived installation tokens. Decide whether actions should use the app's identity or the owner's personal identity before choosing authentication. Verify current upstream capabilities when implementing. Keep account selection independent of the model provider selected for a task.

Settle these decisions before implementation:

- Credential enrollment through the protected client, storage backend, encryption and wrapping-key custody, unattended startup, rotation, expiry and refresh.
- Backup, restore, key loss and connection removal. An encrypted vault whose decryption authority is available to the guest does not meet the boundary.
- Allowed repositories and operations, approval lifetimes, cancellation, and reconciliation of uncertain external results. Do not blindly repeat a write after a timeout or crash.
- Connection selection, visible effective grants, owner revocation and an audit view identifying the environment, attributed task, account, operation and outcome without secrets or unnecessary sensitive payloads.

Use deterministic policy for the first operation set. A model-based Sentinel, browser sessions and universal provider authentication are not prerequisites.

## Delivery and effort

Build and validate the protected client/service boundary first, then the [grant contract](environment-grants.md), credential custody and one worker, connection/approval UI, and adversarial plus real-host acceptance. A fixed isolated test environment is enough to begin. Introduce it alongside existing workspaces; do not make primary-container recreation or bulk credential migration a prerequisite.

The discussion's broader planning budget was:

| Work                                             | Engineering days |
| ------------------------------------------------ | ---------------: |
| Architecture and boundary decisions              |           2 to 3 |
| Shared foundation and one runtime                |           5 to 8 |
| Credential broker and GitHub worker              |           4 to 6 |
| Connection, approval and audit interface         |           2 to 3 |
| Adversarial tests, packaging and host acceptance |           3 to 5 |
| Total                                            |         16 to 25 |

These are estimates, not measured agent runtime or delivery commitments. They exclude waiting for access, approvals and extended soaks. The historical 10 to 16 day pilot assumes one runtime, one manually enrolled connection, basic UI and narrow operations. The 3 to 5 day connector-only allowance assumes accepted infrastructure already exists. Re-estimate remaining work against accepted shared components; do not add all three estimates together. The two-daemon release's 12 to 16 focused-hour estimate covers a different scope.

Save time by starting with one runtime and connector, environment-level authority, typed API calls, basic UI and additive deployment. Preserve authentication, protected storage, scope checks, revocation and acceptance tests. Additional runtime support was estimated at 2 to 4 days after the runtime contract stabilizes; it is not required to prove the first broker.

## Acceptance evidence

Use disposable environments and synthetic accounts where possible. Check that:

- Files, environment variables, process inspection, logs and daemon APIs do not expose broker credentials to guests.
- Account, repository, operation or destination substitution cannot escape a grant. Redirects cannot carry credentials to an unapproved destination.
- Payload changes invalidate approval; expired, revoked and stale-generation capabilities fail before new dispatch.
- Reconnects, timeouts and crashes cannot silently duplicate writes. Report uncertain or partial outcomes without claiming rollback of completed external effects.
- Guests cannot replace the worker or owner interface, execute privileged client plugins, or automate an authenticated owner session.
- Credential recovery and environment recreation preserve intended durable state while invalidating stale authority.
- The owner can complete the workflow and revoke access from the real client, while the existing primary instance remains unaffected.

Keep machine paths, inventories and acceptance receipts outside Git. Record source integration, publication, installed behavior and acceptance separately. [Browser trust](browser-trust.md), [browser credential delegation](browser-credentials.md), [provider authentication](provider-auth.md) and [information-flow research](information-flow.md) retain their own scopes.
