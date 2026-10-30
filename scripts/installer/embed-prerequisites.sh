#!/usr/bin/env bash
# Copies scripts/installer/prerequisites.sh into install.sh between its
# "# BEGIN prerequisites.sh" and "# END prerequisites.sh" marker lines. install.sh runs
# alone through curl | bash, so it carries its own copy; install-sh.test.mjs fails when
# the copy differs from the file. Run from anywhere:
#
#   bash scripts/installer/embed-prerequisites.sh
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
library="$here/prerequisites.sh"
target="$here/../../install.sh"

if [ "$(grep -c '^# BEGIN prerequisites\.sh' "$target")" -ne 1 ] ||
  [ "$(grep -c '^# END prerequisites\.sh$' "$target")" -ne 1 ]; then
  echo "install.sh must have exactly one BEGIN and one END prerequisites.sh marker line." >&2
  exit 1
fi

# Keeps both marker lines and replaces everything between them with the library.
updated=$(mktemp "${TMPDIR:-/tmp}/install.sh.XXXXXX")
trap 'rm -f "$updated"' EXIT
awk -v library="$library" '
  /^# BEGIN prerequisites\.sh/ {
    print
    while ((getline line < library) > 0) print line
    inside = 1
    next
  }
  /^# END prerequisites\.sh$/ { inside = 0 }
  !inside { print }
' "$target" >"$updated"
# Writing through the existing file keeps its mode.
cat "$updated" >"$target"
echo "Copied prerequisites.sh into install.sh."
