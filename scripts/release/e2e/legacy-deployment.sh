#!/usr/bin/env bash
# Creates a standalone container deployment exactly as an earlier release's
# docker/multiplex/install.sh did, for the legacy wrap test. Test-only.
#
# Usage: legacy-deployment.sh <git ref> <image> <new deployment dir> <state dir>
#
# The legacy installer ends by running connect.sh, which waits for an
# interactive Tailscale login, and its daemon does not start until Tailscale
# enrolls. CI has no tailnet, so this script:
#   1. extracts docker/multiplex from the legacy ref and replaces only
#      connect.sh with a stub, then runs the legacy install.sh unchanged;
#   2. stops the deployment and starts its image once with the same home in
#      gate mode with no network, so the real legacy daemon creates its own
#      server-id (the identity the wrap must preserve);
#   3. starts the deployment again, leaving it as an owner who never finished
#      enrollment would have it, and records the server-id in the state dir.
# Gate mode exists in the legacy image from 0786238 onward; older refs fail at step 2.
set -euo pipefail
ref="${1:?Supply the legacy git ref}"
image="${2:?Supply the legacy image}"
deployment="${3:?Supply a new deployment directory}"
state="${4:?Supply the state directory}"
source_tree="$(mktemp -d)"
seed="vorteo-e2e-legacy-seed-$$"
trap 'rm -rf "$source_tree"; docker rm -f "$seed" >/dev/null 2>&1 || true' EXIT

git archive "$ref" docker/multiplex | tar -x -C "$source_tree"
cat > "$source_tree/docker/multiplex/connect.sh" <<'STUB'
#!/usr/bin/env bash
echo 'Release test: Tailscale enrollment skipped.'
STUB
bash "$source_tree/docker/multiplex/install.sh" "$deployment" "$image"

compose=(docker compose --project-directory "$deployment" --env-file "$deployment/.env" -f "$deployment/compose.yaml")
"${compose[@]}" stop paseo
# The historical image predates initialization of private Linux bind mounts.
# Prepare only this new disposable fixture before starting the unchanged daemon.
docker run --rm --network none --entrypoint bash \
  -v "$deployment/data/home:/home/paseo" -v "$deployment/workspace:/workspace" \
  "$image" -c 'chown paseo:paseo /home/paseo /workspace; install -d -o paseo -g paseo -m 0700 /home/paseo/.paseo'
password="$(sed -n 's/^PASEO_PASSWORD=//p' "$deployment/.env")"
docker run -d --name "$seed" --network none \
  --cap-drop ALL --cap-add SETUID --cap-add SETGID --cap-add SETPCAP --cap-add CHOWN \
  --tmpfs /run/tailscale:mode=0700 --tmpfs /run/personal-tailscale:mode=0700 \
  -e PASEO_PASSWORD="$password" -e PASEO_NETWORK_MODE=gate \
  -e PASEO_HOSTNAMES=localhost -e PASEO_CORS_ORIGINS=http://localhost \
  -v "$deployment/data/home:/home/paseo" -v "$deployment/workspace:/workspace" \
  "$image" >/dev/null
server_id=""
for _ in $(seq 1 120); do
  # The daemon owns the file as the container's agent user; Linux runners need sudo to read it.
  server_id="$(cat "$deployment/data/home/.paseo/server-id" 2>/dev/null || sudo -n cat "$deployment/data/home/.paseo/server-id" 2>/dev/null || true)"
  [[ "$server_id" =~ ^srv_ ]] && break
  sleep 1
done
docker exec --user paseo "$seed" sh -c 'printf "%s" "legacy home preserved" > /home/paseo/legacy-acceptance.txt; printf "%s" "legacy workspace preserved" > /workspace/legacy-acceptance.txt'
docker rm -f "$seed" >/dev/null
if [[ ! "$server_id" =~ ^srv_ ]]; then
  echo 'The legacy daemon did not create a server-id within two minutes.' >&2
  exit 1
fi
"${compose[@]}" start paseo
mkdir -p "$state"
printf '%s\n' "$server_id" > "$state/legacy-server-id"
echo "Legacy deployment at $deployment with Dev server-id $server_id"
