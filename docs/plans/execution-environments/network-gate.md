# Environment network gate

Status: proposed October 29, 2026. Nothing here is implemented. A lab prototype is the next step.

## Goal

Every container environment reaches the network only through one Host-owned gate per installation. The gate is the environment's only way in and out. It records every connection that leaves an environment, refuses tailnet, Host and local-network destinations, and gives the [credential broker](credential-broker.md) the one place where it can attach credentials and record their use. The [native edge](host-core-services.md#phase-1-take-docker-off-the-critical-path) stays the front door for people: one hostname per environment, one Tailscale node per installation.

## Findings

Observed on one macOS installation with Docker Desktop and the Host's Tailscale signed in. A plain container from the Dev image, with no Tailscale of its own and running as the unprivileged agent user, could:

- open TCP connections to other tailnet nodes, including another installation's Host interface, Dev daemon and custom-domain gateway, and query MagicDNS for tailnet names;
- open connections to the Host's loopback services through `host.docker.internal`, including the installation coordinator, the Host daemon and Dev's own published port;
- reach the local network's router.

Docker Desktop forwards container traffic through the Mac's network stack, so the Mac's Tailscale carries it. That traffic reaches the tailnet as the Mac's node, with the owner's access, not as the container's node. Tagging Dev's node and restricting the tag in tailnet policy therefore does not confine Dev agents. Removing Dev's node without other changes would not confine them either. Authentication still protects each service, but Dev agents should not be able to open a socket to Host control endpoints or other machines at all.

Dev's own Tailscale node exists for two jobs: the Dev daemon's HTTPS route and managed previews (see [previews through the Host](host-core-services.md#phase-1-take-docker-off-the-critical-path)). The compose file also maps `host.docker.internal` on purpose so Pi agents can reach a model server on the Host.

## Architecture

| Part        | Runs                                                                      | Owns                                                                                 |
| ----------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Edge        | Native Caddy and a userspace `tailscaled` on the Host                     | Inbound HTTPS for the interface, each environment and previews                       |
| Gate        | One reviewed container per installation, configured from Host-owned files | Inbound relay to environments, outbound proxy, connection log, credential attachment |
| Environment | One container per environment on its own `internal` Docker network        | Its daemon, agents, tools and scratch                                                |
| Authority   | Coordinator and broker on the Host, outside guest mounts                  | Grants, credential custody, owner approvals, audit views                             |

The gate must be a container: on Docker Desktop, Host processes cannot join Docker networks, which live in Docker's VM. Its image carries no agent code. Its configuration and policy are read-only mounts of Host-owned files; its logs are written to a Host-owned folder that no environment mounts. The gate fails closed. If it stops, environments lose the network, and nothing falls back to a direct route.

### Environments

- Each environment attaches only to its own `internal: true` network. Docker gives such a network no route out and no published ports.
- No `NET_ADMIN`, no `/dev/net/tun`, no `tailscaled`, no `host.docker.internal` mapping.
- No external DNS. The environment learns one name, the gate's, from Docker's network-scoped resolver.
- Separate networks keep environments apart: one environment cannot reach another, and the gate identifies the environment from the network a connection arrives on. A guest cannot forge that.

### Inbound

The edge maps `<environment>.<installation domain>` to a Host loopback port published by the gate, and the gate relays it to the environment's daemon. Previews follow the same path with their reserved port range. Each environment and preview needs its own browser origin, so routes use hostnames, never paths. Ports on one hostname do not separate cookies. Wildcard certificates for `*.<installation domain>` avoid a DNS record and a public certificate log entry for every new environment; the native gateway does not accept wildcard hostnames yet.

### Outbound

Environments use the gate as an explicit proxy for every connection, through `HTTP_PROXY`, `HTTPS_PROXY`, `NODE_USE_ENV_PROXY=1`, Git's `http.proxy`, and an SSH `ProxyCommand` that tunnels through HTTP `CONNECT`. A tool that ignores the proxy has no route and fails.

The gate resolves each destination itself and checks the resolved address before connecting, which defeats DNS rebinding. It refuses loopback, private IPv4 ranges, `100.64.0.0/10`, link-local addresses including cloud metadata, unique-local IPv6 including Tailscale's `fd7a:115c:a1e0::/48`, and Docker's host gateway. Host services an environment needs, such as a local model server, become named gate routes with their own policy instead of raw Host access.

Two policy templates match the [risk tiers](host-core-services.md#phase-4-multiple-containers-for-discussion): **Standard** allows the public internet minus the refused ranges, and **Sealed** allows only listed destinations.

### Audit

The gate writes one JSON line per connection: time, environment identity and generation, attributed workspace and agent when known, method, requested host and port, resolved address, decision and the rule that made it, bytes each way, duration, and credential attachments by grant ID. It never records payloads, headers or credential values.

Attribution below the environment is a label, not proof. The daemon gives each agent process its own proxy credentials so the log names the agent, but agents in one environment can read each other's environment and files. The environment is the isolation principal, as [environment grants](environment-grants.md) requires.

The log covers every connection that leaves an environment. A connection that tries to bypass the gate fails inside the environment and never reaches it. Recording those attempts would need logging inside each environment's network namespace; treat that as optional.

The gate does not decrypt TLS. Content inspection would put every credential and payload in view of the gate and its logs, and it belongs to [HTTPS mediation](https-mediation.md) research, not this project.

## Credential attachment

The gate is where the [credential broker](credential-broker.md) attaches credentials, so that environments never hold them:

- **Provider endpoints.** For API-key services, the gate serves a named route such as `http://gate/<connection>/` that forwards to the provider over TLS with the Host-held key. The environment sees a placeholder. This needs no TLS interception, works with any client that accepts a base URL, and each route carries its own method and path policy.
- **Typed operations.** Services where a raw token grants too much, such as GitHub writes, stay with the broker's typed operations. The gate refuses direct use of those services from environments that have a typed connector.
- **Subscription sign-ins.** Provider CLIs that refresh their own OAuth tokens keep doing so until [provider authentication](provider-auth.md) moves refresh to the Host. One refresh writer per credential still applies.

Every attachment is an audit event: which grant, which credential, which environment and attributed agent, which destination and route, when, and the outcome. That record answers "which requests carried this credential" exactly, because the gate added it. A credential an environment holds itself cannot be traced this way without decrypting traffic.

Hiding a credential does not limit its use. An agent can still send anything a route allows, so route policy, scoped tokens and typed operations decide what the credential can do.

## Phases

1. **Lab prototype.** One gate with one internal network for the lab's Dev, inbound daemon route and Standard outbound policy, Dev recreated without Tailscale or `NET_ADMIN`, edge hostnames for the interface and Dev, and per-connection logs. Previews may stay unavailable in this phase. Acceptance: from inside Dev, connections to the tailnet, the Host, the local network and metadata addresses fail; npm, Git over HTTPS and SSH, and each provider CLI work through the gate; every one of those connections appears in the log; the interface and Dev work from a phone.
2. **Previews and wildcard routes.** Preview ranges through the gate, wildcard certificates at the edge.
3. **Agent attribution.** Per-agent proxy credentials issued by the daemon, shown in an audit view.
4. **Credential attachment.** One API-key provider route behind a broker grant, with attachment audit and revocation.
5. **More environments.** Each new environment from [task containers](docker-task-containers.md) gets its own internal network on the same gate and a Standard or Sealed template.
6. **Production.** Through Builds after lab acceptance, in a planned Dev recreation window.

## Effort

Estimates are focused engineering time, not calendar time. They exclude owner waits, Docker image builds running unattended, and extended soaks. Ranges widen where compatibility is unmeasured.

| Phase                           | Work                                                                                                      |                                                                                                  Engineering time |
| ------------------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------: |
| 1. Lab prototype                | Gate binary with tests: `CONNECT`, absolute-form HTTP, inbound relay, resolve-then-check policy, JSON log |                                                                                                      4 to 6 hours |
|                                 | Gate image and lab topology: internal network, Dev without `NET_ADMIN`, tun or Tailscale                  |                                                                                                      1 to 2 hours |
|                                 | Dev image gate mode: startup without Tailscale, health check, proxy settings for Node, Git and SSH        |                                                                                                      2 to 3 hours |
|                                 | Tool compatibility: npm, Git, provider CLIs, the Dev daemon's own outbound calls                          |                                                                                                      2 to 4 hours |
|                                 | Inbound route, coordinator endpoint, origin admission, edge hostnames                                     |                                                                                                      1 to 2 hours |
|                                 | Isolation and audit acceptance, report                                                                    |                                                                                                      1 to 2 hours |
|                                 | **Phase 1 total**                                                                                         |                                                                                                **11 to 19 hours** |
| 2. Previews and wildcard routes | Preview range through the gate, broker runtime change, wildcard edge certificates                         |                                                                                                       1 to 2 days |
| 3. Agent attribution            | Per-agent proxy credentials from the daemon, audit view in the interface                                  |                                                                                                       1 to 2 days |
| 4. Credential attachment        | One API-key provider route behind a grant, attachment audit, revocation                                   |                                                                                    3 to 5 days after grants exist |
| 5. More environments            | Per-environment networks and templates on the shared gate                                                 | Inside [Phase 4 of core services](host-core-services.md#phase-4-multiple-containers-for-discussion), 3 to 5 weeks |
| 6. Production                   | Builds delivery and a planned Dev recreation window                                                       |                                                                                               Half a day to a day |

The full credential broker with admin panel, workspace allowlists and complete use audit builds on [environment grants](environment-grants.md) and the broker plan's 16 to 25 day estimate. Phases 3 and 4 here replace part of that work; do not add the estimates together.

## Decisions before implementation

- **Gate implementation.** Recommended: a small purpose-built proxy whose code covers exactly `CONNECT`, absolute-form HTTP, inbound relay, resolve-then-check policy and JSON logging, built and digest-pinned like the edge. Alternatives: Squid, Envoy, or Caddy with a forward-proxy plugin. Each has a larger configuration surface than this policy needs.
- **Default policy** for the first Dev environment: Standard or Sealed.
- **Local model servers:** which Host services become named gate routes.
- **Docker Desktop's own container proxy** (offered on some Docker subscriptions) is not required and is not assumed.

## Gains and losses

Gains: environments cannot reach the tailnet, the Host or the local network; one log covers every outbound connection; credentials can stay out of environments with exact usage records; one Tailscale node per installation; no privileged network service in Dev.

Losses: tools that ignore proxy settings stop working until configured; the gate is a single point of failure for every environment's network; previews need new plumbing; the gate adds one container and one image to review and update.
