#!/usr/bin/env bash
set -euo pipefail
source_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$source_dir/common.sh"
if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo 'Usage: install.sh NEW_DEPLOYMENT_DIRECTORY [IMAGE]' >&2
  exit 1
fi
if [[ -e "$1" || -L "$1" ]]; then
  echo 'Choose a new directory. Existing installations are never overwritten.' >&2
  exit 1
fi
parent="$(cd "$(dirname "$1")" && pwd)"
deployment="$parent/$(basename "$1")"
repo_root="$(cd "$source_dir/../.." && pwd)"
case "$deployment/" in "$repo_root/"*) echo 'Keep deployment state outside the source checkout.' >&2; exit 1 ;; esac
projects_folder=""
if [[ -n "${PASEO_PROJECTS_FOLDER:-}" ]]; then
  projects_folder="$(cd -P -- "$PASEO_PROJECTS_FOLDER" && pwd)"
  case "$deployment/" in "$projects_folder/"*) echo 'Keep deployment state outside the Projects folder.' >&2; exit 1 ;; esac
  paseo_projects_folder_compose "$projects_folder" >/dev/null
fi
if [[ -n "${PASEO_HOST_LOOPBACK_PORT:-}" ]]; then
  paseo_host_loopback_compose "$PASEO_HOST_LOOPBACK_PORT" >/dev/null
fi
# Gate mode (PASEO_NETWORK_MODE=gate) is for an installation's Dev environment: the
# Host's installer supplies its public name, origins, relay port and gate routes.
network_mode="${PASEO_NETWORK_MODE:-tailscale}"
case "$network_mode" in
  tailscale) ;;
  gate)
    if [[ -z "$projects_folder" ]]; then
      echo 'Gate mode needs PASEO_PROJECTS_FOLDER.' >&2
      exit 1
    fi
    if [[ -n "${PASEO_HOST_LOOPBACK_PORT:-}" ]]; then
      echo 'Gate mode publishes the gate relay instead; set PASEO_GATE_RELAY_PORT, not PASEO_HOST_LOOPBACK_PORT.' >&2
      exit 1
    fi
    public_hostname="${PASEO_PUBLIC_HOSTNAME:-}"
    paseo_gate_hostname "$public_hostname"
    cors_origins="${PASEO_CORS_ORIGINS:-https://$public_hostname}"
    paseo_gate_origins "$cors_origins"
    relay_port="${PASEO_GATE_RELAY_PORT:-6768}"
    paseo_gate_port "$relay_port"
    gate_subnet="${PASEO_GATE_SUBNET:-172.31.250.0/24}"
    gate_address="$(paseo_gate_address "$gate_subnet")"
    gate_routes="${PASEO_GATE_ROUTES:-}"
    paseo_gate_routes "$gate_routes"
    installation_pending="${PASEO_INSTALLATION_PENDING:-1}"
    if [[ "$installation_pending" != 0 && "$installation_pending" != 1 ]]; then
      echo 'PASEO_INSTALLATION_PENDING must be 0 or 1.' >&2
      exit 1
    fi
    ;;
  *) echo 'PASEO_NETWORK_MODE must be tailscale or gate.' >&2; exit 1 ;;
esac
command -v docker >/dev/null
docker compose version >/dev/null
docker info >/dev/null
if [[ $# == 2 ]]; then
  image="$(paseo_image "$2")"
else
  build_receipt="$(mktemp)"
  trap 'rm -f "$build_receipt"' EXIT
  build_commit=""
  if command -v git >/dev/null && [[ -e "$repo_root/.git" ]]; then
    build_commit="$(git -C "$repo_root" rev-parse HEAD)"
  fi
  docker build --build-arg "PASEO_BUILD_COMMIT=$build_commit" --iidfile "$build_receipt" -f "$repo_root/docker/base/Dockerfile" "$repo_root"
  image="$(paseo_image "$(cat "$build_receipt")")"
fi
if [[ "$network_mode" == gate ]]; then
  paseo_gate_capable "$image"
  gate_image="$(paseo_gate_image "${PASEO_GATE_IMAGE:-$("$repo_root/docker/gate/build.sh")}")"
fi
# Generate inside the image so installation needs no host Node or Python.
seed="$(docker run --rm --network none --entrypoint node "$image" -e 'process.stdout.write(require("node:crypto").randomBytes(38).toString("hex"))')"
[[ "$seed" =~ ^[a-f0-9]{76}$ ]]
password="${seed:0:64}"
instance="paseo-${seed:64:12}"
umask 077
mkdir "$deployment"
mkdir -p "$deployment/data/home" "$deployment/workspace"
cp "$source_dir/compose.yaml" "$source_dir/common.sh" "$source_dir/connect.sh" "$source_dir/update.sh" "$deployment/"
cp "$source_dir/share-folder.sh" "$source_dir/shared-folders.mjs" "$deployment/"
cp "$source_dir/compose.gate.yaml" "$source_dir/gate.sh" "$deployment/"
chmod 700 "$deployment/"*.sh
cat > "$deployment/.env" <<ENV
PASEO_IMAGE=$image
PASEO_INSTANCE=$instance
PASEO_PASSWORD=$password
PASEO_DATA_ROOT=./data
PASEO_WORKSPACE_ROOT=./workspace
ENV
printf '%s\n' 1 > "$deployment/.container-installation"
if [[ "$network_mode" == gate ]]; then
  gate_settings=(
    "PASEO_GATE_IMAGE=$gate_image"
    "PASEO_PUBLIC_HOSTNAME=$public_hostname"
    "PASEO_CORS_ORIGINS=$cors_origins"
    "PASEO_PROJECTS_FOLDER=$projects_folder"
    "PASEO_GATE_RELAY_PORT=$relay_port"
    "PASEO_GATE_SUBNET=$gate_subnet"
    "PASEO_GATE_ADDRESS=$gate_address"
    "PASEO_INSTALLATION_PENDING=$installation_pending"
  )
  # Linux bind mounts keep host ownership; the gate writes its log as the owner.
  if [[ "$(uname -s)" == Linux ]]; then gate_settings+=("PASEO_GATE_USER=$(id -u):$(id -g)"); fi
  paseo_env_set "$deployment/.env" "${gate_settings[@]}"
  mkdir -p "$deployment/gate/logs"
  paseo_gate_config "$instance" "$gate_subnet" "$gate_routes" > "$deployment/gate/config.json"
  printf '%s\n' 1 > "$deployment/.gate-mode"
  paseo_compose config --quiet
  paseo_compose up -d --pull never paseo gate
  printf 'Installation created at %s in gate mode. Keep the password in .env private.\n' "$deployment"
  printf 'Dev listens on 127.0.0.1:%s through the gate; its Host installation owns the public address.\n' "$relay_port"
  paseo_wait
  exit 0
fi
if [[ -n "$projects_folder" ]]; then
  paseo_projects_folder_compose "$projects_folder" > "$deployment/projects-folder.compose.json"
fi
if [[ -n "${PASEO_HOST_LOOPBACK_PORT:-}" ]]; then
  paseo_host_loopback_compose "$PASEO_HOST_LOOPBACK_PORT" > "$deployment/host-loopback.compose.json"
fi
paseo_compose config --quiet
paseo_compose up -d --pull never paseo
printf 'Installation created at %s\nKeep the password in .env private. Complete the Tailscale login below.\n' "$deployment"
if [[ -n "$projects_folder" ]]; then
  printf 'New projects go in %s, which the container sees at the same path.\n' "$projects_folder"
else
  printf 'To share an existing host project folder, run %s/share-folder.sh /absolute/path/to/folder, then review and apply the staged change.\n' "$deployment"
fi
"$deployment/connect.sh"
