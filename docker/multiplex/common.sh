#!/usr/bin/env bash
# Sourced by the installer and deployed lifecycle commands.
set -euo pipefail

paseo_compose() {
  local files=(-f "$deployment/compose.yaml")
  if [[ -f "$deployment/projects-folder.compose.json" ]]; then
    files+=(-f "$deployment/projects-folder.compose.json")
  fi
  if [[ -f "$deployment/host-loopback.compose.json" ]]; then
    files+=(-f "$deployment/host-loopback.compose.json")
  fi
  if [[ -f "$deployment/shared-folders.compose.json" ]]; then
    files+=(-f "$deployment/shared-folders.compose.json")
  fi
  docker compose --project-directory "$deployment" --env-file "$deployment/.env" "${files[@]}" "$@"
}

# Mounts the Projects folder at its own absolute path, so the Host and the container
# name every project the same way. See docs/execution-installation.md#projects-folder.
paseo_projects_folder_compose() {
  local folder="$1"
  if [[ ! "$folder" =~ ^/[A-Za-z0-9._/@+-]+$ || "$folder" == */ || "$folder" == *//* ]]; then
    echo 'Use an absolute Projects folder path with letters, digits and ._@+- only.' >&2
    return 1
  fi
  if [[ ! -d "$folder" ]]; then
    echo "The Projects folder $folder does not exist." >&2
    return 1
  fi
  printf '{\n  "services": {\n    "paseo": {\n      "environment": { "PASEO_PROJECTS_ROOT": "%s" },\n      "volumes": [\n        { "type": "bind", "source": "%s", "target": "%s", "bind": { "create_host_path": false } }\n      ]\n    }\n  }\n}\n' "$folder" "$folder" "$folder"
}

# Publishes the daemon on host loopback only, for the macOS Host extension's container
# endpoint. See docs/execution-installation.md#setup-on-the-host.
paseo_host_loopback_compose() {
  local port="$1"
  if [[ ! "$port" =~ ^[1-9][0-9]{3,4}$ ]] || (( port < 1024 || port > 65535 )); then
    echo 'Use an unprivileged host loopback port between 1024 and 65535.' >&2
    return 1
  fi
  printf '{\n  "services": {\n    "paseo": {\n      "environment": { "PASEO_LISTEN": "0.0.0.0:6767" },\n      "ports": [\n        { "host_ip": "127.0.0.1", "published": "%s", "target": 6767, "protocol": "tcp" }\n      ]\n    }\n  }\n}\n' "$port"
}

paseo_image() {
  local requested="$1"
  if [[ ! "$requested" =~ ^[a-zA-Z0-9][a-zA-Z0-9._/@:-]*$ ]]; then
    echo 'Supply a Docker image tag, digest, or local image ID.' >&2
    return 1
  fi
  if ! docker image inspect "$requested" >/dev/null 2>&1; then
    docker pull "$requested" >&2
  fi
  local contract
  contract="$(docker image inspect --format '{{index .Config.Labels "sh.paseo.container-contract"}}' "$requested")"
  if [[ "$contract" != tailscale-v1 ]]; then
    echo 'This image predates integrated Tailscale. Use a newly built multiplex image; see docs/docker.md.' >&2
    return 1
  fi
  docker image inspect --format '{{if .RepoDigests}}{{index .RepoDigests 0}}{{else}}{{.Id}}{{end}}' "$requested"
}

paseo_wait() {
  local container health attempt
  container="$(paseo_compose ps -q paseo)"
  if [[ -z "$container" ]]; then
    echo 'The Vorteo container is not running. Inspect docker compose logs in this deployment.' >&2
    return 1
  fi
  for attempt in $(seq 1 60); do
    health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container")"
    if [[ "$health" == healthy ]]; then
      paseo_compose exec -T --user root paseo python3 -I /opt/personal-tailscale/network.py --url
      return 0
    fi
    if [[ "$health" == exited || "$health" == dead ]]; then break; fi
    sleep 2
  done
  echo 'Vorteo is not ready. Inspect docker compose logs; HTTPS may need tailnet approval. No automatic restart was attempted.' >&2
  return 1
}
