#!/usr/bin/env bash
# Sourced by the installer and deployed lifecycle commands.
set -euo pipefail

# A deployment in gate mode has a .gate-mode marker. Its compose.gate.yaml binds the
# Projects folder and publishes the gate relay itself, so the Tailscale-mode overlays
# for those do not apply.
paseo_gate_mode() {
  [[ -f "$deployment/.gate-mode" ]]
}

paseo_compose() {
  local files
  if paseo_gate_mode; then
    files=(-f "$deployment/compose.gate.yaml")
  else
    files=(-f "$deployment/compose.yaml")
    if [[ -f "$deployment/projects-folder.compose.json" ]]; then
      files+=(-f "$deployment/projects-folder.compose.json")
    fi
    if [[ -f "$deployment/host-loopback.compose.json" ]]; then
      files+=(-f "$deployment/host-loopback.compose.json")
    fi
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
      # In gate mode the Host edge owns the public address; there is no node to ask.
      if ! paseo_gate_mode; then
        paseo_compose exec -T --user root paseo python3 -I /opt/personal-tailscale/network.py --url
      fi
      return 0
    fi
    if [[ "$health" == exited || "$health" == dead ]]; then break; fi
    sleep 2
  done
  echo 'Vorteo is not ready. Inspect docker compose logs; HTTPS may need tailnet approval. No automatic restart was attempted.' >&2
  return 1
}

# Gate mode settings. Each value is validated before it reaches .env or gate/config.json.
paseo_gate_hostname() {
  if [[ ! "$1" =~ ^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$ ]]; then
    echo 'Use a lowercase DNS name for PASEO_PUBLIC_HOSTNAME.' >&2
    return 1
  fi
}

paseo_gate_origins() {
  local origin
  local IFS=,
  for origin in $1; do
    if [[ ! "$origin" =~ ^https?://[a-z0-9.-]+(:[1-9][0-9]{0,4})?$ ]]; then
      echo "PASEO_CORS_ORIGINS has an invalid origin: $origin" >&2
      return 1
    fi
  done
}

# Prints the gate's address, .2 of a private /24 inside 172.16.0.0/12.
paseo_gate_address() {
  if [[ ! "$1" =~ ^172\.(1[6-9]|2[0-9]|3[01])\.([0-9]{1,3})\.0/24$ ]] || (( BASH_REMATCH[2] > 255 )); then
    echo 'Use a /24 subnet inside 172.16.0.0/12 for PASEO_GATE_SUBNET, such as 172.31.250.0/24.' >&2
    return 1
  fi
  printf '%s.2\n' "${1%.0/24}"
}

paseo_gate_port() {
  if [[ ! "$1" =~ ^[1-9][0-9]{3,4}$ ]] || (( $1 < 1024 || $1 > 65535 )); then
    echo 'Use an unprivileged gate relay port between 1024 and 65535.' >&2
    return 1
  fi
}

# Routes are exact host:port exceptions to the gate's refused ranges.
paseo_gate_routes() {
  local route
  local IFS=,
  for route in $1; do
    if [[ ! "$route" =~ ^[a-z0-9.-]+:[1-9][0-9]{0,4}$ ]]; then
      echo "PASEO_GATE_ROUTES has an invalid host:port route: $route" >&2
      return 1
    fi
  done
}

# Prints gate/config.json: one Dev environment, its daemon relay and the routes.
paseo_gate_config() {
  local instance="$1" subnet="$2" routes="$3" route separator=""
  if [[ ! "$instance" =~ ^[a-z0-9][a-z0-9_-]{0,62}$ ]]; then
    echo 'The instance name is not a Compose project name.' >&2
    return 1
  fi
  paseo_gate_address "$subnet" >/dev/null
  paseo_gate_routes "$routes"
  printf '{\n  "log": "/var/log/gate/connections.jsonl",\n  "proxy": ":3128",\n  "policy": "standard",\n'
  printf '  "environments": [\n    { "name": "dev", "generation": "%s", "subnet": "%s" }\n  ],\n' "$instance" "$subnet"
  printf '  "relays": [\n    { "listen": ":6768", "target": "paseo:6767", "environment": "dev" }\n  ],\n'
  printf '  "routes": ['
  local IFS=,
  for route in $routes; do
    printf '%s"%s"' "$separator" "$route"
    separator=', '
  done
  printf ']\n}\n'
}

# Replaces KEY=value lines in an env file, keeping every other line and mode 600.
paseo_env_set() {
  local file="$1" next assignment pattern=""
  shift
  for assignment in "$@"; do
    if [[ ! "$assignment" =~ ^[A-Z][A-Z0-9_]*= || "$assignment" == *$'\n'* ]]; then
      echo "Invalid setting for ${assignment%%=*}." >&2
      return 1
    fi
    pattern+="${pattern:+|}${assignment%%=*}"
  done
  next="$(mktemp "$file.XXXXXX")"
  { grep -Ev "^($pattern)=" "$file" || true; printf '%s\n' "$@"; } > "$next"
  chmod 600 "$next"
  mv "$next" "$file"
}

paseo_gate_image() {
  local requested="$1"
  if [[ ! "$requested" =~ ^[a-zA-Z0-9][a-zA-Z0-9._/@:-]*$ ]]; then
    echo 'Supply a gate image tag, digest, or local image ID.' >&2
    return 1
  fi
  if [[ "$(docker image inspect --format '{{index .Config.Labels "sh.paseo.gate-contract"}}' "$requested")" != v1 ]]; then
    echo 'This is not a gate image. Build one with docker/gate/build.sh.' >&2
    return 1
  fi
  docker image inspect --format '{{if .RepoDigests}}{{index .RepoDigests 0}}{{else}}{{.Id}}{{end}}' "$requested"
}

# A Dev image runs in gate mode only if it has the SSH tunnel helper the gate needs.
paseo_gate_capable() {
  if ! docker run --rm --network none --entrypoint test "$1" -x /usr/local/bin/gate-connect >/dev/null; then
    echo 'This Dev image predates gate mode. Build a new one from docker/base/Dockerfile.' >&2
    return 1
  fi
}
