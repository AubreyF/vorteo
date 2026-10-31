#!/usr/bin/env bash
# Puts a `docker` on PATH ahead of the real one that records each call and
# fails, so a Host-only install that uses Docker at all is caught.
# Usage: docker-shim.sh <log file>; adds the shim directory to GITHUB_PATH.
set -euo pipefail
log="${1:?Supply the call log path}"
shim="$(dirname "$log")/docker-shim"
mkdir -p "$shim"
: > "$log"
cat > "$shim/docker" <<SHIM
#!/usr/bin/env bash
printf 'docker %s\n' "\$*" >> '$log'
echo 'Host-only installs must not use Docker.' >&2
exit 127
SHIM
chmod 755 "$shim/docker"
echo "$shim" >> "$GITHUB_PATH"
