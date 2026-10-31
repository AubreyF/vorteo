# shellcheck shell=bash
# Prerequisite installs for the Vorteo installer (install.sh).
#
# Source this file, then call:
#
#   vorteo_ensure_prerequisites [--interactive] [--skip] <tool>...
#
# Tools: node (Node.js 24 or newer), git, docker (needed for a Dev container) and tailscale
# (needed for remote access). For each tool that is missing or too old it explains what is
# needed, asks once, installs it with the official method and checks that it works. Every
# question is asked before anything is installed.
#
#   --interactive  Prompt on file descriptor 3, which install.sh opens on /dev/tty. Without
#                  it, unanswered questions are printed in the agent block below and the
#                  function exits with status 3.
#   --skip         Install nothing: report each missing tool with its manual fix
#                  (install.sh --skip-prerequisites, or VORTEO_SKIP_PREREQUISITES=1).
#
# Questions, each answered yes or no (default yes):
#   install-node       Install or upgrade Node.js 24 (Homebrew on macOS when present, else nvm).
#   install-git        Install Git (Command Line Tools on macOS, the package manager on Linux).
#   install-docker     Install Docker (Docker Desktop on macOS, Docker Engine on Linux).
#   start-docker       Linux only: start the Docker service and add the user to the docker group.
#   install-tailscale  Install Tailscale (the Mac app, or Tailscale's Linux install script).
# An answer comes from the shell variable install.sh sets for --<id>=<answer>
# (answer_install_git and so on), else the environment variable VORTEO_<ID>
# (VORTEO_INSTALL_GIT and so on), else the terminal with --interactive. --yes never answers
# them: installing system software always needs an explicit yes. Without an answer the
# function prints, on standard output, and exits 3:
#
#   VORTEO_QUESTIONS_BEGIN
#   VORTEO_QUESTION <id> yes <question text>
#   VORTEO_QUESTIONS_END
#
# A question whose install uses sudo says so in its text, because the owner must type the
# administrator password. Without a terminal sudo cannot ask, so the install stops and names
# the commands to run in a terminal.
#
# Returns 0 when every tool is ready, 1 when one is not (the output names the fix) and 2 for
# a bad tool name or answer. When node was asked for and is ready, VORTEO_NODE_BIN names it
# and its folder is on PATH.
#
# A downloaded install script is always saved to a temporary file, and its address printed,
# before it runs. Temporary files go under VORTEO_INSTALL_WORK when it is set (install.sh
# removes that folder on exit). On Linux, when the owner was just added to the docker group,
# a docker command that runs through `sg docker` is put first on PATH for the rest of the
# install, because the group only applies to new logins.
#
# Tests only: VORTEO_PREREQ_APPLICATIONS replaces /Applications, VORTEO_PREREQ_POLL_SECONDS
# sets the wait between checks (5) and VORTEO_PREREQ_WAIT_SECONDS the longest wait for a
# dialog or app (1800 with a terminal, 300 without).
#
# The file only defines functions, so it can be sourced or pasted into install.sh. It runs
# on bash 3.2 (the macOS /bin/bash).

vorteo_ensure_prerequisites() {
  local vp_interactive="" vp_skip="" vp_platform="" vp_tools="" vp_missing="" vp_pending=""
  local vp_failed=0 vp_work="" vp_is_root="" vp_user="" vp_package_manager="" vp_state=""
  local vp_found="" vp_question="" vp_script="" vp_root_checked=""
  local vp_bold="" vp_dim="" vp_red="" vp_green="" vp_reset=""
  local vp_minimum_node=24 vp_nvm_version="v0.40.3"
  local vp_docker_desktop_download="https://docs.docker.com/desktop/setup/install/mac-install/"
  local vp_tailscale_download="https://tailscale.com/download/mac"
  local vp_apps="${VORTEO_PREREQ_APPLICATIONS:-/Applications}"
  local vp_poll="${VORTEO_PREREQ_POLL_SECONDS:-5}" vp_wait="${VORTEO_PREREQ_WAIT_SECONDS-}"
  local vp_arg vp_tool

  for vp_arg in "$@"; do
    case "$vp_arg" in
      --interactive) vp_interactive=1 ;;
      --skip) vp_skip=1 ;;
      node | git | docker | tailscale)
        case " $vp_tools " in
          *" $vp_arg "*) ;;
          *) vp_tools="$vp_tools $vp_arg" ;;
        esac
        ;;
      *)
        printf 'vorteo_ensure_prerequisites: unknown argument %s\n' "$vp_arg" >&2
        return 2
        ;;
    esac
  done
  if [ -t 1 ] && [ "${TERM-}" != "dumb" ] && [ -z "${NO_COLOR-}" ]; then
    vp_bold=$'\033[1m' vp_dim=$'\033[2m' vp_red=$'\033[31m' vp_green=$'\033[32m' vp_reset=$'\033[0m'
  fi
  if [ -n "${VORTEO_SKIP_PREREQUISITES-}" ] && [ "$VORTEO_SKIP_PREREQUISITES" != 0 ]; then vp_skip=1; fi
  if [ -z "$vp_wait" ]; then
    if [ -n "$vp_interactive" ]; then vp_wait=1800; else vp_wait=300; fi
  fi

  vp_platform=$(vp_detect_platform) || {
    vp_problem "Vorteo installs on macOS and Linux only; this is $(uname -s)."
    return 1
  }
  if [ "$(id -u 2>/dev/null)" = 0 ]; then vp_is_root=1; fi
  vp_user=$(id -un 2>/dev/null || printf '%s' "${USER-}")
  vp_package_manager=$(vp_detect_package_manager)

  # Order matters only for the output: git first, because Homebrew and nvm may want it.
  for vp_tool in git node docker tailscale; do
    case " $vp_tools " in *" $vp_tool "*) ;; *) continue ;; esac
    if ! "vp_check_$vp_tool"; then vp_missing="$vp_missing $vp_tool"; fi
  done
  if [ -z "$vp_missing" ]; then return 0; fi

  if [ -n "$vp_skip" ]; then
    for vp_tool in $vp_missing; do
      "vp_check_$vp_tool" || true
      vp_problem "$(vp_label "$vp_tool") ($vp_found)"
      vp_fix "$(vp_manual_fix "$vp_tool")"
    done
    vp_say "  Prerequisite installs are skipped (--skip-prerequisites)."
    return 1
  fi

  vp_heading "Prerequisites"
  for vp_tool in $vp_missing; do
    "vp_check_$vp_tool" || true
    vp_question=$(vp_question_id "$vp_tool")
    vp_problem "$(vp_label "$vp_tool") ($vp_found)"
    "vp_explain_$vp_tool"
    if [ -n "$vp_question" ]; then
      vp_ask "$vp_question" "$(vp_question_text "$vp_tool")" || return 2
    fi
  done
  vp_flush_questions

  vp_work=$(vp_make_work) || {
    vp_problem "Could not create a temporary folder."
    return 1
  }
  for vp_tool in $vp_missing; do
    "vp_check_$vp_tool" || true
    vp_question=$(vp_question_id "$vp_tool")
    if [ -n "$vp_question" ] && [ "$(vp_get_answer "$vp_question")" != yes ]; then
      vp_problem "$(vp_label "$vp_tool") is required and was not installed."
      vp_fix "$(vp_manual_fix "$vp_tool")"
      vp_failed=1
      continue
    fi
    if "vp_install_$vp_tool" && "vp_check_$vp_tool"; then
      vp_ok "$(vp_label "$vp_tool") is ready"
    else
      vp_problem "$(vp_label "$vp_tool") is still not ready ($vp_found)."
      vp_fix "$(vp_manual_fix "$vp_tool")"
      vp_failed=1
    fi
  done
  hash -r
  return "$vp_failed"
}

# vorteo_prerequisite_fix <tool>: prints the manual fix for a tool on this machine, for
# callers that report a missing tool themselves.
vorteo_prerequisite_fix() {
  local vp_platform vp_package_manager vp_is_root="" vp_user vp_minimum_node=24
  local vp_nvm_version="v0.40.3" vp_state=missing
  local vp_docker_desktop_download="https://docs.docker.com/desktop/setup/install/mac-install/"
  local vp_tailscale_download="https://tailscale.com/download/mac"
  vp_platform=$(vp_detect_platform) || return 1
  if [ "$(id -u 2>/dev/null)" = 0 ]; then vp_is_root=1; fi
  vp_user=$(id -un 2>/dev/null || printf '%s' "${USER-}")
  vp_package_manager=$(vp_detect_package_manager)
  vp_manual_fix "$1"
}

# Output, styled like install.sh -------------------------------------------------------

vp_say() { printf '%s\n' "$*"; }
vp_heading() { printf '\n%s%s%s\n' "${vp_bold-}" "$*" "${vp_reset-}"; }
vp_ok() { printf '  %s✓%s %s\n' "${vp_green-}" "${vp_reset-}" "$*"; }
vp_working() { printf '  %s…%s %s\n' "${vp_dim-}" "${vp_reset-}" "$*"; }
vp_problem() { printf '  %s✗%s %s\n' "${vp_red-}" "${vp_reset-}" "$*"; }
vp_fix() { printf '    %sFix:%s %s\n' "${vp_bold-}" "${vp_reset-}" "$*"; }
vp_note() { printf '    %s\n' "$*"; }

# Machine ------------------------------------------------------------------------------

vp_detect_platform() {
  case "$(uname -s 2>/dev/null)" in
    Darwin) printf 'macos' ;;
    Linux) printf 'linux' ;;
    *) return 1 ;;
  esac
}
vp_detect_package_manager() {
  local manager
  for manager in apt-get dnf yum pacman zypper apk; do
    if command -v "$manager" >/dev/null 2>&1; then
      printf '%s' "$manager"
      return 0
    fi
  done
}
vp_has_brew() { [ "$vp_platform" = macos ] && command -v brew >/dev/null 2>&1; }
vp_label() {
  case "$1" in
    node) printf 'Node.js %s' "$vp_minimum_node" ;;
    git) printf 'Git' ;;
    docker) printf 'Docker' ;;
    tailscale) printf 'Tailscale' ;;
  esac
}
# Prints the command with sudo in front when this user is not root.
vp_sudo_text() {
  if [ -n "$vp_is_root" ]; then printf '%s' "$*"; else printf 'sudo %s' "$*"; fi
}
vp_sudo_sentence() {
  if [ -z "$vp_is_root" ]; then printf ' This uses sudo, which asks for your administrator password.'; fi
}

vp_make_work() {
  local parent="${VORTEO_INSTALL_WORK:-${TMPDIR:-/tmp}}"
  (umask 077 && mktemp -d "$parent/vorteo-prerequisites.XXXXXX")
}

# vp_wait_until <description> <check function>: polls until the check passes, giving up
# after vp_wait seconds. Ctrl-C stops it; install.sh's trap exits.
vp_wait_until() {
  local start="$SECONDS"
  vp_note "Waiting for $1. Press Ctrl-C to stop; rerunning the installer picks up from here."
  while ! "$2"; do
    if [ $((SECONDS - start)) -ge "$vp_wait" ]; then
      vp_note "Stopped waiting for $1 after $vp_wait seconds."
      return 1
    fi
    sleep "$vp_poll"
  done
}

# vp_fetch_script <address> <file name>: saves an install script and sets vp_script.
vp_fetch_script() {
  vp_script="$vp_work/$2"
  vp_working "Downloading $1"
  if ! curl -fsSL --retry 2 -o "$vp_script" "$1" </dev/null 3<&-; then
    vp_note "Could not download $1. Check your internet connection."
    return 1
  fi
  vp_note "Saved it to $vp_script and running it now."
}

# Runs a command as root: directly for root, otherwise through sudo.
vp_as_root() {
  if [ -n "$vp_is_root" ]; then
    "$@" </dev/null 3<&-
  else
    sudo "$@" </dev/null 3<&-
  fi
}
# Makes sure sudo can run, asking for the password once, before an install starts.
vp_root_ready() {
  if [ -n "$vp_is_root" ] || [ -n "$vp_root_checked" ]; then return 0; fi
  if ! command -v sudo >/dev/null 2>&1; then
    vp_note "This needs root, and sudo is not installed. Run the commands below as root."
    return 1
  fi
  vp_note "sudo asks for your administrator password now."
  if ! sudo -v </dev/null 3<&-; then
    vp_note "sudo did not get the password. Without a terminal it cannot ask; run the commands below in a terminal."
    return 1
  fi
  vp_root_checked=1
}
# Opens an address or app on macOS, and says what it opened.
vp_open() {
  if command -v open >/dev/null 2>&1 && open "$@" </dev/null >/dev/null 2>&1 3<&-; then
    return 0
  fi
  return 1
}

# Questions ----------------------------------------------------------------------------

vp_answer_var() { printf 'answer_%s' "$1" | tr '-' '_'; }
vp_get_answer() {
  local name
  name=$(vp_answer_var "$1")
  printf '%s' "${!name-}"
}
vp_normalize_bool() {
  case "$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')" in
    y | yes | true | 1 | on) printf 'yes' ;;
    n | no | false | 0 | off) printf 'no' ;;
    *) return 1 ;;
  esac
}
# vp_ask <id> <text>: answers from install.sh's flag, the environment, the terminal, or
# queues the question. The default is always yes.
vp_ask() {
  local id="$1" text="$2" raw value env_name typed=""
  raw=$(vp_get_answer "$id")
  if [ -z "$raw" ]; then
    env_name="VORTEO_$(printf '%s' "$id" | tr '[:lower:]-' '[:upper:]_')"
    raw="${!env_name-}"
  fi
  if [ -n "$raw" ]; then
    if ! value=$(vp_normalize_bool "$raw"); then
      printf 'Invalid value for --%s: %s (expected yes or no)\n' "$id" "$raw" >&2
      return 1
    fi
    printf -v "$(vp_answer_var "$id")" '%s' "$value"
    return 0
  fi
  if [ -z "$vp_interactive" ]; then
    vp_pending="${vp_pending}VORTEO_QUESTION $id yes $text"$'\n'
    return 0
  fi
  while :; do
    printf '%s%s%s %s[yes]%s ' "$vp_bold" "$text" "$vp_reset" "$vp_dim" "$vp_reset"
    if ! IFS= read -r typed <&3; then
      printf '\n'
      vp_problem "Input ended before the question was answered."
      exit 1
    fi
    if value=$(vp_normalize_bool "${typed:-yes}"); then
      printf -v "$(vp_answer_var "$id")" '%s' "$value"
      return 0
    fi
    vp_say "  Please answer yes or no."
  done
}
vp_flush_questions() {
  if [ -z "$vp_pending" ]; then return 0; fi
  vp_say ""
  vp_say "The installer needs answers. Ask the owner each question, then rerun with --<id>=<answer>."
  vp_say "VORTEO_QUESTIONS_BEGIN"
  printf '%s' "$vp_pending"
  vp_say "VORTEO_QUESTIONS_END"
  exit 3
}
# Prints the question id for a tool in its current state, or nothing when no question is
# needed (starting Docker Desktop that is already installed).
vp_question_id() {
  case "$1:$vp_state" in
    docker:stopped) if [ "$vp_platform" = linux ]; then printf 'start-docker'; fi ;;
    *) printf 'install-%s' "$1" ;;
  esac
}

# Node.js ------------------------------------------------------------------------------

vp_node_major() {
  local version
  version=$("$1" --version 2>/dev/null) || return 1
  version="${version#v}"
  printf '%s' "${version%%.*}"
}
vp_check_node() {
  local candidate major
  vp_found="not installed" vp_state=missing
  candidate=$(command -v node 2>/dev/null) || return 1
  vp_found="found $("$candidate" --version 2>/dev/null)" vp_state=outdated
  major=$(vp_node_major "$candidate") || return 1
  [ "$major" -ge "$vp_minimum_node" ] 2>/dev/null || return 1
  vp_state=ok
  # shellcheck disable=SC2034 # Read by install.sh after vorteo_ensure_prerequisites.
  VORTEO_NODE_BIN="$candidate"
}
vp_node_method() {
  if vp_has_brew; then
    printf 'Homebrew (brew install node@%s)' "$vp_minimum_node"
  else
    printf 'nvm %s, which also adds itself to your shell profile' "$vp_nvm_version"
  fi
}
vp_explain_node() {
  vp_note "The installer and Vorteo's services run on Node.js $vp_minimum_node."
  if ! vp_has_brew; then
    vp_note "nvm installs it in your home folder (~/.nvm) without sudo."
  fi
}
vp_install_node() {
  if vp_has_brew; then
    vp_working "Installing Node.js $vp_minimum_node with Homebrew"
    brew install "node@$vp_minimum_node" </dev/null 3<&- || return 1
    PATH="$(brew --prefix "node@$vp_minimum_node" 3<&-)/bin:$PATH"
  else
    vp_working "Installing nvm $vp_nvm_version and Node.js $vp_minimum_node"
    export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
    if [ ! -s "$NVM_DIR/nvm.sh" ]; then
      vp_fetch_script "https://raw.githubusercontent.com/nvm-sh/nvm/$vp_nvm_version/install.sh" \
        nvm-install.sh || return 1
      bash "$vp_script" </dev/null 3<&- || return 1
    fi
    # shellcheck disable=SC1091 # nvm.sh is written by the nvm installer.
    . "$NVM_DIR/nvm.sh" && nvm install "$vp_minimum_node" </dev/null 3<&- || return 1
    PATH="$(dirname "$(nvm which "$vp_minimum_node")"):$PATH"
  fi
  export PATH
  hash -r
}

# Git ----------------------------------------------------------------------------------

vp_check_git() {
  local found
  vp_found="not installed" vp_state=missing
  found=$(command -v git 2>/dev/null) || return 1
  # macOS ships /usr/bin/git as a stub that opens the install dialog when run, so ask
  # xcode-select first whether the developer tools are there.
  if [ "$vp_platform" = macos ] && [ "$found" = /usr/bin/git ] &&
    ! xcode-select -p >/dev/null 2>&1 3<&-; then
    return 1
  fi
  git --version >/dev/null 2>&1 </dev/null 3<&- || return 1
  vp_state=ok
}
# Prints the root commands that install Git, one per line.
vp_git_commands() {
  case "$vp_package_manager" in
    apt-get)
      printf 'apt-get update\n'
      printf 'env DEBIAN_FRONTEND=noninteractive apt-get install -y git\n'
      ;;
    dnf) printf 'dnf install -y git\n' ;;
    yum) printf 'yum install -y git\n' ;;
    pacman) printf 'pacman -S --needed --noconfirm git\n' ;;
    zypper) printf 'zypper --non-interactive install git\n' ;;
    apk) printf 'apk add git\n' ;;
  esac
}
# vp_git_command_text <separator>: the Git install commands as the owner would type them.
vp_git_command_text() {
  local line text=""
  while IFS= read -r line; do
    if [ -n "$text" ]; then text="$text$1"; fi
    text="$text$(vp_sudo_text "$line")"
  done <<EOF
$(vp_git_commands)
EOF
  printf '%s' "$text"
}
vp_explain_git() {
  vp_note "The installer fetches the Vorteo release with Git, and agents use it in every project."
  if [ "$vp_platform" = macos ]; then
    vp_note "Git comes with Apple's Command Line Tools. macOS shows a dialog to install them;"
    vp_note "click Install and accept the license. It takes a few minutes."
  elif [ -n "$vp_package_manager" ]; then
    vp_note "It runs: $(vp_git_command_text '; ')"
  fi
}
vp_install_git() {
  if [ "$vp_platform" = macos ]; then
    vp_working "Asking macOS to install the Command Line Tools"
    # It fails when an install is already running; the wait below covers both cases.
    xcode-select --install </dev/null >/dev/null 2>&1 3<&- || true
    vp_note "Finish the Command Line Tools dialog. If you cancelled it, press Ctrl-C and rerun."
    vp_wait_until "Git to work" vp_check_git
    return
  fi
  if [ -z "$vp_package_manager" ]; then
    vp_note "No supported package manager was found."
    return 1
  fi
  vp_root_ready || return 1
  local line
  # Each line is a fixed command from vp_git_commands, split into words on purpose.
  while IFS= read -r line; do
    vp_working "Running: $(vp_sudo_text "$line")"
    # shellcheck disable=SC2086
    vp_as_root $line || return 1
  done <<EOF
$(vp_git_commands)
EOF
  hash -r
}

# Docker -------------------------------------------------------------------------------

# Prints the docker command: the one on PATH, or Docker Desktop's own copy, which it links
# into /usr/local/bin only once it has run.
vp_docker_cli() {
  if command -v docker 2>/dev/null; then return 0; fi
  if [ "$vp_platform" = macos ] && [ -x "$vp_apps/Docker.app/Contents/Resources/bin/docker" ]; then
    printf '%s' "$vp_apps/Docker.app/Contents/Resources/bin/docker"
    return 0
  fi
  return 1
}
vp_check_docker() {
  local cli output
  vp_found="not installed" vp_state=missing
  if ! cli=$(vp_docker_cli); then
    if [ "$vp_platform" = macos ] && [ -d "$vp_apps/Docker.app" ]; then
      vp_found="installed but not running" vp_state=stopped
    fi
    return 1
  fi
  if output=$("$cli" info 2>&1 </dev/null 3<&-); then
    vp_state=ok
    # Docker Desktop's copy is not on PATH yet; put it there for the rest of the install.
    case ":$PATH:" in
      *":$(dirname "$cli"):"*) ;;
      *) PATH="$(dirname "$cli"):$PATH" && export PATH ;;
    esac
    return 0
  fi
  vp_state=stopped
  case "$output" in
    *"ermission denied"*)
      vp_found="installed, but $vp_user may not use it"
      ;;
    *) vp_found="installed but not running" ;;
  esac
  return 1
}
vp_explain_docker() {
  vp_note "The Dev container, where agents work, runs in Docker."
  if [ "$vp_platform" = macos ]; then
    if [ "$vp_state" = stopped ]; then
      vp_note "The installer opens Docker Desktop and waits until it runs."
    elif vp_has_brew; then
      vp_note "It installs Docker Desktop with: brew install --cask docker-desktop"
    else
      vp_note "Without Homebrew, the installer opens the Docker Desktop download page and waits"
      vp_note "while you install it: open the .dmg and drag Docker to Applications."
    fi
    vp_note "Docker Desktop is free for personal use, education and small businesses; larger"
    vp_note "companies need a paid Docker subscription."
  elif [ "$vp_state" = stopped ]; then
    vp_note "It runs: $(vp_sudo_text systemctl enable --now docker)$(
      if [ -z "$vp_is_root" ]; then printf '; %s' "$(vp_sudo_text usermod -aG docker "$vp_user")"; fi
    )"
  else
    vp_note "It downloads Docker's official install script from https://get.docker.com, shows"
    vp_note "where it saved it, and runs it with $(vp_sudo_text sh). Then it starts Docker$(
      if [ -z "$vp_is_root" ]; then printf ' and adds %s to the docker group' "$vp_user"; fi
    )."
  fi
}
vp_install_docker() {
  if [ "$vp_platform" = macos ]; then
    vp_install_docker_desktop
  else
    vp_install_docker_engine
  fi
}
vp_install_docker_desktop() {
  if [ "$vp_state" = missing ]; then
    if vp_has_brew; then
      vp_working "Installing Docker Desktop with Homebrew (it may ask for your administrator password)"
      brew install --cask docker-desktop </dev/null 3<&- || return 1
    else
      vp_working "Opening $vp_docker_desktop_download"
      vp_open "$vp_docker_desktop_download" || vp_note "Open $vp_docker_desktop_download in your browser."
      vp_note "Download Docker Desktop for your Mac (Apple silicon or Intel), open the .dmg and"
      vp_note "drag Docker to Applications."
      vp_wait_until "Docker Desktop in $vp_apps" vp_docker_desktop_present || return 1
    fi
  fi
  vp_working "Opening Docker Desktop"
  vp_open -a "$vp_apps/Docker.app" || true
  vp_note "Accept Docker's terms and allow its helper if it asks. The installer continues once Docker runs."
  vp_wait_until "Docker to run" vp_check_docker
}
vp_docker_desktop_present() { [ -d "$vp_apps/Docker.app" ]; }
vp_install_docker_engine() {
  vp_root_ready || return 1
  if [ "$vp_state" = missing ]; then
    vp_fetch_script "https://get.docker.com" get-docker.sh || return 1
    vp_working "Running Docker's install script: $(vp_sudo_text sh "$vp_script")"
    vp_as_root sh "$vp_script" || return 1
    rm -f "$vp_script"
    hash -r
  fi
  vp_working "Starting Docker"
  if command -v systemctl >/dev/null 2>&1 && vp_as_root systemctl enable --now docker; then
    :
  elif command -v service >/dev/null 2>&1 && vp_as_root service docker start; then
    :
  else
    vp_note "Could not start the Docker service; the check below shows whether it runs."
  fi
  if [ -z "$vp_is_root" ] && ! vp_user_in_group docker; then
    vp_working "Adding $vp_user to the docker group"
    vp_as_root usermod -aG docker "$vp_user" || return 1
  fi
  if vp_check_docker; then return 0; fi
  vp_docker_through_sg
}
vp_user_in_group() {
  case " $(id -nG "$vp_user" 2>/dev/null) " in
    *" $1 "*) return 0 ;;
  esac
  return 1
}
# The docker group applies only to new logins. When `sg docker` can reach Docker, put a
# docker command that goes through it first on PATH, so the rest of the install works now.
vp_docker_through_sg() {
  local real shim_dir
  real=$(command -v docker 2>/dev/null) || return 1
  command -v sg >/dev/null 2>&1 || return 1
  sg docker -c "$(vp_sh_quote "$real") info" </dev/null >/dev/null 2>&1 3<&- || return 1
  shim_dir="$vp_work/docker-group"
  mkdir -p "$shim_dir" || return 1
  {
    printf '#!/bin/sh\n'
    printf '# Runs docker with the docker group until the owner logs in again.\n'
    printf 'command=%s\n' "$(vp_sh_quote "$(vp_sh_quote "$real")")"
    cat <<'EOF'
for arg in "$@"; do
  command="$command '$(printf '%s' "$arg" | sed "s/'/'\\\\''/g")'"
done
exec sg docker -c "$command"
EOF
  } >"$shim_dir/docker" && chmod 755 "$shim_dir/docker" || return 1
  PATH="$shim_dir:$PATH"
  export PATH
  hash -r
  vp_note "Your login does not include the docker group yet, so the installer uses Docker through"
  vp_note "sg docker for now. Log out and back in (or reboot) before using docker yourself; in"
  vp_note "this terminal, newgrp docker works too."
  vp_state=ok
}
# Quotes a value for /bin/sh with single quotes.
vp_sh_quote() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

# Tailscale ----------------------------------------------------------------------------

vp_check_tailscale() {
  vp_found="not installed" vp_state=missing
  if command -v tailscale >/dev/null 2>&1 ||
    { [ "$vp_platform" = macos ] && [ -d "$vp_apps/Tailscale.app" ]; }; then
    vp_state=ok
    return 0
  fi
  return 1
}
vp_explain_tailscale() {
  vp_note "Remote access reaches this machine from your other devices through Tailscale."
  if [ "$vp_platform" = macos ]; then
    if vp_has_brew; then
      vp_note "It installs the Tailscale app with: brew install --cask tailscale-app"
    else
      vp_note "Without Homebrew, the installer opens the Tailscale download page and waits while"
      vp_note "you install the app."
    fi
  else
    vp_note "It downloads Tailscale's official install script from https://tailscale.com/install.sh,"
    vp_note "shows where it saved it, and runs it with $(vp_sudo_text sh)."
  fi
}
vp_install_tailscale() {
  if [ "$vp_platform" = macos ]; then
    if vp_has_brew; then
      vp_working "Installing Tailscale with Homebrew (it may ask for your administrator password)"
      brew install --cask tailscale-app </dev/null 3<&- || return 1
    else
      vp_working "Opening $vp_tailscale_download"
      vp_open "$vp_tailscale_download" || vp_note "Open $vp_tailscale_download in your browser."
      vp_wait_until "Tailscale in $vp_apps" vp_check_tailscale || return 1
    fi
    vp_open -a "$vp_apps/Tailscale.app" || true
    vp_note "Tailscale is opening. Allow its VPN configuration when macOS asks, then sign in."
    vp_tailscale_sign_in_note
    return 0
  fi
  vp_root_ready || return 1
  vp_fetch_script "https://tailscale.com/install.sh" tailscale-install.sh || return 1
  vp_working "Running Tailscale's install script: $(vp_sudo_text sh "$vp_script")"
  vp_as_root sh "$vp_script" || return 1
  rm -f "$vp_script"
  hash -r
  command -v tailscale >/dev/null 2>&1 || return 1
  vp_tailscale_linux_up
}
vp_tailscale_key_file() {
  local file="${answer_tailscale_auth_key_file:-${VORTEO_TAILSCALE_AUTH_KEY_FILE-}}"
  if [ "$file" != none ]; then printf '%s' "$file"; fi
}
# On Linux, signs in with the owner's auth key file when there is one. The key is read by
# tailscale from the file, so it never appears in a process list. --operator lets this
# user run tailscale without sudo afterwards.
vp_tailscale_linux_up() {
  local key_file operator=""
  key_file=$(vp_tailscale_key_file)
  if [ -z "$vp_is_root" ]; then operator="--operator=$vp_user"; fi
  if [ -n "$key_file" ] && [ -r "$key_file" ]; then
    vp_working "Signing in to Tailscale with the auth key file $key_file"
    vp_as_root tailscale up "--auth-key=file:$key_file" ${operator:+"$operator"} && return 0
    vp_note "Tailscale did not sign in with that key. The installer asks how to sign in next."
    return 0
  fi
  vp_note "Sign this machine in to Tailscale: run $(vp_sudo_text tailscale up ${operator:+"$operator"})"
  vp_note "and open the link it prints, or rerun with --tailscale-auth-key-file=<path>."
}
vp_tailscale_sign_in_note() {
  if [ -n "$(vp_tailscale_key_file)" ]; then
    vp_note "The installer signs in with your auth key file once the app runs."
  fi
}

# Questions and fixes ------------------------------------------------------------------

vp_question_text() {
  case "$1" in
    node)
      printf 'Vorteo needs Node.js %s (%s). Install it now with %s?' \
        "$vp_minimum_node" "$vp_found" "$(vp_node_method)"
      ;;
    git)
      if [ "$vp_platform" = macos ]; then
        printf "Vorteo needs Git. Install Apple's Command Line Tools, which include Git? macOS shows an install dialog."
      else
        printf 'Vorteo needs Git. Install it with %s?%s' "${vp_package_manager:-your package manager}" \
          "$(vp_sudo_sentence)"
      fi
      ;;
    docker)
      if [ "$vp_platform" = macos ] && vp_has_brew; then
        printf 'The Dev container needs Docker. Install Docker Desktop with Homebrew? Homebrew may ask for your administrator password.'
      elif [ "$vp_platform" = macos ]; then
        printf 'The Dev container needs Docker. Open the Docker Desktop download page and wait while you install it?'
      elif [ "$vp_state" = stopped ]; then
        printf 'Docker is %s. Start the Docker service%s?%s' "$vp_found" \
          "$(if [ -z "$vp_is_root" ]; then printf ' and add %s to the docker group' "$vp_user"; fi)" \
          "$(vp_sudo_sentence)"
      else
        printf "The Dev container needs Docker. Install Docker Engine with Docker's official script from get.docker.com?%s" \
          "$(vp_sudo_sentence)"
      fi
      ;;
    tailscale)
      if [ "$vp_platform" = macos ] && vp_has_brew; then
        printf 'Remote access needs Tailscale. Install the Tailscale app with Homebrew? Homebrew may ask for your administrator password.'
      elif [ "$vp_platform" = macos ]; then
        printf 'Remote access needs Tailscale. Open the Tailscale download page and wait while you install it?'
      else
        printf "Remote access needs Tailscale. Install it with Tailscale's official script from tailscale.com?%s" \
          "$(vp_sudo_sentence)"
      fi
      ;;
  esac
}
vp_manual_fix() {
  case "$1:$vp_platform" in
    node:*)
      if vp_has_brew; then
        # shellcheck disable=SC2016 # The owner types $(brew --prefix ...) themselves.
        printf 'Run: brew install node@%s, add $(brew --prefix node@%s)/bin to PATH, then rerun.' \
          "$vp_minimum_node" "$vp_minimum_node"
      else
        printf 'Install nvm from https://github.com/nvm-sh/nvm, run: nvm install %s, then rerun.' "$vp_minimum_node"
      fi
      ;;
    git:macos) printf 'Run: xcode-select --install, finish the dialog, then rerun.' ;;
    git:linux)
      if [ -n "$vp_package_manager" ]; then
        printf 'Run: %s, then rerun.' "$(vp_git_command_text ' && ')"
      else
        printf 'Install Git with your package manager, then rerun.'
      fi
      ;;
    docker:macos)
      printf 'Install Docker Desktop from %s (or brew install --cask docker-desktop), open it once, then rerun. Or rerun with --no-dev-container for a Host-only installation.' \
        "$vp_docker_desktop_download"
      ;;
    docker:linux)
      if [ "$vp_state" = missing ]; then
        printf 'In a terminal, run: curl -fsSL https://get.docker.com -o get-docker.sh && %s && ' \
          "$(vp_sudo_text sh get-docker.sh)"
      else
        printf 'In a terminal, run: '
      fi
      printf '%s' "$(vp_sudo_text systemctl enable --now docker)"
      if [ -z "$vp_is_root" ]; then
        printf ' && %s, log out and back in' "$(vp_sudo_text usermod -aG docker "$vp_user")"
      fi
      printf ', then rerun. Or rerun with --no-dev-container for a Host-only installation.'
      ;;
    tailscale:macos)
      printf 'Install Tailscale from %s (or brew install --cask tailscale-app), then rerun. Or rerun with --remote=local.' \
        "$vp_tailscale_download"
      ;;
    tailscale:linux)
      printf 'In a terminal, run: curl -fsSL https://tailscale.com/install.sh -o tailscale-install.sh && %s, then rerun. Or rerun with --remote=local.' \
        "$(vp_sudo_text sh tailscale-install.sh)"
      ;;
  esac
}
