#!/usr/bin/env bash
# Vorteo installer for macOS and Linux.
#
#   curl -fsSL https://terranlabs.com/vorteo/install | bash
#
# It fetches the latest tested Vorteo release into ~/vorteo/source, asks a few questions,
# shows the plan, and hands the work to the installer engine in that release
# (scripts/installer/main.mjs). Rerun the same command at any time: a finished step is
# skipped, so a rerun resumes, and an existing installation is detected.
#
# Options (each question also has an environment variable; flags win):
#   --yes, -y                       Take the default answer for every question (VORTEO_YES=1).
#                                   It never answers install-node: installing system software
#                                   always needs an explicit yes.
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
# Tests only: VORTEO_TEST_TTY=<file> reads answers from that file as if typed at a terminal,
# and VORTEO_TEST_TTY=none behaves as if there were no terminal.
#
# The whole script is the function below, called on the last line with a closing marker, so
# a partial download runs nothing.

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
  local nvm_version="v0.40.3"
  local minimum_node=24

  local assume_yes="" force_agent="" want_repair="" no_open="" pinned_version="" root=""
  local interactive="" platform="" node_bin="" source_dir="" work="" existing_kind=""
  local pending_questions="" pending_plan="" release_tag="" release_commit=""
  local original_args=("$@")
  # shellcheck disable=SC2088 # A ~ shown to the owner, expanded later by expand_path.
  local auth_key_file="" tailscale_attempts=0 failures=0 projects_default="~/dev"
  # Set by json_vars from the engine's detect report.
  local existing_paths="" existing_projects="" pre_node_ok="" pre_node_fix="" pre_git_ok=""
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
      dev-container | install-node | proceed) normalize_bool "$2" ;;
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
      dev-container | install-node | proceed) printf 'yes or no' ;;
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
    if [ -n "$assume_yes" ] && [ "$id" != "install-node" ]; then
      set_answer "$id" "$default"
      return 0
    fi
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
        --proceed | --version | --root)
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
        --install-node | --proceed | --version | --root)
        case "$key" in
          version) pinned_version="$value" ;;
          root) root="$value" ;;
          dev-container | name | projects-folder | remote | tailscale-auth-key-file | \
            install-node | proceed)
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
    proceed:VORTEO_PROCEED; do
    id="${env_pair%%:*}"
    env_name="${env_pair#*:}"
    if [ -z "$(get_answer "$id")" ] && [ -n "${!env_name-}" ]; then
      option_answer "$id" "${!env_name}"
    fi
  done
  if [ -n "${VORTEO_YES-}" ] && [ "${VORTEO_YES}" != "0" ]; then assume_yes=1; fi
  if [ -n "${VORTEO_NO_OPEN-}" ] && [ "${VORTEO_NO_OPEN}" != "0" ]; then no_open=1; fi
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

  git_fix() {
    if [ "$platform" = macos ]; then
      printf 'Run: xcode-select --install'
    elif command -v apt-get >/dev/null 2>&1; then
      printf 'Run: sudo apt-get install -y git'
    elif command -v dnf >/dev/null 2>&1; then
      printf 'Run: sudo dnf install -y git'
    elif command -v pacman >/dev/null 2>&1; then
      printf 'Run: sudo pacman -S git'
    elif command -v zypper >/dev/null 2>&1; then
      printf 'Run: sudo zypper install git'
    elif command -v apk >/dev/null 2>&1; then
      printf 'Run: sudo apk add git'
    else
      printf 'Install Git with your package manager'
    fi
  }
  # macOS ships a git stub that only offers the developer tools, so run it to be sure.
  git --version >/dev/null 2>&1 || fail "Git is required to fetch the release." "$(git_fix), then rerun."

  node_major() {
    local version
    version=$("$1" --version 2>/dev/null) || return 1
    version="${version#v}"
    printf '%s' "${version%%.*}"
  }
  find_node() {
    local candidate major
    candidate=$(command -v node 2>/dev/null) || return 1
    major=$(node_major "$candidate") || return 1
    [ "$major" -ge "$minimum_node" ] 2>/dev/null || return 1
    node_bin="$candidate"
  }
  install_node() {
    if [ "$platform" = macos ] && command -v brew >/dev/null 2>&1; then
      working "Installing Node.js $minimum_node with Homebrew"
      brew install "node@$minimum_node" </dev/null 3<&- || return 1
      PATH="$(brew --prefix "node@$minimum_node")/bin:$PATH"
    else
      working "Installing nvm $nvm_version and Node.js $minimum_node"
      export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
      if [ ! -s "$NVM_DIR/nvm.sh" ]; then
        curl -fsSL "https://raw.githubusercontent.com/nvm-sh/nvm/$nvm_version/install.sh" |
          bash 3<&- || return 1
      fi
      # shellcheck disable=SC1091
      . "$NVM_DIR/nvm.sh" && nvm install "$minimum_node" </dev/null 3<&- || return 1
      PATH="$(dirname "$(nvm which "$minimum_node")"):$PATH"
    fi
    export PATH
    hash -r
  }
  if ! find_node; then
    local found_node="not installed" node_method node_fix
    if command -v node >/dev/null 2>&1; then found_node="found $(node --version 2>/dev/null)"; fi
    if [ "$platform" = macos ] && command -v brew >/dev/null 2>&1; then
      node_method="Homebrew (brew install node@$minimum_node)"
      node_fix="Run: brew install node@$minimum_node, add \$(brew --prefix node@$minimum_node)/bin to PATH, then rerun."
    else
      node_method="nvm $nvm_version, which also adds itself to your shell profile"
      node_fix="Install nvm from https://github.com/nvm-sh/nvm, run: nvm install $minimum_node, then rerun."
    fi
    ask install-node yes "Vorteo needs Node.js $minimum_node ($found_node). Install it now with $node_method?"
    flush_questions
    if [ "$(get_answer install-node)" != "yes" ]; then
      fail "Node.js $minimum_node is required." "$node_fix"
    fi
    # shellcheck disable=SC2015 # Either step failing should fail.
    install_node && find_node || fail "Node.js $minimum_node could not be installed." "$node_fix"
    ok "Installed Node.js $("$node_bin" --version)"
  fi

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

  # Run ---------------------------------------------------------------------------------

  heading "Preparing"
  # An earlier run's engine can recognize a finished installation without the network.
  if [ -f "$source_dir/scripts/installer/main.mjs" ] && detect soft; then
    if [ "$existing_kind" = current ]; then
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
      handle_current
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
      fix "${pre_git_fix:-$(git_fix)}"
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
