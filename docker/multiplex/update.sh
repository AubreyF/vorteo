#!/usr/bin/env bash
set -euo pipefail
deployment="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$deployment/common.sh"
if [[ $# -lt 1 || $# -gt 2 || ! -f "$deployment/.container-installation" ]]; then
  echo 'Usage: update.sh IMAGE [GATE_IMAGE] (from an installed deployment). For legacy instances, see docs/docker.md.' >&2
  exit 1
fi
if [[ $# == 2 ]] && ! paseo_gate_mode; then
  echo 'Only a gate-mode deployment takes a gate image.' >&2
  exit 1
fi
image="$(paseo_image "$1")"
settings=("PASEO_IMAGE=$image")
if paseo_gate_mode; then
  paseo_gate_capable "$image"
  if [[ $# == 2 ]]; then settings+=("PASEO_GATE_IMAGE=$(paseo_gate_image "$2")"); fi
fi
# Preserve the previous image and all credentials for rollback.
cp -p "$deployment/.env" "$deployment/.env.previous"
umask 077
paseo_env_set "$deployment/.env" "${settings[@]}"
echo 'Replacing this instance. Active tasks will be interrupted; persistent state is retained.'
# Dev has no network without the gate, so in gate mode both are recreated together.
services=(paseo)
if paseo_gate_mode; then services+=(gate); fi
up() {
  if paseo_gate_mode; then
    paseo_compose up -d --pull never "${services[@]}"
  else
    paseo_compose up -d --no-deps --pull never paseo
  fi
}
if up && paseo_wait; then
  exit 0
fi
# The new image did not become healthy: recreate Dev on the previous image.
echo 'The new image is not healthy. Restoring the previous image.' >&2
cp -p "$deployment/.env.previous" "$deployment/.env"
if up && paseo_wait; then
  echo 'Dev runs the previous image again.' >&2
  exit 3
fi
echo 'The previous image did not become healthy either. Inspect docker compose logs in this deployment.' >&2
exit 1
