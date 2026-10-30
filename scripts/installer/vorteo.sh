#!/usr/bin/env bash
# The `vorteo` command. install.sh puts a small shim in ~/.local/bin/vorteo that runs this
# file from the installed release, so an in-app update also updates the command. Every
# subcommand forwards to the installer engine (scripts/installer/main.mjs).
#
#   vorteo status [--json]        Show the installation's state.
#   vorteo doctor                 Check prerequisites and services, with a fix for each problem.
#   vorteo open                   Open the interface in the browser.
#   vorteo update                 Updates happen in the interface: opens Settings, Maintenance.
#   vorteo repair                 Repair the installation in place.
#   vorteo uninstall [--keep-data] [--yes]
#                                 Remove the installation; --keep-data keeps its state.
#
# The shim sets VORTEO_ROOT (default ~/vorteo) and VORTEO_NODE (the Node.js the installer
# used). The whole file is one function called on the last line.
# shellcheck disable=SC2016 # The node -e programs are single-quoted on purpose.

vorteo_command() {
  local root="${VORTEO_ROOT:-$HOME/vorteo}"
  local node_bin="${VORTEO_NODE:-node}"
  local installer="${VORTEO_SOURCE:-$root/source}/scripts/installer"
  local install_address="https://terranlabs.com/vorteo/install"

  engine() {
    local command="$1"
    shift
    "$node_bin" "$installer/main.mjs" "$command" --root "$root" "$@" </dev/null
  }
  # Prints the interface address from the engine's status: the Tailscale origin when there
  # is one, otherwise the local one.
  address() {
    engine status --json | "$node_bin" -e '
      let text = "";
      process.stdin.on("data", (chunk) => (text += chunk));
      process.stdin.on("end", () => {
        const status = JSON.parse(text);
        const result = status.result || {};
        const origin = status.origin || result.origin || status.localOrigin || result.localOrigin;
        if (!origin) process.exit(1);
        process.stdout.write(origin);
      });
    '
  }
  open_url() {
    if [ "$(uname -s)" = Darwin ] && command -v open >/dev/null 2>&1; then
      open "$1"
    elif command -v xdg-open >/dev/null 2>&1 && { [ -n "${DISPLAY-}" ] || [ -n "${WAYLAND_DISPLAY-}" ]; }; then
      xdg-open "$1" >/dev/null 2>&1
    else
      echo "Open $1 in your browser."
      return 0
    fi
    echo "Opened $1"
  }
  usage() {
    echo "Usage: vorteo <status|doctor|open|update|repair|uninstall> [options]"
    echo ""
    echo "  status [--json]                Show the installation's state"
    echo "  doctor                         Check prerequisites and services"
    echo "  open                           Open the interface"
    echo "  update                         Open Settings, Maintenance, where updates happen"
    echo "  repair                         Repair the installation"
    echo "  uninstall [--keep-data] [--yes] Remove the installation"
  }

  if [ ! -f "$installer/main.mjs" ]; then
    echo "Vorteo is not installed in $root. Install it with: curl -fsSL $install_address | bash" >&2
    return 1
  fi

  local command="${1-}"
  if [ "$#" -gt 0 ]; then shift; fi
  case "$command" in
    status) engine status "$@" ;;
    doctor)
      local doctor_status=0
      engine detect --json | "$node_bin" -e '
        let text = "";
        process.stdin.on("data", (chunk) => (text += chunk));
        process.stdin.on("end", () => {
          const report = JSON.parse(text);
          let problems = 0;
          for (const [name, check] of Object.entries(report.prerequisites || {})) {
            const ready = check.ok && check.running !== false && check.loggedIn !== false;
            console.log(`  ${ready ? "✓" : "✗"} ${name}${check.version ? ` ${check.version}` : ""}`);
            if (!ready && check.fix) console.log(`    Fix: ${check.fix}`);
            if (!ready) problems++;
          }
          const kind = report.existing && report.existing.kind;
          console.log(`  ${kind === "current" ? "✓" : "✗"} installation: ${kind || "unknown"}`);
          if (kind !== "current") problems++;
          process.exit(problems ? 1 : 0);
        });
      ' || doctor_status=1
      echo ""
      engine status || doctor_status=1
      if [ "$doctor_status" -ne 0 ]; then
        echo ""
        echo "Fix the items marked ✗. vorteo repair fixes services and files the installer owns."
      fi
      return "$doctor_status"
      ;;
    open)
      local url
      url=$(address) || {
        echo "Could not read the interface address. Run: vorteo doctor" >&2
        return 1
      }
      open_url "$url"
      ;;
    update)
      echo "Vorteo updates happen in the interface: Settings, Maintenance, Vorteo updates."
      echo "An approved update upgrades the coordinator, the Host and the Dev container together."
      local url
      url=$(address) || {
        echo "Could not read the interface address. Run: vorteo doctor" >&2
        return 1
      }
      open_url "${url%/}/settings/maintenance"
      ;;
    repair)
      engine repair "$@" | "$node_bin" "$installer/progress.mjs" --no-result
      local statuses=("${PIPESTATUS[@]}")
      if [ "${statuses[0]}" -ne 0 ] || [ "${statuses[1]}" -ne 0 ]; then
        echo ""
        echo "The repair did not finish. Fix the problem above, then run vorteo repair again."
        return 1
      fi
      ;;
    uninstall)
      local confirmed="" keep_data="" arg
      local forward=()
      for arg in "$@"; do
        case "$arg" in
          --yes | -y) confirmed=1 ;;
          --keep-data)
            keep_data=1
            forward+=("$arg")
            ;;
          *) forward+=("$arg") ;;
        esac
      done
      if [ -z "$confirmed" ]; then
        if [ -z "$keep_data" ]; then
          echo "This removes Vorteo's services, its Dev container and everything in $root."
        else
          echo "This removes Vorteo's services and keeps the data in $root."
        fi
        if [ ! -t 0 ]; then
          echo "Rerun with --yes to confirm." >&2
          return 3
        fi
        local reply=""
        printf 'Type uninstall to confirm: '
        IFS= read -r reply || return 1
        if [ "$reply" != uninstall ]; then
          echo "Nothing was removed."
          return 4
        fi
      fi
      engine uninstall ${forward[@]+"${forward[@]}"} || return 1
      # Remove the shim once the release it forwards to is gone.
      local shim="$HOME/.local/bin/vorteo"
      if [ ! -f "$installer/vorteo.sh" ] && grep -q "vorteo-command-shim" "$shim" 2>/dev/null; then
        rm -f "$shim"
      fi
      echo "Vorteo was uninstalled."
      ;;
    "" | help | -h | --help) usage ;;
    *)
      echo "Unknown command: $command" >&2
      usage >&2
      return 2
      ;;
  esac
}

vorteo_command "$@"
