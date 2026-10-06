# Private custom-domain gateway

Use this after the [initial browser handoff](../README.md#instructions-for-installation-agents). Run host commands from an authorized operator session. Agents inside an application container do not need Docker or Tailscale administration privileges.

The [templates](../docker/private-domain/) add a separate gateway without moving the application. They use Cloudflare DNS and a Caddy build containing its DNS plugin. For another DNS provider, replace the plugin, credential handling and Caddy TLS provider together before deployment.

## Prepare the gateway

You need a working private HTTPS application address, a domain you control, Docker Compose and permission to enroll a dedicated Tailscale node. Choose a unique gateway name and restrict network access to the intended users. The gateway must also be allowed to reach the application's private upstream. Review existing grants: adding a narrow grant does not cancel broader access already allowed.

From the repository root, copy the templates outside the checkout:

```sh
cp -R docker/private-domain "$HOME/paseo-domain"
cd "$HOME/paseo-domain"
cp .env.example .env
chmod 600 .env
mkdir -m 700 secrets
install -m 600 /dev/null secrets/cloudflare_dns_token
```

Use a new directory for each gateway. Edit `.env` with the chosen names and the existing private upstream. `PUBLIC_HOSTNAME` is a hostname without a scheme or path. `UPSTREAM_HOST` is the hostname on the upstream's trusted HTTPS certificate. `UPSTREAM_PORT` is its stable HTTPS port; for a managed preview, use the broker's reserved frontend, not its dynamically allocated application port.

Create a Cloudflare API token with **Zone / DNS / Edit** and **Zone / Zone / Read**, limited to the one required zone. Save its value in `secrets/cloudflare_dns_token` using a private editor. Do not paste it into command arguments, source, screenshots or logs. Only Caddy mounts this file.

The Compose project publishes no host ports. Tailscale forwards private TCP traffic to Caddy's loopback listener in their shared network namespace. The internal ports are paired in the templates; leave them unchanged. Caddy verifies the upstream certificate while preserving the browser's Host and Origin for application checks.

## Allow the application origin

Keep existing origins and authentication. Do not replace allowlists with wildcards or rewrite Origin at the proxy to bypass checks.

For a Vorteo container installed with `docker/multiplex`, merge these entries into `compose.override.yaml` in the **application's** private deployment directory, substituting your hostname:

```yaml
services:
  paseo:
    environment:
      PASEO_HOSTNAMES: paseo.example.com
      PASEO_CORS_ORIGINS: https://paseo.example.com
```

If these variables already contain custom entries, append yours to their comma-separated values. The container startup script also retains its original Tailscale hostname and origin. Merely adding variables to `.env` does not pass them to the application container. Applying changed Compose environment requires container recreation; coordinate any interruption of an existing Vorteo instance with its owner before running `docker compose up -d paseo` from that deployment directory.

For the separate Vorton application, merge `externalOrigin` into its private `local.config.json` and retain the existing broker URL in `additionalOrigins`:

```json
{
  "externalOrigin": "https://vorton.example.com",
  "additionalOrigins": ["https://application.example-tailnet.ts.net:12345"]
}
```

Replace the example broker address with the actual stable frontend. Preserve other configuration fields. Use the application's managed lifecycle to apply the change and verify that its companion also accepts the exact new origin. This configuration belongs to the separate Vorton application.

## Start and verify

From the **gateway** deployment directory:

```sh
docker compose config --quiet
docker compose build caddy
docker compose up -d tailscale
docker compose exec tailscale tailscale up --accept-dns=true --accept-routes=false --ssh=false
```

Complete the printed Tailscale login and any administrator approval. If enrollment exceeds the startup timeout, start the gateway's Tailscale service again. Do not change an existing application's Tailscale identity or Serve routes. Keep Funnel disabled. In the Tailscale administration console, verify the gateway's access grants and plan for its device-key expiry.

```sh
docker compose run --rm --no-deps caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
docker compose up -d caddy
docker compose ps
docker compose logs --tail=80 caddy
docker compose exec tailscale tailscale ip -4
```

Caddy obtains the certificate by creating a temporary DNS TXT record. Public inbound access is not required. If issuance fails, fix DNS permissions, propagation or outbound connectivity; do not disable TLS verification or open public ports.

Before changing the hostname's address record, test from a Tailscale-connected device. Substitute the chosen hostname and the gateway address printed above:

```sh
curl --fail --show-error --resolve 'paseo.example.com:443:100.64.0.10' https://paseo.example.com/ -o /dev/null
```

Use an address actually assigned to this gateway. `--resolve` tests the chosen hostname and its certificate without waiting for its address record. An authentication challenge can be expected; it does not prove a successful login. Do not add `--insecure`.

Create the hostname's Cloudflare **DNS-only A record** pointing to that gateway address. Remove or correct conflicting records for that hostname; do not touch unrelated records. Add an AAAA record only if that gateway's IPv6 route is also verified. DNS and certificate transparency can reveal the hostname even though application access stays private.

Open the final URL normally on an intended user's device. Check certificate trust, login, page rendering and a live WebSocket-backed interaction. Confirm denied access from an unauthorized device and with Tailscale disconnected. Recheck the original application address. An agent lacking those device contexts must ask for those specific checks and leave them marked unverified until reported. Then hand over the clickable address.

## Keep it running or remove it

Certificate and Tailscale identity volumes survive container replacement. Keep those volumes and the private configuration in your backup plan. Caddy needs the DNS token and outbound connectivity for renewal; initial issuance does not prove a future renewal. Docker restart policies do not wake a sleeping host, unlock FileVault, start Docker after login or recover the upstream application.

For gateway maintenance, coordinate downtime, back up its private state, rebuild reviewed image pins and run `docker compose up -d` from its deployment directory. Recheck HTTPS and live connectivity afterward. Recreating Tailscale changes the shared network namespace, so recreate Caddy with it. Avoid blanket Serve resets and never restart the shared application as a gateway troubleshooting shortcut.

To remove the gateway, restore the original bookmark, remove only its custom DNS records, and run `docker compose down` from the gateway directory. Retain volumes for rollback. Remove the custom application origin through its normal maintenance flow, revoke the gateway's DNS token and retire its Tailscale node when rollback is no longer needed. Leave the application and unrelated gateways running.

References: [Tailscale containers](https://tailscale.com/docs/features/containers/docker), [Caddy DNS validation](https://caddyserver.com/docs/automatic-https#dns-challenge), [Cloudflare Caddy plugin](https://github.com/caddy-dns/cloudflare), [Cloudflare DNS-only records](https://developers.cloudflare.com/dns/proxy-status/).
