#!/usr/bin/env bash
# Moves an existing Tailscale-mode deployment to gate mode, keeping its identity,
# home, workspace and Tailscale volume, and rolls back automatically when Dev does
# not become healthy. Inputs come from the environment, as for install.sh in gate
# mode: PASEO_IMAGE (a gate-capable Dev image), PASEO_GATE_IMAGE,
# PASEO_PUBLIC_HOSTNAME, PASEO_PROJECTS_FOLDER and optionally PASEO_CORS_ORIGINS,
# PASEO_GATE_RELAY_PORT, PASEO_GATE_SUBNET, PASEO_GATE_ROUTES and
# PASEO_INSTALLATION_PENDING.
#   gate.sh enable     Switch to gate mode (interrupts active tasks).
#   gate.sh rollback   Restore the Tailscale-mode deployment saved by enable.
set -euo pipefail
deployment="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$deployment/common.sh"
if [[ $# != 1 || ! -f "$deployment/.container-installation" ]]; then
  echo 'Usage: gate.sh enable|rollback (from an installed deployment).' >&2
  exit 1
fi
umask 077
saved="$deployment/.env.tailscale-mode"
inputs=(PASEO_IMAGE PASEO_GATE_IMAGE PASEO_PUBLIC_HOSTNAME PASEO_CORS_ORIGINS PASEO_PROJECTS_FOLDER
  PASEO_GATE_RELAY_PORT PASEO_GATE_SUBNET PASEO_GATE_ROUTES PASEO_INSTALLATION_PENDING PASEO_NETWORK_MODE)

rollback() {
  # Compose prefers the shell's variables over the .env it is given.
  unset "${inputs[@]}"
  if [[ ! -f "$saved" ]]; then
    echo 'No saved Tailscale-mode settings; nothing to roll back.' >&2
    return 1
  fi
  if paseo_gate_mode; then paseo_compose down; fi
  cp -p "$saved" "$deployment/.env"
  rm -f "$deployment/.gate-mode"
  paseo_compose up -d --pull never paseo
  echo 'Restored the Tailscale-mode deployment.'
}

case "$1" in
  rollback)
    rollback
    exit
    ;;
  enable) ;;
  *)
    echo 'Usage: gate.sh enable|rollback' >&2
    exit 1
    ;;
esac
if paseo_gate_mode; then
  echo 'This deployment is already in gate mode.'
  exit 0
fi
image="$(paseo_image "${PASEO_IMAGE:?Set PASEO_IMAGE to a gate-capable Dev image}")"
paseo_gate_capable "$image"
gate_image="$(paseo_gate_image "${PASEO_GATE_IMAGE:?Set PASEO_GATE_IMAGE}")"
public_hostname="${PASEO_PUBLIC_HOSTNAME:-}"
paseo_gate_hostname "$public_hostname"
cors_origins="${PASEO_CORS_ORIGINS:-https://$public_hostname}"
paseo_gate_origins "$cors_origins"
projects_folder="$(cd -P -- "${PASEO_PROJECTS_FOLDER:?Set PASEO_PROJECTS_FOLDER}" && pwd)"
paseo_projects_folder_compose "$projects_folder" >/dev/null
relay_port="${PASEO_GATE_RELAY_PORT:-6768}"
paseo_gate_port "$relay_port"
gate_subnet="${PASEO_GATE_SUBNET:-172.31.250.0/24}"
gate_address="$(paseo_gate_address "$gate_subnet")"
gate_routes="${PASEO_GATE_ROUTES:-}"
paseo_gate_routes "$gate_routes"
instance="$(sed -n 's/^PASEO_INSTANCE=//p' "$deployment/.env")"
installation_pending="${PASEO_INSTALLATION_PENDING:-1}"
unset "${inputs[@]}"

# Keep the first saved copy: a retried enable must still roll back to Tailscale mode.
[[ -f "$saved" ]] || cp -p "$deployment/.env" "$saved"
next="$(mktemp "$deployment/.env.XXXXXX")"
cp -p "$deployment/.env" "$next"
settings=(
  "PASEO_IMAGE=$image"
  "PASEO_GATE_IMAGE=$gate_image"
  "PASEO_PUBLIC_HOSTNAME=$public_hostname"
  "PASEO_CORS_ORIGINS=$cors_origins"
  "PASEO_PROJECTS_FOLDER=$projects_folder"
  "PASEO_GATE_RELAY_PORT=$relay_port"
  "PASEO_GATE_SUBNET=$gate_subnet"
  "PASEO_GATE_ADDRESS=$gate_address"
  "PASEO_INSTALLATION_PENDING=$installation_pending"
)
if [[ "$(uname -s)" == Linux ]]; then settings+=("PASEO_GATE_USER=$(id -u):$(id -g)"); fi
paseo_env_set "$next" "${settings[@]}"
mkdir -p "$deployment/gate/logs"
paseo_gate_config "$instance" "$gate_subnet" "$gate_routes" > "$deployment/gate/config.json"
docker compose --project-directory "$deployment" --env-file "$next" -f "$deployment/compose.gate.yaml" config --quiet

echo 'Moving Dev to gate mode. Active tasks will be interrupted; persistent state is retained.'
paseo_compose down
# A Compose file other than this deployment's (for example a hand-built gate) can leave the
# project's networks behind, and Compose would reuse them with their old subnet.
for network in environment egress; do
  if docker network inspect "${instance}_$network" >/dev/null 2>&1 &&
    ! docker network rm "${instance}_$network" >/dev/null; then
    echo "Network ${instance}_$network is still in use; stop what uses it, then rerun." >&2
    rollback >&2
    exit 1
  fi
done
mv "$next" "$deployment/.env"
printf '%s\n' 1 > "$deployment/.gate-mode"
if paseo_compose up -d --pull never && paseo_wait; then
  echo 'Dev runs in gate mode.'
  exit 0
fi
echo 'Dev did not become healthy in gate mode; rolling back.' >&2
rollback >&2
exit 1
