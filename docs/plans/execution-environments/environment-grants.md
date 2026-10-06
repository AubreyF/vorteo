# Environment identities and task grants

Status: future project. This adds selective authority beyond the trusted-host first release.

Mint environment identities and generations on the host. Bind narrowly typed operations to an environment, workspace, task, expiry, and reviewed request revision. Guest-supplied names, paths, or agent IDs are not proof of authority. Keep owner approvals and grant state outside guest storage.

Arbitrary code in one guest can steal other credentials accessible in that guest. Treat the environment as the isolation principal. Separate mutually hostile agents into different environments rather than pretending per-agent bearer tokens solve this.

Reuse existing semantic daemon permissions where applicable, but do not advertise workspace confinement before every affected file, execution, observation, and lifecycle path enforces it. Avoid a general shell or unrestricted URL operation disguised as a grant.

Acceptance: replay and stale-generation rejection, scope enforcement, revocation before dispatch, approval-payload integrity, and denial of guest-created authority. Define what happens to in-flight work; revocation cannot undo completed external effects.

Dependencies: protected host installation and interface. Can initially be tested with isolated fake environments without either container backend. The credential broker consumes this contract but must not duplicate it. Full-access owner-account host agents remain trusted.

The environment manager owns identity issuance, generation changes, workspace binding and lifecycle. The authority service outside guests owns current grants. A connector request authenticates a bounded environment principal; caller-supplied task IDs provide attribution only unless a stronger isolation mechanism establishes them. Authenticate transport across the actual host/guest boundary rather than assuming local Unix peer credentials identify a process across a VM.

Bind service grants to the connection, target resources and allowed operations as well as environment identity, generation and expiry. Proposed approval choices include one operation, a task lifetime, or a bounded time window. Choose the supported set before implementation. Recheck grants immediately before dispatch, and invalidate old capabilities after environment recreation. Document the treatment of already-dispatched operations.

Delegated authority must be equal or narrower. Sibling agents sharing an environment still share its effective authority; task labels cannot provide stronger confinement. Changing a model provider must not silently select another service account or widen access. Installation records, daemon connection IDs, owner-message evidence and restart approvals are not service grants.
