---
name: paseo-preview
description: Start, verify and share a private workspace preview through the managed Tailscale HTTPS preview broker. Use when asked for a preview, demo, live link, browser check, "show me", "show the owner", or any URL where someone else will open a running app.
user-invocable: true
---

# Workspace previews

A preview link is only valid when the managed preview broker returned it as `ready` and you checked the rendered page through it. The owner opens previews from other devices over Tailscale, so a loopback, LAN, container or `*.localhost` address is useless to them even when it works for you.

**Never share** a raw IP (`127.0.0.1`, `0.0.0.0`, `172.x`, `192.168.x`, `10.x`, `100.x`), `localhost`, a `*.localhost` proxy URL, or a port without the broker's HTTPS origin. The `proxy URLs` that `list_workspace_scripts` reports are local routing addresses, not shareable links. Never enable Tailscale Funnel or make the app public.

## 1. Configure the service

Define a `service` script in the workspace's `paseo.json` that uses the framework's real port option and `PASEO_PORT`:

```json
{
  "scripts": {
    "preview": {
      "type": "service",
      "command": "npm run dev -- --host 127.0.0.1 --port $PASEO_PORT --strictPort"
    }
  }
}
```

- Bind `127.0.0.1` on `$PASEO_PORT`. Never bind `0.0.0.0` or another wildcard to pass a readiness check.
- The broker launches the command with `PASEO_PREVIEW_ORIGIN` set to the reserved HTTPS origin. Consume that exact value for allowed hosts, callback URLs, write-origin checks and WSS/HMR settings. For Vite, that means `server.allowedHosts` containing its hostname and `server.hmr` with `protocol: "wss"`, `host` set to its hostname and `clientPort` set to its port. Do not hard-code a Tailscale hostname; read it from the variable.
- Variables in your own shell do not reach the service. Only the broker's environment does. If the origin changes for a running service, use the broker's `restart`.

## 2. Start it through the broker

Use the existing task workspace ID. Never create another workspace, checkout or proxy-only project to obtain a preview.

**Dev (container) agents** use the installed helper at `/home/paseo/.local/bin/paseo-preview` and read its full procedure first:

```sh
cat /home/paseo/.config/paseo-preview/AGENTS.md
paseo-preview start preview --workspace WORKSPACE_ID
paseo-preview status preview --workspace WORKSPACE_ID
paseo-preview restart preview --workspace WORKSPACE_ID
paseo-preview stop preview --workspace WORKSPACE_ID
```

**Host agents** use the native helper:

```sh
node ~/.local/share/vorteo-native-preview/paseo-preview.mjs start preview --workspace WORKSPACE_ID
node ~/.local/share/vorteo-native-preview/paseo-preview.mjs status
node ~/.local/share/vorteo-native-preview/paseo-preview.mjs stop preview --workspace WORKSPACE_ID
```

Replace `preview` with the configured script name. Repeating `start` adopts the same reservation and keeps the same HTTPS port.

## 3. Verify, then share

- Only a `ready` result carries a verified URL. `pending` means wait and run `status` again. A timeout is not permission to kill listeners, restart the daemon or try another directory.
- Open the returned `https://` URL and confirm the app actually rendered: a browser snapshot or screenshot showing real content, not just an HTTP 200. Check that HMR or the WebSocket connects when the app needs it.
- Share exactly the `https://…ts.net:PORT/` origin the broker returned, plus any app path.

## When the broker fails

Report the `failed` result and its diagnostic or receipt error verbatim, say the preview is not available, and state what must change (for example a host policy update for the workspace). Do not substitute an IP, `localhost`, `*.localhost`, port-forward or tunnel link, and do not present a link you have not verified. Host-side broker or policy repair belongs to the Host operator; Dev agents prepare a Host continuity prompt instead of using Docker, the Tailscale socket or host scripts.
