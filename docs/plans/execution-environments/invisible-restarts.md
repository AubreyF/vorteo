# Invisible Host restarts

Status: investigation and design, October 28, 2026. Two small parts are implemented on a task branch (see [What is implemented](#what-is-implemented)). Nothing here is installed or live-verified.

Goal: a Host daemon worker restart or release upgrade should not be visible to the owner. The interface keeps working, open threads reconnect without a visible outage, and running agents continue.

## How a Host update looks today

### Who serves what

- The installation coordinator serves the web interface on its own loopback port, behind the installation's private HTTPS origin. It is a separate launchd job from the Host daemon and keeps running through Host restarts. See `createWebUiMiddleware` in `packages/server/src/server/execution-installation/server.ts` and `app.listen` in `execution-installation/main.ts`.
- The Host daemon listens on its own loopback port, behind a second private HTTPS port (the installation's `hostOrigin`). The interface opens its WebSocket there.
- The daemon worker binds that port itself, in `start()` in `packages/server/src/server/bootstrap.ts`, after the whole daemon is constructed. The supervisor (`packages/server/scripts/supervisor.ts`) never holds a socket. It forks the worker and respawns it on IPC restart or crash.

So the interface's HTML and JavaScript keep loading during a Host restart. Only the WebSocket to the Host daemon goes dark.

### Which restart path runs

- Owner-approved Host restarts and source updates run `launchctl kickstart -k` on the Host job (`execution-installation/daemon.ts`, `restart`). That stops the supervisor and its worker. launchd then starts a new supervisor through the current release link. A supervisor-held socket would not survive this path.
- Idle restarts send `restartServer` with `idleMode: "restart"` to the worker. The supervisor stays and respawns the worker in place. Crash restarts take the same in-place path.

### Measured gap

From the Host's daemon log, the time between the old worker closing its HTTP server and the new worker logging `Server listening` was 3.6 to 31.5 seconds across the last 15 Host restarts, with a median near 10 seconds. In the most recent one:

| Step                                                   | Time after stop request |
| ------------------------------------------------------ | ----------------------- |
| Worker reaches the `websocket server` shutdown step    | 0.4 s                   |
| Old worker still waiting on WebSocket close handshakes | 0.4 s to 5.0 s          |
| New supervisor spawns a worker                         | 5.2 s                   |
| New worker listens                                     | 10.2 s                  |
| Worker reports ready                                   | 11.2 s                  |
| Hosted sessions reattached (5 of 5)                    | 19.0 s                  |

During the gap the private HTTPS proxy answers the upgrade with a gateway error, so the browser sees an abnormal close (1006). Before the old worker closes its listener, it closes new WebSockets immediately with 1001 `Server shutting down`.

In that restart the old worker never finished its `websocket server` step. One of three sockets did not answer the close frame, and `ws` waits 30 seconds for that by default. The worker exited only when it lost its supervisor 4.6 seconds later.

### How the client reacts

`DaemonClient` in `packages/client/src/daemon-client.ts`:

- Reconnects with exponential backoff: 1.5, 3, 6, 12 and 24 seconds, capped at 30. After a 10-second outage the next attempt often lands at 10.5 or 22.5 seconds, so the client can stay offline for 12 seconds after the daemon is back.
- Rejects every pending request and queued send when the transport drops (`scheduleReconnect`). Sends made while disconnected fail at once. Sends made while connecting wait up to 60 seconds.
- Composer submissions survive this: `packages/app/src/composer/submission/writer.ts` waits up to 60 seconds for the host timeline to confirm a message, and resynchronizes history after reconnect.
- The app shows the host as offline as soon as the transport drops. There is no grace period.

## What is implemented

On branch `feat/invisible-restarts`, not installed:

1. **Bounded WebSocket shutdown.** The daemon closes each socket with 1001 `Server shutting down` and drops any peer that has not completed the close handshake after one second (`closeForShutdown` in `packages/server/src/server/websocket-server.ts`). This removes the stall above, up to 30 seconds, from the old worker's exit. Older clients already treat any close as a reason to reconnect.
2. **Fast reconnect after an announced shutdown.** When the daemon closes with 1001 `Server shutting down`, the client retries every 500 ms for up to one minute instead of backing off. The window opens once per restart and closes on the next successful connection. After a minute the normal backoff resumes, so a daemon that is really down is not polled forever. An older daemon that closes without that code still gets the normal backoff.

Together these cut the visible outage from roughly 10 to 22 seconds to roughly the time the new worker needs to listen, about 5 to 10 seconds. Neither change adds a wire field or needs a capability.

## Design for the remaining gap

The remaining gap is the replacement process starting up. Removing it needs a listener that outlives the worker and the supervisor.

### Option A: keep the supervisor and hand the socket to each worker

1. Change approved Host restarts and source updates from `launchctl kickstart -k` to an in-place worker swap through the supervisor. The supervisor already resolves the worker entry at spawn time, so a new release under the current link is picked up. The supervisor's own code only changes when supervisor maintenance replaces it.
2. The supervisor binds the daemon port once and passes the listening handle to each worker over IPC (`child.send(message, server)`). The worker calls `httpServer.listen(handle)` instead of binding. While no worker holds the handle, connections wait in the kernel backlog instead of being refused.
3. The listen-reclaim path (`packages/server/src/server/listen-reclaim.ts`) and the injected custody launcher (`scripts/supervisor-worker-launch.ts`) must accept a received handle.
4. Listening early does not mean ready. The worker must keep refusing WebSocket upgrades until `beginAcceptingConnections`, or hold them until then, so a client does not reach a half-built daemon.

Risks: this changes the approved maintenance path, which has receipts, fences and native observation built around `kickstart -k`. The coordinator's replacement check (`waitForReplacement`) compares worker PIDs and would still work, but every executor that assumes a new supervisor PID needs review. Estimate: several days with tests, plus a tracked live acceptance. It does not fit this task.

### Option B: have the coordinator front the Host daemon

Point the Host's private HTTPS port at a small proxy in the coordinator, which already survives Host restarts. The proxy forwards HTTP and WebSocket upgrades to the daemon port, and while the daemon refuses connections it holds new upgrades for a bounded time, about 30 seconds, instead of failing them.

- Existing WebSockets still drop when the old worker exits. The client reconnects at once and the proxy holds that attempt until the new worker listens, so the client never sees a refusal.
- Changing the Tailscale Serve route is an installation change. It needs a reviewed plan through the coordinator, like the launcher update.
- The coordinator itself restarts during coordinator maintenance, which is rarer than Host updates.

Option B covers both `kickstart -k` and in-place restarts and leaves the daemon untouched. It is the recommended next step.

### Option C: launchd socket activation

launchd can own the listening socket through the plist `Sockets` key, so connections queue while the job restarts. Node has no built-in support for `launch_activate_socket`, so this needs a native addon. Not recommended.

### Interface work for any option

- Show a short "Reconnecting" state, not "offline", for the first few seconds after an announced shutdown. Keep a failed send visible as it is today.
- Optionally let `sendWhenConnected` queue sends while the restart window is open, instead of failing them at once. This changes request semantics for every caller and needs its own review.

## Durable sessions by default

Durable sessions keep provider turns running in the session host while the worker restarts. On this Host the setting file is already enabled and the last restart reattached all five hosted sessions, so agents there already survive restarts. Making it the default for new installations needs more than Codex live acceptance:

1. **The setting.** A missing `durable-sessions.json` means off (`readDurableSessionsSettings` in `packages/server/src/server/session-host/settings.ts`). Default-on should be written by the installer as `{"enabled": true}`, not by changing what a missing file means. Standalone daemons without a session host would otherwise report the feature as on, and older releases read a missing file as off after a rollback.
2. **The session host job.** It is installed only through an owner-approved coordinator request, only on a macOS Host with source updates and Host startup validation configured (`createSessionHostExecutor` in `execution-installation/main.ts`). The installer must install the job before enabling the setting, and there is no systemd job for a Linux Host and no job in the Dev container.
3. **Removal.** Removal is refused while the setting is on. Uninstall must turn the setting off and wait for hosted sessions to finish first.
4. **Upgrades.** The session host stays on its release until no hosted turn runs. A long turn keeps an older session host alive until it ends or the owner approves a session host restart, which interrupts hosted turns.
5. **Rollback.** Once a session host record exists in the lifecycle journal, the rollback coordinator must support session host records.
6. **Acceptance.** Codex hosting is covered by unit and isolated end-to-end tests. Its live acceptance on a real installation remains.

Do not flip the default in code. Flip it in the installer once items 2, 3 and 6 are done.

## Acceptance for the implemented parts

- During a tracked Host restart, an open interface reconnects within about one second of the new worker listening, without reaching the 3-second or later backoff steps.
- The old worker's `websocket server` and `http server` shutdown steps complete within about one second, even with a client that never answers the close.
- An ordinary network drop still uses the normal backoff.
