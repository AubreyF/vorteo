// Runs install.sh end to end against fakes: a fake installer engine behind a `node` shim,
// and fake git, curl, browser and clipboard commands on PATH. Prompts come from a file
// through VORTEO_TEST_TTY, so no pseudo terminal is needed.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const installScript = path.join(repoRoot, "install.sh");
const bash = "/bin/bash";
const releaseSha = "1111111111111111111111111111111111111111";
const password = "owner-password-not-for-output";
const sandboxes = [];

after(() => {
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
});

const fakeEngine = String.raw`
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
const [command, ...rest] = process.argv.slice(2);
const option = (name) => { const i = rest.indexOf(name); return i === -1 ? undefined : rest[i + 1]; };
const root = option("--root");
appendFileSync(process.env.FAKE_LOG, JSON.stringify({ tool: "engine", argv: [command, ...rest] }) + "\n");
const emit = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const tailscale = {
  ok: { ok: true, running: true, loggedIn: true },
  missing: { ok: false, running: false, loggedIn: false, fix: "Install Tailscale from https://tailscale.com/download." },
  "logged-out": { ok: true, running: true, loggedIn: false, fix: "Run: tailscale up" },
}[process.env.FAKE_TAILSCALE || "ok"];
const docker = process.env.FAKE_DOCKER === "missing"
  ? { ok: false, running: false, fix: "Install Docker Desktop and start it." }
  : { ok: true, running: true };
const origin = (answers) => answers.remote.mode === "tailscale" ? "https://vorteo.example.ts.net" : "http://localhost:6790";
if (command === "detect") {
  const kind = process.env.FAKE_EXISTING || "none";
  emit({
    platform: process.platform,
    existing: { kind, paths: kind.startsWith("legacy") ? { deployment: "/srv/old-vorteo", projectsFolder: path.join(process.env.HOME, "work") } : {} },
    prerequisites: { node: { ok: true, version: "v24.18.0" }, git: { ok: true }, docker, tailscale },
  });
} else if (command === "plan") {
  const answers = JSON.parse(readFileSync(option("--answers"), "utf8"));
  writeFileSync(process.env.FAKE_ANSWERS, JSON.stringify(answers));
  emit({ plan: { answers }, summary: ["Create " + root, "Install the Host and coordinator"] });
} else if (command === "apply") {
  const { answers } = JSON.parse(readFileSync(option("--plan"), "utf8"));
  const resumed = process.env.FAKE_RESUMED === "1";
  emit({ step: "identity", status: resumed ? "skip" : "start", message: "Creating the installation identity" });
  if (!resumed) emit({ step: "identity", status: "done", message: "Created the installation identity" });
  console.log("plain engine output");
  emit({ step: "host", status: "start", message: "Starting the Host" });
  if (process.env.FAKE_APPLY === "fail") {
    emit({ step: "host", status: "fail", message: "Starting the Host failed", fix: "Free port 6790, then rerun." });
    process.exit(1);
  }
  emit({ step: "host", status: "done", message: "Started the Host" });
  mkdirSync(path.join(root, "host"), { recursive: true });
  const passwordFile = path.join(root, "host", "owner-password");
  writeFileSync(passwordFile, process.env.FAKE_PASSWORD + "\n", { mode: 0o600 });
  emit({ result: { origin: origin(answers), localOrigin: "http://localhost:6790", passwordFile, name: answers.name } });
} else if (command === "status") {
  emit({ origin: "https://vorteo.example.ts.net", localOrigin: "http://localhost:6790" });
} else if (command === "repair") {
  emit({ step: "services", status: "done", message: "Checked the services" });
}
`;

function fakeScripts(realNode) {
  const log = (tool) =>
    `printf '{"tool":"${tool}","argv":%s}\\n' "$(printf '%s\\n' "$@" | "${realNode}" -e 'let t="";process.stdin.on("data",c=>t+=c).on("end",()=>process.stdout.write(JSON.stringify(t.split("\\n").slice(0,-1))))')" >>"$FAKE_LOG"`;
  return {
    node: `#!/bin/bash
case "$1" in
  --version) echo "\${FAKE_NODE_VERSION:-v24.18.0}"; exit 0 ;;
  */scripts/installer/main.mjs) shift; exec "${realNode}" "$FAKE_ENGINE" "$@" ;;
esac
exec "${realNode}" "$@"
`,
    git: `#!/bin/bash
${log("git")}
dir=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -c) shift 2 ;;
    -C) dir="$2"; shift 2 ;;
    *) break ;;
  esac
done
case "$1" in
  --version) echo "git version 2.50.0" ;;
  clone)
    target="\${@: -1}"
    mkdir -p "$target/.git" "$target/scripts/installer"
    echo "\${FAKE_CLONE_SHA:-$FAKE_SHA}" >"$target/.git/HEAD"
    echo "// fake engine placeholder" >"$target/scripts/installer/main.mjs"
    for file in qr.mjs progress.mjs vorteo.sh; do cp "$FAKE_REPO/scripts/installer/$file" "$target/scripts/installer/$file"; done
    cp "$FAKE_REPO/scripts/is-main-module.mjs" "$target/scripts/is-main-module.mjs"
    ;;
  rev-parse) cat "$dir/.git/HEAD" ;;
  status) ;;
  fetch) ;;
  checkout) echo "$FAKE_SHA" >"$dir/.git/HEAD" ;;
  *) exit 1 ;;
esac
`,
    curl: `#!/bin/bash
${log("curl")}
url="\${@: -1}"
if [ -n "$FAKE_CURL_FAIL" ]; then exit 22; fi
case "$url" in
  */releases/latest) echo '{"tag_name":"v9.9.9","target_commitish":"main"}' ;;
  */releases/tags/*) echo "{\\"tag_name\\":\\"\${url##*/}\\",\\"target_commitish\\":\\"$FAKE_SHA\\"}" ;;
  */commits/*) printf '%s' "$FAKE_SHA" ;;
  *) exit 22 ;;
esac
`,
    open: `#!/bin/bash\n${log("open")}\n`,
    "xdg-open": `#!/bin/bash\n${log("open")}\n`,
    pbcopy: `#!/bin/bash\ncat >"$FAKE_CLIPBOARD"\n`,
    xclip: `#!/bin/bash\ncat >"$FAKE_CLIPBOARD"\n`,
    tput: `#!/bin/bash\necho 100\n`,
  };
}

/** Creates an isolated HOME, fake commands and logs. */
function sandbox() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "vorteo-install-sh-"));
  sandboxes.push(dir);
  const home = path.join(dir, "home");
  const bin = path.join(dir, "bin");
  mkdirSync(home);
  mkdirSync(bin);
  for (const [name, body] of Object.entries(fakeScripts(process.execPath))) {
    writeFileSync(path.join(bin, name), body);
    chmodSync(path.join(bin, name), 0o755);
  }
  writeFileSync(path.join(dir, "engine.mjs"), fakeEngine);
  const files = {
    dir,
    home,
    bin,
    log: path.join(dir, "log.jsonl"),
    answers: path.join(dir, "answers.json"),
    clipboard: path.join(dir, "clipboard"),
    tty: path.join(dir, "tty"),
  };
  const env = {
    HOME: home,
    PATH: `${bin}:/usr/bin:/bin`,
    TMPDIR: dir,
    TERM: "dumb",
    DISPLAY: ":0",
    FAKE_LOG: files.log,
    FAKE_ENGINE: path.join(dir, "engine.mjs"),
    FAKE_ANSWERS: files.answers,
    FAKE_CLIPBOARD: files.clipboard,
    FAKE_PASSWORD: password,
    FAKE_REPO: repoRoot,
    FAKE_SHA: releaseSha,
    VORTEO_TEST_TTY: "none",
  };
  const run = (args = [], extraEnv = {}, { script = installScript, stdin } = {}) => {
    const result = spawnSync(
      bash,
      stdin === undefined ? [script, ...args] : ["-s", "--", ...args],
      {
        env: { ...env, ...extraEnv },
        encoding: "utf8",
        input: stdin,
        timeout: 60_000,
      },
    );
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  };
  const calls = () =>
    existsSync(files.log)
      ? readFileSync(files.log, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
      : [];
  const answers = () => JSON.parse(readFileSync(files.answers, "utf8"));
  return { ...files, env, run, calls, answers };
}

function questionIds(stdout) {
  return [...stdout.matchAll(/^VORTEO_QUESTION (\S+) (\S+) /gm)].map((match) => [
    match[1],
    match[2],
  ]);
}

describe("install.sh", () => {
  test("passes bash -n under the system bash", () => {
    const result = spawnSync(bash, ["-n", installScript], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const command = spawnSync(bash, ["-n", path.join(repoRoot, "scripts/installer/vorteo.sh")]);
    assert.equal(command.status, 0);
  });

  test("passes shellcheck when it is installed", (t) => {
    const probe = spawnSync("shellcheck", ["--version"]);
    if (probe.error) {
      t.skip("shellcheck is not installed");
      return;
    }
    const result = spawnSync(
      "shellcheck",
      ["--shell=bash", installScript, path.join(repoRoot, "scripts/installer/vorteo.sh")],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stdout);
  });

  test("a truncated download runs nothing", () => {
    const box = sandbox();
    const full = readFileSync(installScript, "utf8");
    const lastLineStart = full.lastIndexOf("\n", full.length - 2) + 1;
    // Every line boundary, then every byte of the last line short of its closing quote.
    const cuts = [];
    for (let i = full.indexOf("\n"); i !== -1 && i < lastLineStart; i = full.indexOf("\n", i + 1)) {
      cuts.push(i + 1);
    }
    for (let i = lastLineStart; i < full.length - 2; i++) cuts.push(i);
    for (const [index, cut] of cuts.entries()) {
      // Half the cuts arrive through stdin, as with curl | bash.
      const piped = index % 2 === 0;
      const truncated = path.join(box.dir, "truncated.sh");
      writeFileSync(truncated, full.slice(0, cut));
      const result = box.run(
        ["--yes"],
        {},
        piped ? { stdin: full.slice(0, cut) } : { script: truncated },
      );
      assert.deepEqual(box.calls(), [], `cut at byte ${cut} ran a command`);
      assert.deepEqual(readdirSync(box.home), [], `cut at byte ${cut} wrote to HOME`);
      assert.doesNotMatch(result.stdout, /Vorteo installer/, `cut at byte ${cut} started`);
    }
  });

  test("agent mode prints the unanswered questions and exits 3", () => {
    const box = sandbox();
    const result = box.run();
    assert.equal(result.status, 3, result.stderr);
    assert.match(result.stdout, /^VORTEO_QUESTIONS_BEGIN$/m);
    assert.match(result.stdout, /^VORTEO_QUESTIONS_END$/m);
    assert.deepEqual(questionIds(result.stdout), [
      ["dev-container", "yes"],
      ["name", "Vorteo"],
      ["projects-folder", "~/dev"],
      ["remote", "tailscale"],
    ]);
    assert.equal(
      box.calls().some((call) => call.tool === "engine" && call.argv[0] === "plan"),
      false,
    );
  });

  test("agent mode asks to approve the plan, then installs with the answers", () => {
    const box = sandbox();
    const answers = [
      "--dev-container=no",
      "--name",
      "Lab Two",
      "--projects-folder=~/code",
      "--remote=local",
    ];
    const asked = box.run(answers);
    assert.equal(asked.status, 3, asked.stderr);
    assert.deepEqual(questionIds(asked.stdout), [["proceed", "yes"]]);
    assert.match(asked.stdout, /^VORTEO_PLAN Install the Host and coordinator$/m);
    assert.equal(
      box.calls().some((call) => call.tool === "engine" && call.argv[0] === "apply"),
      false,
    );

    const done = box.run([...answers, "--proceed=yes"]);
    assert.equal(done.status, 0, done.stdout + done.stderr);
    assert.deepEqual(box.answers(), {
      devContainer: false,
      name: "Lab Two",
      projectsFolder: path.join(box.home, "code"),
      remote: { mode: "local" },
      sourceDirectory: path.join(box.home, "vorteo", "source"),
      version: "v9.9.9",
    });
    assert.match(done.stdout, /^VORTEO_RESULT origin http:\/\/localhost:6790$/m);
  });

  test("--yes installs with every default and finishes", () => {
    const box = sandbox();
    const result = box.run(["--yes"]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(box.answers(), {
      devContainer: true,
      name: "Vorteo",
      projectsFolder: path.join(box.home, "dev"),
      remote: { mode: "tailscale" },
      sourceDirectory: path.join(box.home, "vorteo", "source"),
      version: "v9.9.9",
    });
    assert.match(result.stdout, /✓ Created the installation identity/);
    assert.match(result.stdout, /✓ Started the Host/);
    assert.match(result.stdout, /^ {4}plain engine output$/m);
    assert.match(result.stdout, /^VORTEO_RESULT origin https:\/\/vorteo\.example\.ts\.net$/m);
    const passwordFile = path.join(box.home, "vorteo", "host", "owner-password");
    assert.match(result.stdout, new RegExp(`^VORTEO_RESULT password-file ${passwordFile}$`, "m"));
    assert.equal(readFileSync(box.clipboard, "utf8"), password);
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(password));
    assert.match(result.stdout, /copied to your clipboard/);
    // Agent mode has no terminal to show a QR code on.
    assert.doesNotMatch(result.stdout, /Scan to open/);

    const opened = box.calls().filter((call) => call.tool === "open");
    assert.deepEqual(
      opened.map((call) => call.argv),
      [["https://vorteo.example.ts.net"]],
    );
    const clone = box.calls().find((call) => call.tool === "git" && call.argv.includes("clone"));
    assert.ok(clone.argv.includes("--branch") && clone.argv.includes("v9.9.9"));
    assert.ok(clone.argv.includes("https://github.com/terran-labs/vorteo.git"));

    const shim = path.join(box.home, ".local", "bin", "vorteo");
    assert.match(readFileSync(shim, "utf8"), /vorteo-command-shim/);
    assert.match(result.stdout, /is not on your PATH/);
    const status = spawnSync(bash, [shim, "status", "--json"], { env: box.env, encoding: "utf8" });
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /vorteo\.example\.ts\.net/);
  });

  test("interactive answers come from the terminal and the finish shows a QR code", () => {
    const box = sandbox();
    writeFileSync(box.tty, "no\nMy Lab\n~/code\ntailscale\n\n");
    const result = box.run(["--no-open"], { VORTEO_TEST_TTY: box.tty });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(box.answers().devContainer, false);
    assert.equal(box.answers().name, "My Lab");
    assert.equal(box.answers().projectsFolder, path.join(box.home, "code"));
    assert.match(result.stdout, /Proceed with this plan\?/);
    assert.match(result.stdout, /Scan to open Vorteo on your phone/);
    assert.match(result.stdout, /▀/);
    assert.equal(
      box.calls().some((call) => call.tool === "open"),
      false,
    );
  });

  test("an invalid typed answer is asked again", () => {
    const box = sandbox();
    writeFileSync(box.tty, "maybe\nno\n\n\nlocal\nyes\n");
    const result = box.run(["--no-open"], { VORTEO_TEST_TTY: box.tty });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /Please answer yes or no/);
    assert.equal(box.answers().devContainer, false);
  });

  test("declining the plan stops before installing", () => {
    const box = sandbox();
    const result = box.run(["--yes", "--proceed=no"]);
    assert.equal(result.status, 4);
    assert.equal(
      box.calls().some((call) => call.tool === "engine" && call.argv[0] === "apply"),
      false,
    );
  });

  test("a failed step shows its fix and how to resume, and a rerun resumes", () => {
    const box = sandbox();
    const failed = box.run(["--yes"], { FAKE_APPLY: "fail" });
    assert.equal(failed.status, 1);
    assert.match(failed.stdout, /✗ Starting the Host failed/);
    assert.match(failed.stdout, /Fix: Free port 6790, then rerun\./);
    assert.match(failed.stdout, /rerun the same command to resume/);
    assert.match(failed.stdout, /install\.sh --yes$/m);

    const resumed = box.run(["--yes"], { FAKE_RESUMED: "1" });
    assert.equal(resumed.status, 0, resumed.stdout + resumed.stderr);
    assert.match(resumed.stdout, /already in .*vorteo\/source/);
    assert.match(resumed.stdout, /· Creating the installation identity \(skipped\)/);
    const clones = box.calls().filter((call) => call.tool === "git" && call.argv.includes("clone"));
    assert.equal(clones.length, 1);
  });

  test("the resume command keeps options for curl | bash", () => {
    const box = sandbox();
    const script = readFileSync(installScript, "utf8");
    const failed = box.run(
      ["--yes", "--name", "Two Words"],
      { FAKE_APPLY: "fail" },
      { stdin: script },
    );
    assert.equal(failed.status, 1);
    assert.match(
      failed.stdout,
      /curl -fsSL https:\/\/terranlabs\.com\/vorteo\/install \| bash -s -- --yes --name Two\\ Words$/m,
    );
  });

  test("a legacy deployment is wrapped and keeps its Dev environment", () => {
    const box = sandbox();
    const result = box.run([], { FAKE_EXISTING: "legacy-container" });
    assert.equal(result.status, 3, result.stderr);
    assert.match(result.stdout, /wrap this installation, keeping your Dev environment/);
    assert.match(result.stdout, /\/srv\/old-vorteo/);
    assert.deepEqual(questionIds(result.stdout), [
      ["name", "Vorteo"],
      ["projects-folder", "~/work"],
      ["remote", "tailscale"],
    ]);
    const done = box.run(["--yes"], { FAKE_EXISTING: "legacy-container" });
    assert.equal(done.status, 0, done.stdout);
    assert.equal(box.answers().devContainer, true);
    assert.equal(box.answers().projectsFolder, path.join(box.home, "work"));
  });

  test("a current installation is reported without fetching, and --repair repairs it", () => {
    const box = sandbox();
    assert.equal(box.run(["--yes"]).status, 0);
    const callsBefore = box.calls().length;
    const result = box.run([], { FAKE_EXISTING: "current" });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /Vorteo is already installed in/);
    assert.match(result.stdout, /vorteo open/);
    assert.match(result.stdout, /install\.sh --repair$/m);
    const later = box.calls().slice(callsBefore);
    assert.equal(
      later.some(
        (call) =>
          call.tool === "curl" ||
          (call.tool === "git" && (call.argv.includes("clone") || call.argv.includes("fetch"))),
      ),
      false,
    );

    const repaired = box.run(["--repair"], { FAKE_EXISTING: "current" });
    assert.equal(repaired.status, 0, repaired.stdout + repaired.stderr);
    assert.match(repaired.stdout, /✓ Checked the services/);
    assert.ok(box.calls().some((call) => call.tool === "engine" && call.argv[0] === "repair"));
  });

  test("missing Node.js 24 is a question that --yes does not answer", () => {
    const box = sandbox();
    const asked = box.run(["--yes"], { FAKE_NODE_VERSION: "v20.11.0" });
    assert.equal(asked.status, 3, asked.stdout + asked.stderr);
    assert.deepEqual(questionIds(asked.stdout), [["install-node", "yes"]]);
    assert.match(asked.stdout, /found v20\.11\.0/);
    const declined = box.run(["--yes", "--install-node=no"], { FAKE_NODE_VERSION: "v20.11.0" });
    assert.equal(declined.status, 1);
    assert.match(declined.stderr, /Node\.js 24 is required/);
    assert.match(declined.stderr, /Fix:/);
  });

  test("preflight names the fix for missing Docker and Tailscale", () => {
    const box = sandbox();
    const result = box.run(["--yes"], { FAKE_DOCKER: "missing", FAKE_TAILSCALE: "missing" });
    assert.equal(result.status, 1);
    assert.match(
      result.stdout,
      /Install Docker Desktop and start it\. Or rerun with --no-dev-container/,
    );
    assert.match(
      result.stdout,
      /Install Tailscale from https:\/\/tailscale\.com\/download\. Or rerun with --remote=local/,
    );
    assert.equal(
      box.calls().some((call) => call.tool === "engine" && call.argv[0] === "plan"),
      false,
    );
  });

  test("a Tailscale sign-in becomes a question about an auth key file", () => {
    const box = sandbox();
    const env = { FAKE_TAILSCALE: "logged-out" };
    const asked = box.run(
      ["--dev-container=yes", "--name=Vorteo", "--projects-folder=~/dev", "--remote=tailscale"],
      env,
    );
    assert.equal(asked.status, 3, asked.stdout);
    assert.deepEqual(questionIds(asked.stdout), [["tailscale-auth-key-file", "none"]]);
    assert.match(asked.stdout, /Never paste the key into chat/);

    const stillOut = box.run(["--yes"], env);
    assert.equal(stillOut.status, 1);
    assert.match(stillOut.stdout, /Tailscale is not signed in/);

    const keyFile = path.join(box.dir, "ts-key");
    writeFileSync(keyFile, "tskey-auth-test\n", { mode: 0o600 });
    const done = box.run(["--yes", `--tailscale-auth-key-file=${keyFile}`], env);
    assert.equal(done.status, 0, done.stdout + done.stderr);
    assert.deepEqual(box.answers().remote, { mode: "tailscale", authKeyFile: keyFile });
    assert.doesNotMatch(done.stdout, /tskey-auth-test/);
  });

  test("a typed auth key is hidden, passed as a file and removed afterwards", () => {
    const box = sandbox();
    writeFileSync(box.tty, "\n\n\n\ntskey-typed-secret\n\n");
    const result = box.run(["--no-open"], {
      VORTEO_TEST_TTY: box.tty,
      FAKE_TAILSCALE: "logged-out",
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const keyFile = box.answers().remote.authKeyFile;
    assert.ok(keyFile.startsWith(box.dir));
    assert.equal(existsSync(keyFile), false);
    assert.doesNotMatch(result.stdout, /tskey-typed-secret/);
  });

  test("a checkout that does not match the release commit is refused", () => {
    const box = sandbox();
    const result = box.run(["--yes"], {
      FAKE_CLONE_SHA: "2222222222222222222222222222222222222222",
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /does not match release v9\.9\.9/);
    assert.equal(existsSync(path.join(box.home, "vorteo", "source")), false);
    assert.equal(existsSync(path.join(box.home, "vorteo", "source.partial")), false);
  });

  test("VORTEO_VERSION pins a release", () => {
    const box = sandbox();
    const result = box.run(["--yes"], { VORTEO_VERSION: "v1.2.3" });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(box.answers().version, "v1.2.3");
    assert.ok(
      box
        .calls()
        .some((call) => call.tool === "curl" && call.argv.at(-1).endsWith("/releases/tags/v1.2.3")),
    );
  });

  test("bad options exit 2", () => {
    const box = sandbox();
    assert.equal(box.run(["--remote=satellite"]).status, 2);
    assert.equal(box.run(["--frobnicate"]).status, 2);
  });
});

describe("vorteo command", () => {
  test("update explains where updates happen and opens Settings", () => {
    const box = sandbox();
    assert.equal(box.run(["--yes", "--no-open"]).status, 0);
    const shim = path.join(box.home, ".local", "bin", "vorteo");
    const result = spawnSync(bash, [shim, "update"], { env: box.env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Vorteo updates happen in the interface/);
    const opened = box.calls().filter((call) => call.tool === "open");
    assert.deepEqual(opened.at(-1).argv, ["https://vorteo.example.ts.net/settings/maintenance"]);
  });

  test("uninstall without a terminal needs --yes", () => {
    const box = sandbox();
    assert.equal(box.run(["--yes", "--no-open"]).status, 0);
    const shim = path.join(box.home, ".local", "bin", "vorteo");
    const result = spawnSync(bash, [shim, "uninstall"], {
      env: box.env,
      encoding: "utf8",
      input: "",
    });
    assert.equal(result.status, 3, result.stdout + result.stderr);
    assert.equal(
      box.calls().some((call) => call.tool === "engine" && call.argv[0] === "uninstall"),
      false,
    );
    const confirmed = spawnSync(bash, [shim, "uninstall", "--yes", "--keep-data"], {
      env: box.env,
    });
    assert.equal(confirmed.status, 0);
    const call = box
      .calls()
      .find((entry) => entry.tool === "engine" && entry.argv[0] === "uninstall");
    assert.ok(call.argv.includes("--keep-data"));
  });
});
