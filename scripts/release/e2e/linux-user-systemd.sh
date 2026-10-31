#!/usr/bin/env bash
# Gives the CI runner user a running systemd user manager, as a Linux Host has
# after login, so install.sh can register real systemd user services.
#
# Lingering starts user@<uid>.service without a login session. Steps after this
# one inherit XDG_RUNTIME_DIR and DBUS_SESSION_BUS_ADDRESS through GITHUB_ENV.
#
# Fallback: when the runner image has no working user manager, this exports
# VORTEO_E2E_SERVICE_FALLBACK=1. The test then asks the installer for plain
# supervised processes (VORTEO_SERVICE_MANAGER=process), skips the service
# registration checks, and says so in a warning and the job summary. The rest
# of the assertions still run. A release built this way did not exercise the
# systemd adapter.
set -euo pipefail
uid="$(id -u)"
runtime="/run/user/$uid"
sudo loginctl enable-linger "$USER"
for _ in $(seq 1 30); do
  [[ -S "$runtime/bus" ]] && break
  sleep 1
done
state="$(XDG_RUNTIME_DIR="$runtime" DBUS_SESSION_BUS_ADDRESS="unix:path=$runtime/bus" \
  timeout 60 systemctl --user is-system-running --wait 2>/dev/null || true)"
if [[ "$state" == running || "$state" == degraded ]]; then
  {
    echo "XDG_RUNTIME_DIR=$runtime"
    echo "DBUS_SESSION_BUS_ADDRESS=unix:path=$runtime/bus"
  } >> "$GITHUB_ENV"
  echo "User systemd is $state for $USER."
  exit 0
fi
echo "VORTEO_E2E_SERVICE_FALLBACK=1" >> "$GITHUB_ENV"
message="User systemd is unavailable on this runner (state: ${state:-none}). The install test used the process fallback, so the systemd adapter was not exercised."
echo "::warning::$message"
echo "$message" >> "$GITHUB_STEP_SUMMARY"
