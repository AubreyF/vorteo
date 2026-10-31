// Tests for prerequisites.sh. Every tool the library could run is a fake on PATH that logs
// its arguments, so nothing is installed and no real sudo, brew or network is touched.
// Run with: node --test scripts/installer/prerequisites.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const library = path.join(here, "prerequisites.sh");
// /bin/bash is bash 3.2 on macOS, the oldest shell the library must support.
const bash = "/bin/bash";

// System tools the library and the fakes may use. Everything else on PATH is a fake.
const systemTools = [
  "bash",
  "sh",
  "cat",
  "sed",
  "tr",
  "mktemp",
  "rm",
  "mkdir",
  "chmod",
  "dirname",
  "sleep",
  "grep",
  "env",
  "cp",
  "touch",
  "basename",
];

const log = 'printf "%s\\n" "$(basename "$0") $*" >>"$STATE/calls.log"';

function fakeNode(version) {
  return `#!/bin/sh\necho v${version}\n`;
}

const templates = {
  git: `#!/bin/sh
${log}
[ -f "$STATE/git-installed" ] || { echo "no developer tools" >&2; exit 1; }
echo "git version 2.50.0"
`,
  docker: `#!/bin/sh
${log}
[ "$1" = info ] || exit 0
if [ -f "$STATE/docker-running" ]; then
  if [ ! -f "$STATE/docker-denied" ] || [ -n "\${FAKE_SG-}" ]; then echo ok; exit 0; fi
  echo "permission denied while trying to connect to the Docker daemon socket" >&2
  exit 1
fi
echo "Cannot connect to the Docker daemon" >&2
exit 1
`,
  tailscale: `#!/bin/sh
${log}
`,
};

const fakes = {
  uname: `#!/bin/sh\necho "$FAKE_UNAME"\n`,
  id: `#!/bin/sh
case "$1" in
  -u) echo "\${FAKE_UID:-501}" ;;
  -un) echo fakeuser ;;
  -nG)
    groups=staff
    if [ -n "\${2-}" ] && [ -f "$STATE/docker-group" ]; then groups="$groups docker"; fi
    echo "$groups"
    ;;
esac
`,
  sudo: `#!/bin/sh
${log}
if [ "$1" = -v ]; then
  [ -z "\${FAKE_SUDO_FAIL-}" ] || { echo "sudo: a terminal is required to read the password" >&2; exit 1; }
  exit 0
fi
exec "$@"
`,
  brew: `#!/bin/sh
${log}
case "$*" in
  "install node@24")
    mkdir -p "$STATE/brew-node/bin"
    printf '#!/bin/sh\\necho v24.21.0\\n' >"$STATE/brew-node/bin/node"
    chmod 755 "$STATE/brew-node/bin/node"
    ;;
  "--prefix node@24") echo "$STATE/brew-node" ;;
  "install --cask docker-desktop")
    mkdir -p "$APPS/Docker.app/Contents/Resources/bin"
    cp "$TEMPLATES/docker" "$APPS/Docker.app/Contents/Resources/bin/docker"
    ;;
  "install --cask tailscale-app") mkdir -p "$APPS/Tailscale.app" ;;
esac
`,
  "xcode-select": `#!/bin/sh
case "$1" in
  -p) [ -f "$STATE/git-installed" ] ;;
  --install)
    ${log}
    [ -n "\${FAKE_XCODE_NEVER-}" ] || touch "$STATE/git-installed"
    exit 1
    ;;
esac
`,
  open: `#!/bin/sh
${log}
case "$*" in
  "-a "*Docker.app) touch "$STATE/docker-running" ;;
  https://docs.docker.com/*)
    mkdir -p "$APPS/Docker.app/Contents/Resources/bin"
    cp "$TEMPLATES/docker" "$APPS/Docker.app/Contents/Resources/bin/docker"
    ;;
  https://tailscale.com/download/mac) mkdir -p "$APPS/Tailscale.app" ;;
esac
`,
  curl: `#!/bin/sh
${log}
out=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift ;;
    -*) ;;
    *) url="$1" ;;
  esac
  shift
done
case "$url" in
  https://get.docker.com)
    printf '#!/bin/sh\\necho "get-docker.sh" >>"$STATE/calls.log"\\ncp "$TEMPLATES/docker" "$LATE/docker"\\n' >"$out"
    ;;
  https://tailscale.com/install.sh)
    printf '#!/bin/sh\\necho "tailscale-install.sh" >>"$STATE/calls.log"\\ncp "$TEMPLATES/tailscale" "$LATE/tailscale"\\n' >"$out"
    ;;
  https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh)
    cat >"$out" <<'NVM'
echo "nvm-install.sh" >>"$STATE/calls.log"
mkdir -p "$NVM_DIR"
cat >"$NVM_DIR/nvm.sh" <<'SH'
nvm() {
  echo "nvm $*" >>"$STATE/calls.log"
  case "$1" in
    install)
      mkdir -p "$NVM_DIR/versions/node/v24.21.0/bin"
      printf '#!/bin/sh\\necho v24.21.0\\n' >"$NVM_DIR/versions/node/v24.21.0/bin/node"
      chmod 755 "$NVM_DIR/versions/node/v24.21.0/bin/node"
      ;;
    which) echo "$NVM_DIR/versions/node/v24.21.0/bin/node" ;;
  esac
}
SH
NVM
    ;;
  *) exit 22 ;;
esac
`,
  systemctl: `#!/bin/sh
${log}
[ "$*" != "enable --now docker" ] || touch "$STATE/docker-running"
`,
  usermod: `#!/bin/sh
${log}
touch "$STATE/docker-group"
`,
  sg: `#!/bin/sh
${log}
[ -f "$STATE/docker-group" ] || exit 1
FAKE_SG=1 exec sh -c "$3"
`,
};

const packageManagerFake = `#!/bin/sh
${log}
case " $* " in
  *" git "*)
    cp "$TEMPLATES/git" "$LATE/git"
    touch "$STATE/git-installed"
    ;;
esac
`;

function writeExecutable(file, content) {
  writeFileSync(file, content);
  chmodSync(file, 0o755);
}

function findSystemTool(name) {
  for (const dir of ["/bin", "/usr/bin"]) {
    const candidate = path.join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`Missing system tool ${name}`);
}

/**
 * Puts the tools the test machine starts with in place.
 * options.packageManager: a Linux package manager to fake. options.node: a version on PATH.
 * options.git: "stub" (present, not working), "ok", or absent. options.docker: "running",
 * "stopped", "denied" or absent. options.tailscale: true to put it on PATH.
 */
function installStartingTools(dirs, options) {
  if (options.packageManager) {
    writeExecutable(path.join(dirs.fake, options.packageManager), packageManagerFake);
  }
  if (options.node) writeExecutable(path.join(dirs.late, "node"), fakeNode(options.node));
  if (options.git) writeExecutable(path.join(dirs.late, "git"), templates.git);
  if (options.git === "ok") writeFileSync(path.join(dirs.state, "git-installed"), "");
  if (options.docker) {
    writeExecutable(path.join(dirs.late, "docker"), templates.docker);
    if (options.docker !== "stopped") writeFileSync(path.join(dirs.state, "docker-running"), "");
    if (options.docker === "denied") writeFileSync(path.join(dirs.state, "docker-denied"), "");
  }
  if (options.tailscale) writeExecutable(path.join(dirs.late, "tailscale"), templates.tailscale);
  options.setup?.(dirs);
}

/**
 * Builds a fake machine and runs vorteo_ensure_prerequisites in it. options.platform is
 * "Darwin" (default) or "Linux"; options.brew puts brew on PATH; options.answers is shell
 * run before the call; options.tty is typed input; options.env adds variables.
 */
function run(t, args, options = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "vorteo-prereq-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dirs = {};
  for (const name of ["fake", "late", "safe", "state", "templates", "apps", "home", "work"]) {
    dirs[name] = path.join(root, name);
    mkdirSync(dirs[name]);
  }
  for (const tool of systemTools) symlinkSync(findSystemTool(tool), path.join(dirs.safe, tool));
  for (const [name, content] of Object.entries(fakes)) {
    if (name === "brew" && !options.brew) continue;
    writeExecutable(path.join(dirs.fake, name), content);
  }
  for (const [name, content] of Object.entries(templates)) {
    writeExecutable(path.join(dirs.templates, name), content);
  }
  installStartingTools(dirs, options);

  const driver = path.join(root, "driver.sh");
  writeFileSync(
    driver,
    `if [ -n "\${TTY_FILE-}" ]; then exec 3<"$TTY_FILE"; fi
${options.answers ?? ""}
. "$1"
shift
vorteo_ensure_prerequisites "$@"
status=$?
echo "NODE_BIN=\${VORTEO_NODE_BIN-}" >&2
echo "PATH_AFTER=$PATH" >&2
exit "$status"
`,
  );
  let ttyFile = "";
  if (options.tty !== undefined) {
    ttyFile = path.join(root, "tty");
    writeFileSync(ttyFile, options.tty);
  }
  const env = {
    PATH: [dirs.fake, dirs.late, dirs.safe].join(":"),
    HOME: dirs.home,
    TMPDIR: dirs.work,
    STATE: dirs.state,
    TEMPLATES: dirs.templates,
    LATE: dirs.late,
    APPS: dirs.apps,
    TTY_FILE: ttyFile,
    FAKE_UNAME: options.platform ?? "Darwin",
    VORTEO_PREREQ_APPLICATIONS: dirs.apps,
    VORTEO_PREREQ_POLL_SECONDS: "0",
    VORTEO_PREREQ_WAIT_SECONDS: "0",
    ...options.env,
  };
  const result = spawnSync(bash, [driver, library, ...args], {
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logFile = path.join(dirs.state, "calls.log");
  const calls = existsSync(logFile) ? readFileSync(logFile, "utf8").trim().split("\n") : [];
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, calls, dirs };
}

function questions(stdout) {
  const block = stdout.split("VORTEO_QUESTIONS_BEGIN\n")[1]?.split("VORTEO_QUESTIONS_END")[0];
  assert.ok(block !== undefined, `no question block in:\n${stdout}`);
  return block
    .trim()
    .split("\n")
    .map((line) => {
      const [, id, fallback, ...text] = line.split(" ");
      return { id, fallback, text: text.join(" ") };
    });
}

function assertCalled(calls, expected) {
  assert.ok(calls.includes(expected), `expected call "${expected}" in:\n${calls.join("\n")}`);
}

function assertNoInstalls(calls) {
  const installs = calls.filter((call) =>
    /^(brew install|xcode-select --install|apt-get|sudo|curl|open|systemctl|usermod)/.test(call),
  );
  assert.deepEqual(installs, []);
}

const allTools = ["node", "git", "docker", "tailscale"];

test("does nothing when every tool is ready", (t) => {
  const result = run(t, allTools, {
    brew: true,
    node: "24.21.0",
    git: "ok",
    docker: "running",
    tailscale: true,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stdout, "");
  assertNoInstalls(result.calls);
  assert.match(result.stderr, /NODE_BIN=.*\/late\/node/);
});

test("macOS agent mode prints every question once and exits 3 before installing", (t) => {
  const result = run(t, allTools, { brew: true, node: "20.11.0", git: "stub" });
  assert.equal(result.status, 3, result.stdout + result.stderr);
  assert.deepEqual(
    questions(result.stdout).map((q) => [q.id, q.fallback]),
    [
      ["install-git", "yes"],
      ["install-node", "yes"],
      ["install-docker", "yes"],
      ["install-tailscale", "yes"],
    ],
  );
  const text = Object.fromEntries(questions(result.stdout).map((q) => [q.id, q.text]));
  assert.match(text["install-node"], /Node\.js 24 \(found v20\.11\.0\).*Homebrew/);
  assert.match(text["install-docker"], /administrator password/);
  assert.match(result.stdout, /Docker Desktop is free for personal use/);
  assert.match(result.stdout, /rerun with --<id>=<answer>/);
  assertNoInstalls(result.calls);
});

test("macOS with Homebrew installs everything after yes answers", (t) => {
  const result = run(t, allTools, {
    brew: true,
    node: "20.11.0",
    git: "stub",
    answers: "answer_install_git=yes answer_install_node=yes",
    env: { VORTEO_INSTALL_DOCKER: "yes", VORTEO_INSTALL_TAILSCALE: "y" },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assertCalled(result.calls, "xcode-select --install");
  assertCalled(result.calls, "brew install node@24");
  assertCalled(result.calls, "brew install --cask docker-desktop");
  assertCalled(result.calls, `open -a ${result.dirs.apps}/Docker.app`);
  assertCalled(result.calls, "brew install --cask tailscale-app");
  assertCalled(result.calls, `open -a ${result.dirs.apps}/Tailscale.app`);
  assert.ok(!result.calls.some((call) => call.startsWith("sudo")));
  assert.match(result.stdout, /dialog/);
  assert.match(result.stderr, /NODE_BIN=.*brew-node\/bin\/node/);
  // Docker Desktop's own docker command joins PATH until Docker links it.
  assert.match(result.stderr, /PATH_AFTER=.*Docker\.app\/Contents\/Resources\/bin/);
  for (const tool of ["Git", "Node.js 24", "Docker", "Tailscale"]) {
    assert.match(result.stdout, new RegExp(`✓ ${tool} is ready`));
  }
});

test("macOS Git waits for the Command Line Tools and fails with a fix when they never arrive", (t) => {
  const result = run(t, ["git"], {
    git: "stub",
    env: { VORTEO_INSTALL_GIT: "yes", FAKE_XCODE_NEVER: "1" },
  });
  assert.equal(result.status, 1);
  assertCalled(result.calls, "xcode-select --install");
  assert.match(result.stdout, /Waiting for Git to work/);
  assert.match(result.stdout, /Fix: Run: xcode-select --install, finish the dialog, then rerun\./);
});

test("macOS without Homebrew uses nvm and the download pages", (t) => {
  const result = run(t, ["node", "docker", "tailscale"], {
    env: {
      VORTEO_INSTALL_NODE: "yes",
      VORTEO_INSTALL_DOCKER: "yes",
      VORTEO_INSTALL_TAILSCALE: "yes",
    },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assertCalled(
    result.calls,
    "curl -fsSL --retry 2 -o " +
      result.calls.find((c) => c.includes("nvm-install.sh")).split(" -o ")[1],
  );
  assertCalled(result.calls, "nvm-install.sh");
  assertCalled(result.calls, "nvm install 24");
  assert.match(
    result.stdout,
    /Downloading https:\/\/raw\.githubusercontent\.com\/nvm-sh\/nvm\/v0\.40\.3\/install\.sh/,
  );
  assert.match(result.stdout, /Saved it to .*nvm-install\.sh and running it now/);
  assertCalled(result.calls, "open https://docs.docker.com/desktop/setup/install/mac-install/");
  assertCalled(result.calls, `open -a ${result.dirs.apps}/Docker.app`);
  assertCalled(result.calls, "open https://tailscale.com/download/mac");
  assert.match(result.stderr, /NODE_BIN=.*\.nvm\/versions\/node\/v24\.21\.0\/bin\/node/);
});

test("macOS starts an installed Docker Desktop without a question and waits for it", (t) => {
  const result = run(t, ["docker"], {
    setup(dirs) {
      const bin = path.join(dirs.apps, "Docker.app/Contents/Resources/bin");
      mkdirSync(bin, { recursive: true });
      writeExecutable(path.join(bin, "docker"), templates.docker);
    },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /VORTEO_QUESTION/);
  assert.match(result.stdout, /Docker \(installed but not running\)/);
  assertCalled(result.calls, `open -a ${result.dirs.apps}/Docker.app`);
  assert.ok(!result.calls.some((c) => c.startsWith("brew")));
});

test("Linux agent mode says which questions need the administrator password", (t) => {
  const result = run(t, allTools, { platform: "Linux", packageManager: "apt-get" });
  assert.equal(result.status, 3, result.stdout + result.stderr);
  const text = Object.fromEntries(questions(result.stdout).map((q) => [q.id, q.text]));
  assert.deepEqual(Object.keys(text), [
    "install-git",
    "install-node",
    "install-docker",
    "install-tailscale",
  ]);
  for (const id of ["install-git", "install-docker", "install-tailscale"]) {
    assert.match(text[id], /sudo, which asks for your administrator password/);
  }
  assert.doesNotMatch(text["install-node"], /password/);
  assert.match(text["install-node"], /nvm v0\.40\.3/);
  assert.match(text["install-git"], /apt-get/);
  assert.match(
    result.stdout,
    /It runs: sudo apt-get update; sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y git\n/,
  );
  assertNoInstalls(result.calls);
});

test("Linux installs Git, Docker and Tailscale with sudo after yes answers", (t) => {
  const result = run(t, ["git", "docker", "tailscale"], {
    platform: "Linux",
    packageManager: "apt-get",
    env: {
      VORTEO_INSTALL_GIT: "yes",
      VORTEO_INSTALL_DOCKER: "yes",
      VORTEO_INSTALL_TAILSCALE: "yes",
    },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assertCalled(result.calls, "sudo -v");
  assertCalled(result.calls, "sudo apt-get update");
  assertCalled(result.calls, "sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y git");
  assertCalled(
    result.calls,
    "curl -fsSL --retry 2 -o " + downloaded(result, "get-docker.sh") + " https://get.docker.com",
  );
  assertCalled(result.calls, `sudo sh ${downloaded(result, "get-docker.sh")}`);
  assertCalled(result.calls, "get-docker.sh");
  assertCalled(result.calls, "sudo systemctl enable --now docker");
  assertCalled(result.calls, "sudo usermod -aG docker fakeuser");
  assertCalled(result.calls, `sudo sh ${downloaded(result, "tailscale-install.sh")}`);
  assert.match(result.stdout, /Downloading https:\/\/get\.docker\.com/);
  assert.match(result.stdout, /Downloading https:\/\/tailscale\.com\/install\.sh/);
  assert.match(result.stdout, /sudo asks for your administrator password now/);
  assert.match(result.stdout, /run sudo tailscale up --operator=fakeuser/);
  // sudo asks once, before the first command that needs root.
  assert.equal(result.calls.filter((c) => c === "sudo -v").length, 1);
  assert.ok(result.calls.indexOf("sudo -v") < result.calls.indexOf("sudo apt-get update"));
});

function downloaded(result, name) {
  const call = result.calls.find((c) => c.startsWith("curl ") && c.includes(name));
  assert.ok(call, `no download of ${name}`);
  return call.split(" -o ")[1].split(" ")[0];
}

test("Linux continues through sg docker when the new group is not active yet", (t) => {
  const result = run(t, ["docker"], {
    platform: "Linux",
    packageManager: "apt-get",
    docker: "denied",
    env: { VORTEO_START_DOCKER: "yes" },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(!result.calls.some((c) => c.includes("get.docker.com")), "Docker is already installed");
  assertCalled(result.calls, "sudo systemctl enable --now docker");
  assertCalled(result.calls, "sudo usermod -aG docker fakeuser");
  assert.match(result.stdout, /newgrp docker/);
  const shimDir = /PATH_AFTER=([^:]*docker-group)/.exec(result.stderr)?.[1];
  assert.ok(shimDir, result.stderr);
  // The shim runs docker through sg with each argument quoted for sh.
  const shim = spawnSync(path.join(shimDir, "docker"), ["info", "it's"], {
    env: {
      PATH: [result.dirs.fake, result.dirs.late, result.dirs.safe].join(":"),
      STATE: result.dirs.state,
    },
    encoding: "utf8",
  });
  assert.equal(shim.status, 0, shim.stderr);
  const calls = readFileSync(path.join(result.dirs.state, "calls.log"), "utf8");
  assert.match(calls, /docker info it's\n/);
});

test("Linux asks start-docker when Docker is installed but stopped", (t) => {
  const result = run(t, ["docker"], { platform: "Linux", docker: "stopped" });
  assert.equal(result.status, 3);
  const [question] = questions(result.stdout);
  assert.equal(question.id, "start-docker");
  assert.match(
    question.text,
    /not running.*add fakeuser to the docker group.*administrator password/,
  );
});

test("Linux as root runs installs without sudo and without the password note", (t) => {
  const result = run(t, ["git", "docker"], {
    platform: "Linux",
    packageManager: "apt-get",
    env: { FAKE_UID: "0" },
  });
  assert.equal(result.status, 3);
  for (const q of questions(result.stdout)) assert.doesNotMatch(q.text, /password/);
  const yes = run(t, ["git", "docker"], {
    platform: "Linux",
    packageManager: "apt-get",
    env: { FAKE_UID: "0", VORTEO_INSTALL_GIT: "yes", VORTEO_INSTALL_DOCKER: "yes" },
  });
  assert.equal(yes.status, 0, yes.stdout + yes.stderr);
  assert.ok(!yes.calls.some((c) => c.startsWith("sudo")));
  assertCalled(yes.calls, "apt-get update");
  assertCalled(yes.calls, "systemctl enable --now docker");
  assert.ok(!yes.calls.some((c) => c.startsWith("usermod")), "root needs no docker group");
});

test("Linux signs Tailscale in with the auth key file", (t) => {
  const result = run(t, ["tailscale"], {
    platform: "Linux",
    answers: 'answer_tailscale_auth_key_file="$STATE/key"; : >"$STATE/key"',
    env: { VORTEO_INSTALL_TAILSCALE: "yes" },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assertCalled(
    result.calls,
    `sudo tailscale up --auth-key=file:${result.dirs.state}/key --operator=fakeuser`,
  );
  assert.ok(!result.stdout.includes("tskey"));
});

for (const [manager, commands] of [
  ["dnf", ["sudo dnf install -y git"]],
  ["yum", ["sudo yum install -y git"]],
  ["pacman", ["sudo pacman -S --needed --noconfirm git"]],
  ["zypper", ["sudo zypper --non-interactive install git"]],
  ["apk", ["sudo apk add git"]],
]) {
  test(`Linux installs Git with ${manager}`, (t) => {
    const result = run(t, ["git"], {
      platform: "Linux",
      packageManager: manager,
      env: { VORTEO_INSTALL_GIT: "yes" },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    for (const command of commands) assertCalled(result.calls, command);
  });
}

test("a declined install fails with the manual fix and installs nothing", (t) => {
  const result = run(t, ["git", "docker"], {
    platform: "Linux",
    packageManager: "apt-get",
    env: { VORTEO_INSTALL_GIT: "no", VORTEO_INSTALL_DOCKER: "no" },
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Git is required and was not installed/);
  assert.match(
    result.stdout,
    /Fix: Run: sudo apt-get update && sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y git, then rerun\./,
  );
  assert.match(result.stdout, /--no-dev-container/);
  assertNoInstalls(result.calls);
});

test("without a password for sudo nothing runs and the commands are named", (t) => {
  const result = run(t, ["git"], {
    platform: "Linux",
    packageManager: "apt-get",
    env: { VORTEO_INSTALL_GIT: "yes", FAKE_SUDO_FAIL: "1" },
  });
  assert.equal(result.status, 1);
  assertCalled(result.calls, "sudo -v");
  assert.ok(!result.calls.some((c) => c.startsWith("apt-get")));
  assert.match(result.stdout, /run the commands below in a terminal/);
  assert.match(result.stdout, /Fix: Run: sudo apt-get update/);
});

test("interactive mode asks on the terminal and an empty answer means yes", (t) => {
  const result = run(t, ["--interactive", "git", "docker"], {
    platform: "Linux",
    packageManager: "apt-get",
    tty: "\nmaybe\nno\n",
  });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /Vorteo needs Git\. Install it with apt-get\?.*\[yes\]/);
  assert.match(result.stdout, /Please answer yes or no\./);
  assertCalled(result.calls, "sudo apt-get update");
  assert.ok(!result.calls.some((c) => c.includes("get.docker.com")));
  assert.doesNotMatch(result.stdout, /VORTEO_QUESTIONS_BEGIN/);
});

test("--skip reports missing tools without asking or installing", (t) => {
  const result = run(t, ["--skip", "node", "git"], { platform: "Linux", packageManager: "dnf" });
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stdout, /VORTEO_QUESTION/);
  assert.match(result.stdout, /Fix: Run: sudo dnf install -y git, then rerun\./);
  assert.match(result.stdout, /nvm install 24/);
  assertNoInstalls(result.calls);
  const fromEnv = run(t, ["git"], { platform: "Linux", env: { VORTEO_SKIP_PREREQUISITES: "1" } });
  assert.equal(fromEnv.status, 1);
  assert.match(fromEnv.stdout, /skipped/);
});

test("an invalid answer or tool name returns 2", (t) => {
  const bad = run(t, ["git"], { platform: "Linux", env: { VORTEO_INSTALL_GIT: "maybe" } });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /Invalid value for --install-git: maybe/);
  assert.equal(run(t, ["python"], {}).status, 2);
});

test("downloaded scripts are never piped into a shell", () => {
  const source = readFileSync(library, "utf8");
  assert.doesNotMatch(source, /curl[^\n]*\|\s*(ba)?sh/);
  assert.doesNotMatch(source, /\u2014|\u2013/);
});
