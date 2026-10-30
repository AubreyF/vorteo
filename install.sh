#!/usr/bin/env bash
# Vorteo installer for macOS and Linux.
#
#   curl -fsSL https://terranlabs.com/vorteo/install | bash
#
# It fetches the latest tested Vorteo release into ~/vorteo/source, asks a few questions,
# shows the plan, and hands the work to the installer engine in that release
# (scripts/installer/main.mjs). Rerun the same command at any time: a finished step is
# skipped, so a rerun resumes, and an existing installation is detected. A Host installation
# made before this installer (scripts/install-execution-host.mjs) is upgraded in place at its
# own folder after one confirmation, the proceed question.
#
# Options (each question also has an environment variable; flags win):
#   --yes, -y                       Take the default answer for every question (VORTEO_YES=1).
#                                   It never answers install-node, install-git, install-docker,
#                                   start-docker or install-tailscale: installing system
#                                   software always needs an explicit yes.
#   --dev-container=yes|no          Provision a Dev container; needs Docker (VORTEO_DEV_CONTAINER).
#   --no-dev-container              Same as --dev-container=no.
#   --name=<text>                   Installation name, default Vorteo (VORTEO_NAME).
#   --projects-folder=<path>        Projects folder, default ~/dev (VORTEO_PROJECTS_FOLDER).
#   --remote=tailscale|local        Remote access through Tailscale, or this machine only
#                                   (VORTEO_REMOTE).
#   --tailscale-auth-key-file=<path>
#                                   File holding a Tailscale auth key; answer none to sign in
#                                   with the Tailscale app instead
#                                   (VORTEO_TAILSCALE_AUTH_KEY_FILE).
#   --install-node=yes|no           Install Node.js 24 when it is missing (VORTEO_INSTALL_NODE).
#   --install-git=yes|no            Install Git when it is missing (VORTEO_INSTALL_GIT).
#   --install-docker=yes|no         Install Docker for the Dev container (VORTEO_INSTALL_DOCKER).
#   --start-docker=yes|no           Linux: start Docker and join the docker group
#                                   (VORTEO_START_DOCKER).
#   --install-tailscale=yes|no      Install Tailscale for remote access
#                                   (VORTEO_INSTALL_TAILSCALE).
#   --skip-prerequisites            Install no prerequisites; report each missing one with its
#                                   fix (VORTEO_SKIP_PREREQUISITES=1).
#   --proceed=yes|no                Approve the plan without being asked (VORTEO_PROCEED).
#   --repair                        Repair an existing installation.
#   --version=<tag>                 Install this release tag instead of the latest
#                                   (VORTEO_VERSION).
#   --root=<path>                   Installation folder, default ~/vorteo (VORTEO_ROOT).
#   --no-open                       Do not open the browser at the end (VORTEO_NO_OPEN=1).
#   --non-interactive               Never prompt, even with a terminal (VORTEO_NON_INTERACTIVE=1).
# Pass options through the pipe with: curl -fsSL <address> | bash -s -- --yes
#
# Agent mode. Prompts read from /dev/tty. Without a usable terminal (or under an agent such
# as Claude Code, or with --non-interactive), the installer never waits for input. When a
# question has no answer it prints every unanswered question in this fixed block on
# standard output and exits with status 3:
#
#   VORTEO_QUESTIONS_BEGIN
#   VORTEO_PLAN <one line of the plan summary>           (only before the proceed question)
#   VORTEO_QUESTION <id> <default> <question text>
#   VORTEO_QUESTIONS_END
#
# <id> and <default> never contain spaces; the text runs to the end of the line. Answer a
# question by rerunning with --<id>=<answer>, for example --dev-container=no. Ask the owner;
# do not choose for them. Never put a Tailscale auth key on the command line or in chat:
# the owner saves it to a file and the answer is that file's path.
#
# On success the installer prints these lines on standard output, then exits 0:
#   VORTEO_RESULT origin <address>
#   VORTEO_RESULT local-origin <address on this machine>
#   VORTEO_RESULT password-file <path of the owner password file>
# The password itself is never printed; it is copied to the clipboard when one is available.
#
# Exit status: 0 done, 1 failed (the output names the fix; rerun to resume), 2 bad option,
# 3 questions need answers, 4 the owner declined the plan.
#
# Prerequisites (Node.js, Git, Docker, Tailscale) are installed by the functions between
# the prerequisites.sh markers below. They are a copy of scripts/installer/prerequisites.sh,
# which documents them; edit that file, then run
# bash scripts/installer/embed-prerequisites.sh to refresh the copy.
#
# Tests only: VORTEO_TEST_TTY=<file> reads answers from that file as if typed at a terminal,
# and VORTEO_TEST_TTY=none behaves as if there were no terminal.
#
# The script only defines functions until the last line, which calls vorteo_install with a
# closing marker, so a partial download runs nothing.

# BEGIN prerequisites.sh (a copy; edit scripts/installer/prerequisites.sh, then run bash scripts/installer/embed-prerequisites.sh)
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
# END prerequisites.sh

vorteo_install() {
  local complete_marker="--vorteo-script-complete"
  if [ "$#" -eq 0 ] || [ "${!#}" != "$complete_marker" ]; then
    echo "This copy of the Vorteo installer is incomplete. Download it again." >&2
    return 1
  fi
  set -- "${@:1:$(($# - 1))}"

  # The GitHub repository is named here only.
  local repository="terran-labs/vorteo"
  local install_address="https://terranlabs.com/vorteo/install"
  local tailscale_download="https://tailscale.com/download"
  local minimum_node=24

  local assume_yes="" force_agent="" want_repair="" no_open="" pinned_version="" root=""
  local interactive="" skip_prerequisites="" platform="" node_bin="" source_dir="" work="" existing_kind=""
  local pending_questions="" pending_plan="" release_tag="" release_commit=""
  local original_args=("$@")
  # shellcheck disable=SC2088 # A ~ shown to the owner, expanded later by expand_path.
  local auth_key_file="" tailscale_attempts=0 failures=0 projects_default="~/dev"
  # Set by json_vars from the engine's detect report.
  local existing_paths="" existing_projects="" existing_root="" existing_resume=""
  local pre_node_ok="" pre_node_fix="" pre_git_ok=""
  local pre_git_fix="" pre_docker_ok="" pre_docker_running="" pre_docker_fix="" pre_ts_ok=""
  local pre_ts_running="" pre_ts_logged_in="" pre_ts_fix=""

  # Output ------------------------------------------------------------------------------

  local bold="" dim="" red="" green="" reset=""
  if [ -t 1 ] && [ "${TERM-}" != "dumb" ] && [ -z "${NO_COLOR-}" ]; then
    bold=$'\033[1m' dim=$'\033[2m' red=$'\033[31m' green=$'\033[32m' reset=$'\033[0m'
  fi
  say() { printf '%s\n' "$*"; }
  heading() { printf '\n%s%s%s\n' "$bold" "$*" "$reset"; }
  ok() { printf '  %s✓%s %s\n' "$green" "$reset" "$*"; }
  working() { printf '  %s…%s %s\n' "$dim" "$reset" "$*"; }
  problem() { printf '  %s✗%s %s\n' "$red" "$reset" "$*"; }
  fix() { printf '    %sFix:%s %s\n' "$bold" "$reset" "$*"; }
  # fail <message> [fix]: prints and exits with status 1.
  fail() {
    printf '\n%s✗ %s%s\n' "$red" "$1" "$reset" >&2
    if [ -n "${2-}" ]; then printf '  %sFix:%s %s\n' "$bold" "$reset" "$2" >&2; fi
    exit 1
  }
  # rerun_command [extra args]: the command that reruns this installer with the same options.
  rerun_command() {
    local quoted="" arg
    for arg in ${original_args[@]+"${original_args[@]}"} "$@"; do
      quoted="$quoted $(printf '%q' "$arg")"
    done
    case "$0" in
      *install.sh) printf 'bash %q%s' "$0" "$quoted" ;;
      *)
        if [ -n "$quoted" ]; then
          printf 'curl -fsSL %s | bash -s --%s' "$install_address" "$quoted"
        else
          printf 'curl -fsSL %s | bash' "$install_address"
        fi
        ;;
    esac
  }
  usage() {
    say "Usage: curl -fsSL $install_address | bash -s -- [options]"
    say ""
    say "  --yes, -y                         Take every default answer"
    say "  --dev-container=yes|no            Provision a Dev container (needs Docker)"
    say "  --name=<text>                     Installation name (Vorteo)"
    say "  --projects-folder=<path>          Projects folder (~/dev)"
    say "  --remote=tailscale|local          Remote access through Tailscale, or this machine only"
    say "  --tailscale-auth-key-file=<path>  File holding a Tailscale auth key"
    say "  --install-node=yes|no             Install Node.js $minimum_node when it is missing"
    say "  --install-git=yes|no              Install Git when it is missing"
    say "  --install-docker=yes|no           Install Docker for the Dev container"
    say "  --start-docker=yes|no             Linux: start Docker and join the docker group"
    say "  --install-tailscale=yes|no        Install Tailscale for remote access"
    say "  --skip-prerequisites              Install nothing; report missing prerequisites with their fixes"
    say "  --proceed=yes|no                  Approve the plan without being asked"
    say "  --repair                          Repair an existing installation"
    say "  --version=<tag>                   Install this release instead of the latest"
    say "  --root=<path>                     Installation folder (~/vorteo)"
    say "  --no-open                         Do not open the browser at the end"
    say "  --non-interactive                 Never prompt; print unanswered questions and exit 3"
    say ""
    say "The comment at the top of install.sh documents agent mode and the environment variables."
  }

  # Answers -----------------------------------------------------------------------------

  # Each question id maps to a shell variable answer_<id with underscores>.
  answer_var() { printf 'answer_%s' "$1" | tr '-' '_'; }
  set_answer() { printf -v "$(answer_var "$1")" '%s' "$2"; }
  get_answer() {
    local name
    name=$(answer_var "$1")
    printf '%s' "${!name-}"
  }
  normalize_bool() {
    case "$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')" in
      y | yes | true | 1 | on) printf 'yes' ;;
      n | no | false | 0 | off) printf 'no' ;;
      *) return 1 ;;
    esac
  }
  normalize_remote() {
    case "$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')" in
      t | tailscale) printf 'tailscale' ;;
      l | local | local-only | none) printf 'local' ;;
      *) return 1 ;;
    esac
  }
  # Expands a leading ~ typed by the owner; relative paths are refused.
  expand_path() {
    # shellcheck disable=SC2088 # The patterns match a literal ~.
    case "$1" in
      "~") printf '%s' "$HOME" ;;
      "~/"*) printf '%s/%s' "$HOME" "${1#\~/}" ;;
      /*) printf '%s' "$1" ;;
      *) return 1 ;;
    esac
  }
  # validate_answer <id> <value>: prints the normalized value or fails.
  validate_answer() {
    case "$1" in
      dev-container | install-node | install-git | install-docker | start-docker | \
        install-tailscale | proceed)
        normalize_bool "$2"
        ;;
      remote) normalize_remote "$2" ;;
      projects-folder) expand_path "$2" >/dev/null && printf '%s' "$2" ;;
      name)
        if [ -n "$2" ] && [ "${#2}" -le 64 ]; then printf '%s' "$2"; else return 1; fi
        ;;
      tailscale-auth-key-file)
        if [ "$2" = "none" ]; then
          printf 'none'
        else
          expand_path "$2"
        fi
        ;;
      *) printf '%s' "$2" ;;
    esac
  }
  answer_hint() {
    case "$1" in
      dev-container | install-node | install-git | install-docker | start-docker | \
        install-tailscale | proceed)
        printf 'yes or no'
        ;;
      remote) printf 'tailscale or local' ;;
      name) printf '1 to 64 characters' ;;
      projects-folder | tailscale-auth-key-file) printf 'an absolute path or one starting with ~/' ;;
    esac
  }
  option_answer() {
    local value
    if ! value=$(validate_answer "$1" "$2"); then
      printf 'Invalid value for --%s: %s (expected %s)\n' "$1" "$2" "$(answer_hint "$1")" >&2
      exit 2
    fi
    set_answer "$1" "$value"
  }

  # read_tty <variable> [hidden]: reads one line typed by the owner.
  read_tty() {
    local line=""
    if [ "${2-}" = "hidden" ]; then
      IFS= read -rs line <&3 || fail "Input ended before the question was answered." "Rerun the installer."
      printf '\n'
    else
      IFS= read -r line <&3 || fail "Input ended before the question was answered." "Rerun the installer."
    fi
    printf -v "$1" '%s' "$line"
  }

  # ask <id> <default> <text>: answers from a flag or variable, --yes, the terminal, or
  # queues the question for the agent block.
  ask() {
    local id="$1" default="$2" text="$3" value="" typed=""
    value=$(get_answer "$id")
    if [ -n "$value" ]; then return 0; fi
    # --yes never answers a prerequisite install.
    case "$id" in
      install-* | start-docker) ;;
      *)
        if [ -n "$assume_yes" ]; then
          set_answer "$id" "$default"
          return 0
        fi
        ;;
    esac
    if [ -z "$interactive" ]; then
      pending_questions="${pending_questions}VORTEO_QUESTION $id $default $text"$'\n'
      return 0
    fi
    while :; do
      printf '%s%s%s %s[%s]%s ' "$bold" "$text" "$reset" "$dim" "$default" "$reset"
      read_tty typed
      if [ -z "$typed" ]; then typed="$default"; fi
      if value=$(validate_answer "$id" "$typed"); then
        set_answer "$id" "$value"
        return 0
      fi
      say "  Please answer $(answer_hint "$id")."
    done
  }

  # Prints the queued questions and exits 3 when any are waiting.
  flush_questions() {
    if [ -z "$pending_questions" ]; then return 0; fi
    say ""
    say "The installer needs answers. Ask the owner each question, then rerun with --<id>=<answer>."
    say "VORTEO_QUESTIONS_BEGIN"
    printf '%s' "$pending_plan"
    printf '%s' "$pending_questions"
    say "VORTEO_QUESTIONS_END"
    exit 3
  }

  # Arguments ---------------------------------------------------------------------------

  local arg key value
  while [ "$#" -gt 0 ]; do
    arg="$1"
    shift
    case "$arg" in
      -y | --yes) assume_yes=1 ;;
      --non-interactive) force_agent=1 ;;
      --repair) want_repair=1 ;;
      --no-open) no_open=1 ;;
      --skip-prerequisites) skip_prerequisites=1 ;;
      --dev-container) set_answer dev-container yes ;;
      --no-dev-container) set_answer dev-container no ;;
      -h | --help)
        usage
        return 0
        ;;
      --*=*)
        key="${arg%%=*}"
        key="${key#--}"
        value="${arg#*=}"
        ;;
      --name | --projects-folder | --remote | --tailscale-auth-key-file | --install-node | \
        --install-git | --install-docker | --start-docker | --install-tailscale | --proceed | \
        --version | --root)
        if [ "$#" -eq 0 ]; then
          printf 'Option %s needs a value.\n' "$arg" >&2
          exit 2
        fi
        key="${arg#--}"
        value="$1"
        shift
        ;;
      *)
        printf 'Unknown option: %s (see --help)\n' "$arg" >&2
        exit 2
        ;;
    esac
    case "$arg" in
      --*=* | --name | --projects-folder | --remote | --tailscale-auth-key-file | \
        --install-node | --install-git | --install-docker | --start-docker | \
        --install-tailscale | --proceed | --version | --root)
        case "$key" in
          version) pinned_version="$value" ;;
          root) root="$value" ;;
          dev-container | name | projects-folder | remote | tailscale-auth-key-file | \
            install-node | install-git | install-docker | start-docker | install-tailscale | \
            proceed)
            option_answer "$key" "$value"
            ;;
          *)
            printf 'Unknown option: --%s (see --help)\n' "$key" >&2
            exit 2
            ;;
        esac
        ;;
    esac
  done

  # Environment variables fill what flags left open.
  local env_pair id env_name
  for env_pair in dev-container:VORTEO_DEV_CONTAINER name:VORTEO_NAME \
    projects-folder:VORTEO_PROJECTS_FOLDER remote:VORTEO_REMOTE \
    tailscale-auth-key-file:VORTEO_TAILSCALE_AUTH_KEY_FILE install-node:VORTEO_INSTALL_NODE \
    install-git:VORTEO_INSTALL_GIT install-docker:VORTEO_INSTALL_DOCKER \
    start-docker:VORTEO_START_DOCKER install-tailscale:VORTEO_INSTALL_TAILSCALE \
    proceed:VORTEO_PROCEED; do
    id="${env_pair%%:*}"
    env_name="${env_pair#*:}"
    if [ -z "$(get_answer "$id")" ] && [ -n "${!env_name-}" ]; then
      option_answer "$id" "${!env_name}"
    fi
  done
  if [ -n "${VORTEO_YES-}" ] && [ "${VORTEO_YES}" != "0" ]; then assume_yes=1; fi
  if [ -n "${VORTEO_NO_OPEN-}" ] && [ "${VORTEO_NO_OPEN}" != "0" ]; then no_open=1; fi
  if [ -n "${VORTEO_SKIP_PREREQUISITES-}" ] && [ "${VORTEO_SKIP_PREREQUISITES}" != "0" ]; then
    skip_prerequisites=1
  fi
  if [ -n "${VORTEO_NON_INTERACTIVE-}" ] && [ "${VORTEO_NON_INTERACTIVE}" != "0" ]; then
    force_agent=1
  fi
  if [ -z "$pinned_version" ]; then pinned_version="${VORTEO_VERSION-}"; fi
  if [ -z "$root" ]; then root="${VORTEO_ROOT:-$HOME/vorteo}"; fi
  root=$(expand_path "$root") || {
    say "The installation folder must be an absolute path or start with ~/." >&2
    exit 2
  }
  source_dir="$root/source"

  # Terminal ----------------------------------------------------------------------------

  # Prompts use file descriptor 3. Agents get no prompts even when a terminal is reachable,
  # because nobody would see the question.
  case "${VORTEO_TEST_TTY-}" in
    none) ;;
    "")
      if [ -z "$force_agent" ] && [ -z "${CLAUDECODE-}" ] && { [ -t 1 ] || [ -t 2 ]; } &&
        (exec 3</dev/tty) 2>/dev/null; then
        exec 3</dev/tty
        interactive=1
      fi
      ;;
    *)
      if [ -z "$force_agent" ]; then
        exec 3<"$VORTEO_TEST_TTY" || exit 1
        interactive=1
      fi
      ;;
  esac

  VORTEO_INSTALL_WORK=$(umask 077 && mktemp -d "${TMPDIR:-/tmp}/vorteo-install.XXXXXX") ||
    fail "Could not create a temporary folder." "Check that ${TMPDIR:-/tmp} is writable."
  work="$VORTEO_INSTALL_WORK"
  trap 'rm -rf "$VORTEO_INSTALL_WORK"' EXIT
  trap 'exit 130' INT TERM

  say "${bold}Vorteo installer${reset}"

  # Prerequisites the installer itself needs --------------------------------------------

  case "$(uname -s)" in
    Darwin) platform=macos ;;
    Linux) platform=linux ;;
    *) fail "Vorteo installs on macOS and Linux only; this is $(uname -s)." ;;
  esac

  command -v curl >/dev/null 2>&1 ||
    fail "curl is required to fetch the release." "Install curl with your package manager, then rerun."

  # Node.js and Git are needed before the release exists; the questions come first, then
  # each install. Docker and Tailscale wait for the answers below.
  vorteo_ensure_prerequisites ${interactive:+--interactive} ${skip_prerequisites:+--skip} node git || exit 1
  node_bin="$VORTEO_NODE_BIN"

  # Engine ------------------------------------------------------------------------------

  run_engine() {
    local command="$1"
    shift
    "$node_bin" "$source_dir/scripts/installer/main.mjs" "$command" --root "$root" "$@" \
      </dev/null 3<&-
  }
  # json_vars <file> <name=expression>...: sets shell variables from a JSON file. Each
  # expression is JavaScript over `d`; arrays become lines and missing values are empty.
  json_vars() {
    local assignments
    assignments=$("$node_bin" -e '
      const q = String.fromCharCode(39);
      const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      for (const spec of process.argv.slice(2)) {
        const at = spec.indexOf("=");
        let v;
        try { v = new Function("d", "return (" + spec.slice(at + 1) + ")")(d); } catch { v = undefined; }
        if (v === undefined || v === null) v = "";
        else if (Array.isArray(v)) v = v.join("\n");
        else if (typeof v === "object") v = JSON.stringify(v);
        const text = String(v).split(q).join(q + "\\" + q + q);
        process.stdout.write(spec.slice(0, at) + "=" + q + text + q + "\n");
      }' "$@" 3<&-) || return 1
    eval "$assignments"
  }
  # detect [soft]: reads the engine's report. With soft, a failure returns 1 instead.
  detect() {
    if ! run_engine detect --json >"$work/detect.json" 2>"$work/detect.log"; then
      if [ "${1-}" = soft ]; then return 1; fi
      fail "The installer engine could not inspect this machine: $(tail -n 3 "$work/detect.log")" \
        "Rerun the installer. If it fails again, report the message above."
    fi
    json_vars "$work/detect.json" \
      existing_kind='d.existing && d.existing.kind' \
      existing_paths='d.existing && d.existing.paths && Object.values(d.existing.paths)' \
      existing_projects='d.existing && d.existing.paths && d.existing.paths.projectsFolder' \
      existing_root='d.existing && d.existing.paths && d.existing.paths.root' \
      existing_resume='d.existing && d.existing.resume' \
      pre_node_ok='d.prerequisites.node.ok' pre_node_fix='d.prerequisites.node.fix' \
      pre_git_ok='d.prerequisites.git.ok' pre_git_fix='d.prerequisites.git.fix' \
      pre_docker_ok='d.prerequisites.docker.ok' pre_docker_running='d.prerequisites.docker.running' \
      pre_docker_fix='d.prerequisites.docker.fix' \
      pre_ts_ok='d.prerequisites.tailscale.ok' pre_ts_running='d.prerequisites.tailscale.running' \
      pre_ts_logged_in='d.prerequisites.tailscale.loggedIn' pre_ts_fix='d.prerequisites.tailscale.fix' ||
      fail "The installer engine returned an unreadable report." "Rerun the installer."
  }
  # apply_with_progress <result|no-result> <engine args>: streams engine events as progress
  # and returns 0 on success. With no-result the engine need not report a final result.
  apply_with_progress() {
    local progress="$source_dir/scripts/installer/progress.mjs" engine_status progress_status
    local expect=""
    if [ "$1" = no-result ]; then expect="--no-result"; fi
    shift
    run_engine "$@" | "$node_bin" "$progress" ${expect:+"$expect"} --result "$work/result.json" 3<&-
    engine_status="${PIPESTATUS[0]}" progress_status="${PIPESTATUS[1]}"
    [ "$engine_status" -eq 0 ] && [ "$progress_status" -eq 0 ]
  }
  resume_hint() {
    say ""
    say "Vorteo is not finished installing. Fix the problem above, then rerun the same command to resume:"
    say "  $(rerun_command)"
  }

  # Release -----------------------------------------------------------------------------

  github() {
    curl -fsSL --retry 2 -H "Accept: $1" -H "X-GitHub-Api-Version: 2022-11-28" \
      "https://api.github.com/repos/$repository/$2" 3<&-
  }
  resolve_release() {
    local endpoint="releases/latest" release_target=""
    if [ -n "$pinned_version" ]; then endpoint="releases/tags/$pinned_version"; fi
    github "application/vnd.github+json" "$endpoint" >"$work/release.json" 2>"$work/curl.log" ||
      fail "Could not find the ${pinned_version:-latest} Vorteo release on GitHub." \
        "Check your internet connection${pinned_version:+ and that $pinned_version is a published release tag}, then rerun."
    json_vars "$work/release.json" release_tag='d.tag_name' release_target='d.target_commitish' ||
      fail "GitHub returned an unreadable release." "Rerun the installer."
    if [ -z "$release_tag" ]; then fail "GitHub returned a release without a tag." "Rerun the installer."; fi
    release_commit=$(github "application/vnd.github.sha" "commits/$release_tag" 2>>"$work/curl.log") ||
      fail "Could not read the commit of release $release_tag." "Check your internet connection, then rerun."
    case "$release_commit" in
      *[!0-9a-f]* | "") fail "GitHub returned an invalid commit for release $release_tag." "Rerun the installer." ;;
    esac
    if [ "${#release_commit}" -ne 40 ]; then
      fail "GitHub returned an invalid commit for release $release_tag." "Rerun the installer."
    fi
    # A release made from a commit records it; the tag must still point there.
    case "$release_target" in
      [0-9a-f]*)
        if [ "${#release_target}" -eq 40 ] && [ "$release_target" != "$release_commit" ]; then
          fail "Release $release_tag points at $release_target but its tag points at $release_commit." \
            "Wait for the release to be corrected, or pin another with --version=<tag>."
        fi
        ;;
    esac
  }
  verify_checkout() {
    local head
    head=$(git -C "$1" rev-parse HEAD 2>/dev/null 3<&-)
    [ "$head" = "$release_commit" ]
  }
  fetch_release() {
    # VORTEO_INSTALL_SOURCE installs an existing checkout instead of a release, for the
    # install tests, which run on a commit that has no release yet.
    if [ -n "${VORTEO_INSTALL_SOURCE:-}" ]; then
      if [ ! -d "$VORTEO_INSTALL_SOURCE/.git" ] && [ ! -f "$VORTEO_INSTALL_SOURCE/.git" ]; then
        fail "VORTEO_INSTALL_SOURCE=$VORTEO_INSTALL_SOURCE is not a Git checkout." "Point it at a Vorteo checkout."
      fi
      source_dir=$(cd "$VORTEO_INSTALL_SOURCE" && pwd)
      release_commit=$(git -C "$source_dir" rev-parse HEAD 3<&-)
      # The commit stands in for a tag; the engine resolves either.
      release_tag="$release_commit"
      ok "Installing the checkout at $source_dir"
      return 0
    fi
    resolve_release
    if [ -e "$source_dir" ] && [ ! -d "$source_dir/.git" ]; then
      fail "$source_dir exists but is not a Vorteo source checkout." \
        "Move it somewhere else, then rerun."
    fi
    if [ -d "$source_dir/.git" ]; then
      if verify_checkout "$source_dir"; then
        ok "Vorteo $release_tag is already in $source_dir"
        return 0
      fi
      if [ -n "$(git -C "$source_dir" status --porcelain 2>/dev/null 3<&-)" ]; then
        fail "$source_dir has local changes, so the installer will not replace it with $release_tag." \
          "Commit or discard the changes in $source_dir, or move it aside, then rerun."
      fi
      working "Updating $source_dir to Vorteo $release_tag"
      # shellcheck disable=SC2015 # Either step failing should fail.
      git -C "$source_dir" fetch --quiet --depth 1 origin "refs/tags/$release_tag:refs/tags/$release_tag" \
        </dev/null 3<&- &&
        git -C "$source_dir" -c advice.detachedHead=false checkout --quiet --detach "$release_tag" \
          </dev/null 3<&- ||
        fail "Could not update $source_dir to $release_tag." "Check your internet connection, then rerun."
    else
      working "Fetching Vorteo $release_tag into $source_dir (nothing is installed until you approve the plan)"
      # shellcheck disable=SC2015 # Either step failing should fail.
      (umask 077 && mkdir -p "$root") && chmod 700 "$root" ||
        fail "Could not create $root." "Check that you can write to $(dirname "$root")."
      local partial="$source_dir.partial"
      rm -rf "$partial"
      git -c advice.detachedHead=false clone --quiet --depth 1 --branch "$release_tag" \
        "https://github.com/$repository.git" "$partial" </dev/null 3<&- ||
        fail "Could not download Vorteo $release_tag." "Check your internet connection, then rerun."
      if ! verify_checkout "$partial"; then
        rm -rf "$partial"
        fail "The downloaded source does not match release $release_tag ($release_commit)." \
          "Rerun the installer. If it fails again, the release may have moved: pin one with --version=<tag>."
      fi
      mv "$partial" "$source_dir" || fail "Could not move the release into $source_dir."
    fi
    verify_checkout "$source_dir" ||
      fail "$source_dir does not match release $release_tag ($release_commit)." "Rerun the installer."
    [ -f "$source_dir/scripts/installer/main.mjs" ] ||
      fail "Release $release_tag has no installer engine." "Pin a newer release with --version=<tag>."
    ok "Fetched Vorteo $release_tag"
  }

  # The vorteo command ------------------------------------------------------------------

  install_command() {
    local bin_dir="$HOME/.local/bin" target shim_marker="# vorteo-command-shim"
    target="$bin_dir/vorteo"
    if [ -e "$target" ] && ! grep -q "$shim_marker" "$target" 2>/dev/null; then
      problem "Left $target alone because something else is installed there."
      return 0
    fi
    mkdir -p "$bin_dir" || return 0
    # shellcheck disable=SC2016 # The shim expands these when it runs, not now.
    {
      printf '#!/usr/bin/env bash\n'
      printf '%s\n' "$shim_marker"
      printf '# Installed by the Vorteo installer. Forwards to the command in the release source.\n'
      printf 'VORTEO_ROOT=${VORTEO_ROOT:-%s}\n' "$(printf '%q' "$root")"
      printf 'VORTEO_NODE=${VORTEO_NODE:-%s}\n' "$(printf '%q' "$node_bin")"
      printf 'export VORTEO_ROOT VORTEO_NODE\n'
      printf 'script="$VORTEO_ROOT/source/scripts/installer/vorteo.sh"\n'
      printf 'if [ ! -f "$script" ]; then\n'
      printf '  echo "Vorteo is not installed in $VORTEO_ROOT. Install it with: curl -fsSL %s | bash" >&2\n' "$install_address"
      printf '  exit 1\n'
      printf 'fi\n'
      printf 'exec bash "$script" "$@"\n'
    } >"$target.tmp" && chmod 755 "$target.tmp" && mv "$target.tmp" "$target" || return 0
    ok "Installed the vorteo command in $target"
    case ":$PATH:" in
      *":$bin_dir:"*) ;;
      *)
        local profile="your shell profile"
        # shellcheck disable=SC2088 # Profile names shown to the owner.
        case "${SHELL-}" in
          */zsh) profile="~/.zshrc" ;;
          */bash) if [ "$platform" = macos ]; then profile="~/.bash_profile"; else profile="~/.bashrc"; fi ;;
          */fish) profile="fish" ;;
        esac
        if [ "$profile" = fish ]; then
          say "    $bin_dir is not on your PATH. Run: fish_add_path $bin_dir"
        else
          say "    $bin_dir is not on your PATH. Add this line to $profile:"
          say "      export PATH=\"\$HOME/.local/bin:\$PATH\""
        fi
        ;;
    esac
  }

  # Finish ------------------------------------------------------------------------------

  open_address() {
    if [ -n "$no_open" ] || [ -z "$1" ]; then return 0; fi
    if [ "$platform" = macos ] && command -v open >/dev/null 2>&1; then
      open "$1" >/dev/null 2>&1 3<&- </dev/null && ok "Opened $1"
    elif { [ -n "${DISPLAY-}" ] || [ -n "${WAYLAND_DISPLAY-}" ]; } && command -v xdg-open >/dev/null 2>&1; then
      xdg-open "$1" >/dev/null 2>&1 3<&- </dev/null && ok "Opened $1"
    fi
  }
  # Copies the password without printing it. Returns 1 when no clipboard is available.
  copy_password() {
    [ -r "$1" ] || return 1
    local copier=""
    if [ "$platform" = macos ] && command -v pbcopy >/dev/null 2>&1; then
      copier="pbcopy"
    elif [ -n "${WAYLAND_DISPLAY-}" ] && command -v wl-copy >/dev/null 2>&1; then
      copier="wl-copy"
    elif [ -n "${DISPLAY-}" ] && command -v xclip >/dev/null 2>&1; then
      copier="xclip -selection clipboard"
    else
      return 1
    fi
    tr -d '\r\n' <"$1" | $copier >/dev/null 2>&1 3<&-
  }
  show_qr() {
    local columns="${COLUMNS-}"
    if [ -z "$columns" ]; then columns=$(tput cols 2>/dev/null || printf '80'); fi
    local qr="$source_dir/scripts/installer/qr.mjs" qr_status=0
    [ -f "$qr" ] || return 0
    say ""
    say "  Scan to open Vorteo on your phone (it must be on your tailnet):"
    "$node_bin" "$qr" "$1" --max-width "$columns" 3<&- || qr_status=$?
    if [ "$qr_status" -eq 5 ]; then
      say "  Widen the terminal to see a QR code, or open $1 on your phone."
    fi
  }
  finish() {
    local origin="" local_origin="" password_file="" name=""
    json_vars "$work/result.json" origin='d.origin' local_origin='d.localOrigin' \
      password_file='d.passwordFile' name='d.name' ||
      fail "The installer engine returned an unreadable result." "Rerun the installer."
    if [ -z "$origin" ]; then origin="$local_origin"; fi
    install_command
    heading "${green}✓${reset}${bold} ${name:-Vorteo} is ready"
    say "  Address:          $origin"
    if [ -n "$local_origin" ] && [ "$local_origin" != "$origin" ]; then
      say "  On this machine:  $local_origin"
    fi
    if copy_password "$password_file"; then
      say "  Owner password:   copied to your clipboard"
    else
      say "  Owner password:   in the file below"
    fi
    say "  Password file:    $password_file"
    if [ -n "$interactive" ] && [ "$origin" != "$local_origin" ]; then
      case "$origin" in https://*) show_qr "$origin" ;; esac
    fi
    say ""
    say "  Sign in with the owner password. Everything else, including updates, happens in the interface."
    say "  Commands: vorteo status, vorteo doctor, vorteo open, vorteo update, vorteo repair, vorteo uninstall"
    open_address "$origin"
    say ""
    say "VORTEO_RESULT origin $origin"
    say "VORTEO_RESULT local-origin $local_origin"
    say "VORTEO_RESULT password-file $password_file"
  }

  # Existing installations --------------------------------------------------------------

  handle_current() {
    heading "Vorteo is already installed in $root"
    if [ -n "$want_repair" ]; then
      heading "Repairing"
      if ! apply_with_progress no-result repair; then
        resume_hint
        exit 1
      fi
      if [ -s "$work/result.json" ]; then
        finish
      else
        ok "Repaired"
        install_command
      fi
      return 0
    fi
    install_command
    say "  Open it:    vorteo open"
    say "  Repair it:  $(rerun_command --repair)"
    say "VORTEO_STATUS installed $root"
    if [ -n "$interactive" ] && [ -z "$no_open" ]; then
      local open_now=""
      printf '%sOpen Vorteo now?%s %s[yes]%s ' "$bold" "$reset" "$dim" "$reset"
      read_tty open_now
      if [ "$(normalize_bool "${open_now:-yes}")" = "yes" ]; then
        bash "$source_dir/scripts/installer/vorteo.sh" open 3<&-
      fi
    fi
  }

  # A Host installation from before this installer (scripts/install-execution-host.mjs) is
  # upgraded in place: its folder, identity and data stay, and Dev moves to gate mode.
  upgrade_existing() {
    heading "Found a Vorteo installation from before this installer"
    say "    $existing_root"
    say "  The installer upgrades it in place. Its identity, owner password, homes, agents and data"
    say "  stay where they are, and later upgrades happen in the interface."
    root="$existing_root"
    if [ "$existing_resume" = true ]; then
      heading "Resuming the upgrade"
      if ! apply_with_progress no-result adopt --source "$source_dir"; then
        resume_hint
        exit 1
      fi
      run_engine status --json >"$work/result.json" 2>"$work/status.log" ||
        fail "The upgrade finished but its status is unreadable." "Run: vorteo status"
      finish
      return 0
    fi
    run_engine plan --adopt --source "$source_dir" --json >"$work/plan-output.json" 2>"$work/plan.log" ||
      fail "The installer engine could not plan the upgrade: $(tail -n 3 "$work/plan.log")" "Fix the problem it names, then rerun."
    local plan_summary=""
    json_vars "$work/plan-output.json" plan_summary='d.summary' ||
      fail "The installer engine returned an unreadable plan." "Rerun the installer."
    "$node_bin" -e '
      const fs = require("fs");
      const output = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      fs.writeFileSync(process.argv[2], JSON.stringify(output.plan, null, 2) + "\n", { mode: 0o600 });
    ' "$work/plan-output.json" "$work/plan.json" 3<&- || fail "Could not record the plan."
    heading "Plan"
    printf '%s\n' "$plan_summary" | sed 's/^/  • /'
    say ""
    if [ -z "$interactive" ] && [ -z "$assume_yes" ] && [ -z "$(get_answer proceed)" ]; then
      pending_plan=$(printf '%s\n' "$plan_summary" | sed 's/^/VORTEO_PLAN /')$'\n'
    fi
    ask proceed yes "Upgrade this installation?"
    flush_questions
    if [ "$(get_answer proceed)" != yes ]; then
      say "Stopped before upgrading. Nothing in $root changed."
      exit 4
    fi
    heading "Upgrading"
    if ! apply_with_progress result apply --plan "$work/plan.json"; then
      resume_hint
      exit 1
    fi
    finish
  }

  # Run ---------------------------------------------------------------------------------

  heading "Preparing"
  # An earlier run's engine can recognize a finished installation without the network.
  if [ -f "$source_dir/scripts/installer/main.mjs" ] && detect soft; then
    if [ "$existing_kind" = current ]; then
      if [ -n "$existing_root" ]; then root="$existing_root"; fi
      handle_current
      return 0
    fi
  fi
  if [ -n "$want_repair" ]; then
    say "  No complete installation was found, so the installer continues with a new install."
  fi
  fetch_release
  detect

  case "$existing_kind" in
    current)
      if [ -n "$existing_root" ]; then root="$existing_root"; fi
      handle_current
      return 0
      ;;
    legacy-host)
      upgrade_existing
      return 0
      ;;
    legacy-container | legacy-lab)
      heading "Found an earlier Vorteo deployment"
      if [ -n "$existing_paths" ]; then
        printf '%s\n' "$existing_paths" | sed 's/^/    /'
      fi
      say "  The installer will wrap this installation, keeping your Dev environment: its identity,"
      say "  home, workspace and agents stay as they are. The Host and coordinator are added around it."
      set_answer dev-container yes
      # Offer the deployment's own Projects folder when it has one, written with ~/.
      # shellcheck disable=SC2088 # Shown to the owner, expanded later by expand_path.
      case "$existing_projects" in
        *" "* | "") ;;
        "$HOME"/*) projects_default="~/${existing_projects#"$HOME"/}" ;;
        /*) projects_default="$existing_projects" ;;
      esac
      ;;
    none | "") ;;
    *) fail "The installer engine reported an unknown installation kind: $existing_kind." "Rerun the installer." ;;
  esac

  heading "Questions"
  ask dev-container yes "Provision a Dev container where agents work? It needs Docker."
  ask name Vorteo "Installation name?"
  ask projects-folder "$projects_default" "Projects folder?"
  ask remote tailscale "Remote access: tailscale (recommended, open it from your other devices) or local (this machine only)?"
  flush_questions

  # Install what the answers need, then look again so the preflight sees it.
  local wanted_tools=""
  if [ "$(get_answer dev-container)" = yes ]; then wanted_tools="docker"; fi
  if [ "$(get_answer remote)" = tailscale ]; then wanted_tools="$wanted_tools tailscale"; fi
  if [ -n "$wanted_tools" ]; then
    # shellcheck disable=SC2086 # wanted_tools is a list of fixed tool names.
    vorteo_ensure_prerequisites ${interactive:+--interactive} ${skip_prerequisites:+--skip} \
      $wanted_tools || exit 1
    detect
  fi

  # Preflight ---------------------------------------------------------------------------

  heading "Checking this machine"
  # check_tailscale: 0 ready, 1 a problem was reported, 2 check again after the owner acted.
  check_tailscale() {
    auth_key_file="$(get_answer tailscale-auth-key-file)"
    if [ "$pre_ts_ok" != true ]; then
      problem "Tailscale is not installed"
      if [ -n "$interactive" ] && [ "$tailscale_attempts" -lt 3 ]; then
        local open_download="" next=""
        tailscale_attempts=$((tailscale_attempts + 1))
        printf '%sOpen the Tailscale download page?%s %s[yes]%s ' "$bold" "$reset" "$dim" "$reset"
        read_tty open_download
        if [ "$(normalize_bool "${open_download:-yes}")" = yes ]; then
          local keep_no_open="$no_open"
          no_open=""
          open_address "$tailscale_download"
          no_open="$keep_no_open"
        fi
        printf 'Press Enter once Tailscale is installed and signed in, or type local to use this machine only: '
        read_tty next
        if [ "$(normalize_remote "$next" 2>/dev/null)" = local ]; then set_answer remote local; fi
        return 2
      fi
      fix "${pre_ts_fix:-Install Tailscale from $tailscale_download, then rerun.} Or rerun with --remote=local."
      return 1
    fi
    if [ "$pre_ts_logged_in" = true ] && [ "$pre_ts_running" != false ]; then
      ok "Tailscale"
      return 0
    fi
    if [ -n "$auth_key_file" ] && [ "$auth_key_file" != none ]; then
      if [ -r "$auth_key_file" ] && [ -s "$auth_key_file" ]; then
        ok "Tailscale (the installer signs in with the auth key file)"
        return 0
      fi
      problem "Cannot read the Tailscale auth key file $auth_key_file"
      fix "Check the path and that the file holds the key, then rerun."
      return 1
    fi
    if [ -n "$interactive" ] && [ "$tailscale_attempts" -lt 3 ]; then
      local typed_key=""
      tailscale_attempts=$((tailscale_attempts + 1))
      say "  Tailscale is installed but this machine is not signed in."
      printf 'Paste a Tailscale auth key (hidden), or press Enter to sign in with the Tailscale app: '
      read_tty typed_key hidden
      if [ -n "$typed_key" ]; then
        # printf is a builtin, so the key never appears in a process list.
        (umask 077 && printf '%s\n' "$typed_key" >"$work/tailscale-auth-key") ||
          fail "Could not save the auth key for the installer."
        typed_key=""
        set_answer tailscale-auth-key-file "$work/tailscale-auth-key"
      else
        printf 'Sign in with the Tailscale app, then press Enter: '
        read_tty typed_key
      fi
      return 2
    fi
    if [ -z "$interactive" ] && [ -z "$auth_key_file" ]; then
      ask tailscale-auth-key-file none "Tailscale is not signed in on this machine. The owner signs in with the Tailscale app and answers none, or saves an auth key in a file only they can read and answers with its path. Never paste the key into chat."
      flush_questions
      # --yes answered none: look once more in case the owner already signed in.
      if [ "$tailscale_attempts" -eq 0 ]; then
        tailscale_attempts=1
        return 2
      fi
    fi
    problem "Tailscale is not signed in"
    fix "${pre_ts_fix:-Sign in with the Tailscale app, or pass --tailscale-auth-key-file=<path>, then rerun.} Or rerun with --remote=local."
    return 1
  }
  local tailscale_status
  while :; do
    failures=0
    if [ "$pre_node_ok" = true ]; then ok "Node.js"; else
      problem "Node.js $minimum_node"
      fix "${pre_node_fix:-Install Node.js $minimum_node, then rerun.}"
      failures=$((failures + 1))
    fi
    if [ "$pre_git_ok" = true ]; then ok "Git"; else
      problem "Git"
      fix "${pre_git_fix:-$(vorteo_prerequisite_fix git)}"
      failures=$((failures + 1))
    fi
    if [ "$(get_answer dev-container)" = yes ]; then
      if [ "$pre_docker_ok" = true ] && [ "$pre_docker_running" != false ]; then ok "Docker"; else
        problem "Docker is needed for the Dev container"
        fix "${pre_docker_fix:-Install and start Docker, then rerun.} Or rerun with --no-dev-container for a Host-only installation."
        failures=$((failures + 1))
      fi
    fi
    if [ "$(get_answer remote)" = tailscale ]; then
      tailscale_status=0
      check_tailscale || tailscale_status=$?
      if [ "$tailscale_status" -eq 2 ]; then
        detect
        continue
      fi
      if [ "$tailscale_status" -eq 1 ]; then failures=$((failures + 1)); fi
    fi
    break
  done
  if [ "$failures" -gt 0 ]; then
    say ""
    say "Fix the items above, then rerun the same command:"
    say "  $(rerun_command)"
    exit 1
  fi

  # Plan --------------------------------------------------------------------------------

  local projects_folder="" key_for_plan=""
  projects_folder=$(expand_path "$(get_answer projects-folder)")
  auth_key_file="$(get_answer tailscale-auth-key-file)"
  if [ "$(get_answer remote)" = tailscale ] && [ -n "$auth_key_file" ] && [ "$auth_key_file" != none ]; then
    key_for_plan="$auth_key_file"
  fi
  A_DEV="$(get_answer dev-container)" A_NAME="$(get_answer name)" A_PROJECTS="$projects_folder" \
    A_REMOTE="$(get_answer remote)" A_KEY="$key_for_plan" A_SOURCE="$source_dir" A_VERSION="$release_tag" \
    "$node_bin" -e '
      const e = process.env;
      const answers = {
        devContainer: e.A_DEV === "yes",
        name: e.A_NAME,
        projectsFolder: e.A_PROJECTS,
        remote: { mode: e.A_REMOTE },
        sourceDirectory: e.A_SOURCE,
      };
      if (e.A_KEY) answers.remote.authKeyFile = e.A_KEY;
      if (e.A_VERSION) answers.version = e.A_VERSION;
      process.stdout.write(JSON.stringify(answers, null, 2) + "\n");
    ' >"$work/answers.json" 3<&- || fail "Could not record the answers."

  run_engine plan --answers "$work/answers.json" --json >"$work/plan-output.json" 2>"$work/plan.log" ||
    fail "The installer engine could not make a plan: $(tail -n 3 "$work/plan.log")" "Fix the problem it names, then rerun."
  local plan_summary=""
  json_vars "$work/plan-output.json" plan_summary='d.summary' ||
    fail "The installer engine returned an unreadable plan." "Rerun the installer."
  "$node_bin" -e '
    const fs = require("fs");
    const output = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    fs.writeFileSync(process.argv[2], JSON.stringify(output.plan, null, 2) + "\n", { mode: 0o600 });
  ' "$work/plan-output.json" "$work/plan.json" 3<&- || fail "Could not record the plan."

  heading "Plan"
  printf '%s\n' "$plan_summary" | sed 's/^/  • /'
  say ""
  if [ -z "$interactive" ] && [ -z "$assume_yes" ] && [ -z "$(get_answer proceed)" ]; then
    pending_plan=$(printf '%s\n' "$plan_summary" | sed 's/^/VORTEO_PLAN /')$'\n'
  fi
  ask proceed yes "Proceed with this plan?"
  flush_questions
  if [ "$(get_answer proceed)" != yes ]; then
    say "Stopped before installing. The release source stays in $source_dir; nothing else changed."
    exit 4
  fi

  # Apply -------------------------------------------------------------------------------

  heading "Installing"
  if ! apply_with_progress result apply --plan "$work/plan.json"; then
    resume_hint
    exit 1
  fi
  rm -f "$work/tailscale-auth-key"
  finish
}

vorteo_install "$@" "--vorteo-script-complete"
