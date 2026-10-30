#!/usr/bin/env bash
# Builds the gate image and prints its image ID. Needs only Docker.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
receipt="$(mktemp)"
trap 'rm -f "$receipt"' EXIT
docker build --quiet --label sh.paseo.gate-contract=v1 --iidfile "$receipt" . >/dev/null
cat "$receipt"
