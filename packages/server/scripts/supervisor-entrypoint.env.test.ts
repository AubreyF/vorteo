import { promisify } from "node:util";
import { execFile, spawn } from "node:child_process";
import * as nativeFs from "node:fs";
import {
  mkdtemp,
  realpath,
  readFile,
  readdir,
  rm,
  writeFile,
  mkdir,
  symlink,
  rename,
  chmod,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { resolveManagedWorker } from "./managed-release.js";
import { supervisorPersistedConfig } from "./supervisor-persisted-config.js";
import {
  resolveSherpaLoaderEnv,
  sherpaLoaderEnvKey,
} from "../src/server/speech/providers/local/sherpa/sherpa-runtime-env.js";

// These cases need POSIX file modes, signals or rename semantics; Windows cannot run them.
const posixTest = test.skipIf(process.platform === "win32");

const loaderKey = sherpaLoaderEnvKey();
const loaderEnv = resolveSherpaLoaderEnv();

posixTest.each([
  "valid",
  "escape",
  "writable parent",
  "parent alias",
  "root alias",
  "root substitution",
])("managed Host selector outside the release root enforces %s custody", async (mode) => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "managed-host-selector-")));
  const releases = path.join(root, "releases");
  const release = path.join(releases, "candidate");
  const worker = path.join(release, "packages/server/dist/server/server/daemon-worker.js");
  const selectors = path.join(root, "selectors");
  await mkdir(path.dirname(worker), { recursive: true });
  await mkdir(selectors, { mode: 0o700 });
  await writeFile(worker, "fixture worker", { mode: 0o600 });
  await writeFile(
    path.join(release, ".installation-source.json"),
    JSON.stringify({ sourceCommit: "a".repeat(40) }),
    { mode: 0o600 },
  );
  const selected = path.join(selectors, "current");
  await symlink(release, selected);
  const env = { PASEO_MANAGED_RELEASE_LINK: selected, PASEO_MANAGED_RELEASE_ROOT: releases };
  try {
    if (mode === "escape") env.PASEO_MANAGED_RELEASE_ROOT = selectors;
    if (mode === "writable parent") await chmod(selectors, 0o777);
    if (mode === "parent alias") {
      const alias = path.join(root, "alias");
      await symlink(selectors, alias);
      env.PASEO_MANAGED_RELEASE_LINK = path.join(alias, "current");
    }
    if (mode === "root alias") {
      const alias = path.join(root, "root-alias");
      await symlink(releases, alias);
      env.PASEO_MANAGED_RELEASE_ROOT = alias;
    }
    if (mode === "root substitution") {
      const readReceipt = (file: string) => {
        const result = nativeFs.readFileSync(file, "utf8");
        const retained = path.join(root, "retained-releases");
        nativeFs.renameSync(releases, retained);
        nativeFs.symlinkSync(retained, releases);
        return result;
      };
      expect(() => resolveManagedWorker(env, readReceipt)).toThrow();
      return;
    }
    if (mode === "valid") expect(resolveManagedWorker(env)).toBe(worker);
    else expect(() => resolveManagedWorker(env)).toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

posixTest(
  "compiled held idle restart reopens its retained queue without dispatch replay",
  async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "paseo-held-native-")));
    const fixture = path.join(root, "scenario.mjs");
    const report = path.join(root, "result.json");
    const supervisor = new URL("../dist/scripts/supervisor.js", import.meta.url).href;
    const worker = fileURLToPath(
      new URL("../dist/server/server/daemon-worker.js", import.meta.url),
    );
    const clientModule = new URL("../../client/dist/daemon-client.js", import.meta.url).href;
    const execution = new URL("../dist/server/server/execution-installation/", import.meta.url);
    await writeFile(
      fixture,
      `
    import assert from 'node:assert/strict';
    import {writeFile,mkdir} from 'node:fs/promises';
    import {InstallationRestarts} from ${JSON.stringify(new URL("restarts.js", execution).href)};
    import {FileBootstrapRequestJournal} from ${JSON.stringify(new URL("coordinator-bootstrap-journal.js", execution).href)};
    import {randomUUID} from 'node:crypto';
    import {runSupervisor} from ${JSON.stringify(supervisor)};
    import {DaemonClient} from ${JSON.stringify(clientModule)};
    const ready = []; let waiting = null;
    function nextReady() {
      const message = ready.shift();
      if (message) return Promise.resolve(message);
      return new Promise(resolve => { waiting = resolve; });
    }
    const controller = runSupervisor({
      name:'HeldRestartFixture',startupMessage:'starting',restartOnCrash:true,
      resolveWorkerEntry:()=>${JSON.stringify(worker)},
      workerArgs:['--no-mcp','--no-inject-mcp'],workerExecArgv:[],
      onWorkerReady: message => {
        if (waiting) { const resolve=waiting; waiting=null; resolve(message); }
        else ready.push(message);
      },
    });
    let client;
    async function connect(message) {
      const value = new DaemonClient({url:'ws://'+message.listen+'/ws',clientId:'held-native-fixture',reconnect:{enabled:false}});
      await value.connect();
      assert.equal(value.getLastServerInfoMessage().features.heldIdleRestart,true);
      return value;
    }
    (async()=>{
      client = await connect(await nextReady());
      const id=randomUUID(),generation=randomUUID();
      await client.restartServer(undefined,undefined,{idleMode:'drain',restartDrainId:id});
      const inspected=await client.restartServer(undefined,undefined,{idleMode:'inspect'});
      assert.equal(inspected.impact.restartDrainId,id);
      assert.equal(inspected.impact.agents.length,0);
      assert.equal(inspected.impact.pendingStarts,0);
      const held={requestId:id,generation,workerPid:inspected.impact.workerPid,workerInstanceId:inspected.impact.workerInstanceId,terminateAt:Date.now()+10000};
      // Native registration is a fixture boundary here. This test exercises the
      // compiled queue, durable storage, real IPC and worker lifetime checks.
      const directory=${JSON.stringify(path.join(root, "journal"))};
      await mkdir(directory,{mode:0o700});
      const journal=new FileBootstrapRequestJournal(directory);
      const revision=randomUUID(),now=new Date().toISOString();
      const processProof={pid:held.workerPid,parentPid:process.pid,uid:process.getuid(),
        bootId:'fixture-registration',startIdentity:'fixture-registration',
        executable:process.execPath,argumentsSha256:'a'.repeat(64)};
      const intent={held,approvedRevision:revision,grantRevision:randomUUID(),
        holdGeneration:randomUUID(),decisionSha256:'b'.repeat(64),planSha256:'c'.repeat(64),
        reservedAt:now,finishDeadlineAt:new Date(Date.now()+60000).toISOString(),
        native:{identitySha256:'d'.repeat(64),serverId:'fixture',sourceCommit:'e'.repeat(40),
          selectedRelease:${JSON.stringify(path.dirname(worker))},observedAt:now,
          worker:processProof,supervisor:{...processProof,pid:process.pid,parentPid:process.ppid}},
        candidate:null};
      journal.writeLifecycle([{id,revision,target:'host',reason:'Disposable compiled acceptance',
        requestedBy:'host-agent',createdAt:now,expiresAt:now,status:'running',
        detail:'Dispatch outcome unverified',standingInterruption:intent}]);
      const accepted=await client.restartServer(undefined,undefined,{idleMode:'restart',restartDrainId:id,heldRestart:held,timeout:5000});
      assert.equal(accepted.accepted,true);assert.deepEqual(accepted.heldRestart,held);
      await client.close();
      client=await connect(await nextReady());
      const replaced=await client.restartServer(undefined,undefined,{idleMode:'inspect'});
      assert.notEqual(replaced.impact.workerPid,held.workerPid);
      assert.notEqual(replaced.impact.workerInstanceId,held.workerInstanceId);
      assert.equal(replaced.impact.restartDrainId,null);
      let redispatches=0;
      const forbidden=async()=>{redispatches++;throw new Error('Retained generation replayed');};
      const executor={restart:forbidden,restartHeld:forbidden,observeInterruption:async()=>null};
      function reopen(clock) {
        const stored=new FileBootstrapRequestJournal(directory);
        return new InstallationRestarts({read:()=>stored.readLifecycle(),write:jobs=>stored.writeLifecycle(jobs)},
          executor,()=>clock,{standingDecision:()=>null});
      }
      const checkedAt=Date.now();
      // Deliberately retain uncertainty after real supervisor acceptance, as if
      // its reply had been lost. Reopening must not send another restart.
      const uncertain=reopen(checkedAt);
      await uncertain.drain();
      assert.equal(uncertain.list()[0].status,'running');
      assert.equal(uncertain.list()[0].interruptionChecks.attempts,1);
      assert.deepEqual(uncertain.list()[0].standingInterruption,intent);
      executor.observeInterruption=async job=>{
        assert.deepEqual(job.standingInterruption,intent);
        const current=await client.restartServer(undefined,undefined,{idleMode:'inspect'});
        assert.equal(current.impact.workerPid,replaced.impact.workerPid);
        assert.equal(current.impact.workerInstanceId,replaced.impact.workerInstanceId);
        assert.equal(current.impact.restartDrainId,null);
        assert.throws(()=>process.kill(held.workerPid,0),{code:'ESRCH'});
        return 'Fixture worker replacement and previous process exit verified';
      };
      const reconciled=reopen(checkedAt+6000);
      await reconciled.drain();
      assert.equal(reconciled.list()[0].status,'succeeded');
      assert.equal(redispatches,0);
      assert.deepEqual(new FileBootstrapRequestJournal(directory).readLifecycle()[0].standingInterruption,intent);
      await client.close();client=null;
      await writeFile(${JSON.stringify(report)},JSON.stringify({accepted,oldPid:held.workerPid,newPid:replaced.impact.workerPid,queueStatus:reconciled.list()[0].status,redispatches}));
      controller.requestShutdown('fixture_complete');
    })().catch(async error=>{
      console.error(error);await writeFile(${JSON.stringify(report)},JSON.stringify({error:String(error)}));await client?.close();controller.requestShutdown('fixture_failed');
    });
  `,
    );
    const child = spawn(process.execPath, [fixture], {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        TMPDIR: process.env.TMPDIR,
        HOME: root,
        USERPROFILE: root,
        PASEO_HOME: path.join(root, "state"),
        PASEO_LISTEN: "127.0.0.1:0",
        PASEO_RELAY_ENABLED: "0",
        PASEO_MANAGED_WORKER: "1",
        // The System project's standing agent would otherwise appear in the restart impact.
        PASEO_SYSTEM_PROJECT: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    const closed = new Promise<number | null>((resolve, reject) => {
      child.once("close", resolve);
      child.once("error", reject);
    });
    let timer: ReturnType<typeof setTimeout>;
    try {
      const expired = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(output)), 40_000);
      });
      const code = await Promise.race([closed, expired]);
      expect(code, output).toBe(0);
      const result = JSON.parse(await readFile(report, "utf8"));
      expect(result.error, output).toBeUndefined();
      expect(result.accepted.accepted).toBe(true);
      expect(result.queueStatus).toBe("succeeded");
      expect(result.redispatches).toBe(0);
      expect(() => process.kill(result.oldPid, 0)).toThrow();
      expect(() => process.kill(result.newPid, 0)).toThrow();
    } finally {
      clearTimeout(timer!);
      if (child.exitCode === null) child.kill("SIGTERM");
      await closed;
      await rm(root, { recursive: true, force: true });
    }
  },
  60_000,
);

// Agents and terminals inherit the daemon worker's environment, so the local speech
// runtime's library directory must stay scoped to the speech worker.
test.runIf(loaderKey && loaderEnv)(
  "daemon worker environment does not carry the local speech library directory",
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "paseo-supervisor-env-"));
    const reportPath = path.join(root, "worker-env.json");
    const preloadPath = path.join(root, "report-worker-env.mjs");
    await writeFile(
      preloadPath,
      `
      import { writeFileSync } from "node:fs";
      if (/daemon-worker\\.(ts|js)$/.test(process.argv[1] ?? "")) {
        writeFileSync(${JSON.stringify(reportPath)}, JSON.stringify({ value: process.env[${JSON.stringify(loaderKey)}] ?? "" }));
        process.exit(0);
      }
    `,
    );
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith("PASEO_")),
    );
    // Start from a parent environment that does not already list the speech library directory.
    const envLoaderKey =
      Object.keys(env).find((key) => key.toLowerCase() === loaderKey!.toLowerCase()) ?? loaderKey!;
    const parentValue = (env[envLoaderKey] ?? "")
      .split(path.delimiter)
      .filter((entry) => entry && entry !== loaderEnv!.libDir)
      .join(path.delimiter);
    env[envLoaderKey] = parentValue;
    const child = spawn(
      process.execPath,
      ["--import", "tsx", fileURLToPath(new URL("./supervisor-entrypoint.ts", import.meta.url))],
      {
        cwd: fileURLToPath(new URL("../../../", import.meta.url)),
        env: {
          ...env,
          HOME: root,
          USERPROFILE: root,
          PASEO_HOME: path.join(root, "home"),
          NODE_OPTIONS: `--import=${pathToFileURL(preloadPath).href}`,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    try {
      await expect
        .poll(async () => readFile(reportPath, "utf8").catch(() => null), {
          timeout: 20_000,
          message: output,
        })
        .not.toBeNull();
      const report = JSON.parse(await readFile(reportPath, "utf8")) as { value: string };
      expect(report.value).toBe(parentValue);
    } finally {
      if (child.exitCode === null) {
        const closed = new Promise((resolve) => child.once("close", resolve));
        child.kill("SIGKILL");
        await closed;
      }
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);

test("startup preflight accepts disabled providers without creating runtime state and redacts invalid values", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-preflight-"));
  const run = promisify(execFile);
  const entry = fileURLToPath(new URL("../dist/scripts/supervisor-entrypoint.js", import.meta.url));
  const options = {
    env: { ...process.env, PASEO_HOME: root, PASEO_VALIDATE_STARTUP: "1" },
    timeout: 20_000,
  };
  try {
    await writeFile(
      path.join(root, "config.json"),
      JSON.stringify({ agents: { providers: { retired: { enabled: false } } } }),
    );
    await run(process.execPath, [entry], options);
    expect(await readdir(root)).toEqual(["config.json"]);
    await writeFile(
      path.join(root, "config.json"),
      JSON.stringify({ daemon: { listen: { secret: "private-value" } } }),
    );
    let stderr = "";
    try {
      await run(process.execPath, [entry], options);
    } catch (error) {
      if (error instanceof Error && "stderr" in error) stderr = String(error.stderr);
      else throw error;
    }
    expect(stderr).toBe("Invalid configuration fields: daemon.listen");
    expect(await readdir(root)).toEqual(["config.json"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

posixTest.each([false, true])(
  "a managed supervisor selects the approved release on restart without replacing itself with external selector %s",
  async (externalSelector) => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "paseo-managed-supervisor-")));
    const releases = path.join(root, "releases");
    const home = path.join(root, "home");
    const selectorDirectory = externalSelector ? root : releases;
    const link = path.join(selectorDirectory, "current");
    const report = path.join(root, "workers.jsonl");
    const supervisorEntry = fileURLToPath(
      new URL("../dist/scripts/supervisor-entrypoint.js", import.meta.url),
    );
    await mkdir(home);
    const first = path.join(releases, "first");
    const second = path.join(releases, "second");
    for (const [release, commit] of [
      [first, "a".repeat(40)],
      [second, "b".repeat(40)],
    ]) {
      const entry = path.join(release!, "packages/server/dist/server/server/daemon-worker.js");
      await mkdir(path.dirname(entry), { recursive: true });
      await writeFile(
        path.join(release!, ".installation-source.json"),
        JSON.stringify({ sourceCommit: commit }),
      );
      await writeFile(
        path.join(path.dirname(entry), "persisted-config.js"),
        "exports.readPersistedConfig = () => ({}); exports.loadPersistedConfig = () => ({});",
      );
      await writeFile(
        entry,
        `
      const fs = require("fs");
      const parentCommand = process.platform === "win32" ? null : require("node:child_process").execFileSync("/bin/ps", ["-ww", "-p", String(process.ppid), "-o", "command="], { encoding: "utf8" }).trim();
      fs.appendFileSync(${JSON.stringify(report)}, JSON.stringify({ pid: process.pid, parent: process.ppid, release: ${JSON.stringify(release)}, managed: process.env.PASEO_MANAGED_WORKER, parentCommand }) + "\\n");
      process.on("message", message => { if (message.type === "paseo:graceful-shutdown") process.exit(0); });
      process.send({ type: "paseo:ready", listen: "test-endpoint", serverId: "srv_managed_test" });
      const timer = setInterval(() => {
        if (${release === first} && fs.existsSync(${JSON.stringify(path.join(root, "restart"))})) {
          clearInterval(timer); process.send({ type: "paseo:restart" });
        }
      }, 20);
    `,
      );
    }
    await symlink(first, link);
    const cleanEnv = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith("PASEO_")),
    );
    const child = spawn(process.execPath, [supervisorEntry], {
      env: {
        ...cleanEnv,
        PASEO_HOME: home,
        PASEO_MANAGED_RELEASE_LINK: link,
        PASEO_MANAGED_RELEASE_ROOT: releases,
        VORTEO_INSTALLATION_CLIENT_CONFIG: path.join(root, "synthetic-host-client.json"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    const readWorkers = async () =>
      (await readFile(report, "utf8").catch(() => ""))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    try {
      await expect.poll(readWorkers, { timeout: 15000, message: output }).toHaveLength(1);
      await symlink(second, `${link}.next`);
      await rename(`${link}.next`, link);
      await writeFile(path.join(root, "restart"), "owner approved");
      await expect.poll(readWorkers, { timeout: 15000, message: output }).toHaveLength(2);
      const workers = await readWorkers();
      expect(workers.map((worker) => worker.release)).toEqual([first, second]);
      expect(workers.map((worker) => worker.managed)).toEqual(["1", "1"]);
      expect(workers.map((worker) => worker.parent)).toEqual([child.pid, child.pid]);
      if (process.platform !== "win32") {
        for (const worker of workers) expect(worker.parentCommand).toContain(supervisorEntry);
      }
      expect(workers[0].pid).not.toBe(workers[1].pid);
      // The Dev installer collector uses Linux /proc. Selection, replacement and
      // native parent arguments above are verified on macOS too. Dev keeps its release link
      // directly inside the release root, which the collector requires; an external selector
      // is the Host launcher's layout.
      if (process.platform === "linux" && !externalSelector) {
        const helper = await readFile(
          new URL("../../../scripts/installation-container-runtime.mjs", import.meta.url),
          "utf8",
        );
        const settings = {
          releaseRoot: releases,
          currentReleaseLink: link,
          home,
          node: process.execPath,
        };
        const run = promisify(execFile);
        const verification = await run(process.execPath, [
          "--input-type=module",
          "--eval",
          helper,
          JSON.stringify({
            action: "verify",
            settings,
            release: second,
            pid: workers[1].pid,
            update: { sourceCommit: "b".repeat(40) },
          }),
        ]);
        expect(JSON.parse(verification.stdout).sourceCommit).toBe("b".repeat(40));
        await expect(
          run(process.execPath, [
            "--input-type=module",
            "--eval",
            helper,
            JSON.stringify({
              action: "verify",
              settings,
              release: first,
              pid: workers[1].pid,
              update: { sourceCommit: "a".repeat(40) },
            }),
          ]),
        ).rejects.toThrow("approved release");
      }
    } finally {
      const closed = new Promise((resolve) => child.once("close", resolve));
      child.kill("SIGTERM");
      if (child.exitCode === null) await closed;
      await rm(root, { recursive: true, force: true });
    }
  },
  40000,
);

// Linux installation verification reads the real worker argv after startup.
test.runIf(process.platform === "linux")(
  "a managed daemon keeps its executable arguments after becoming ready",
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "paseo-managed-argv-"));
    const entry = fileURLToPath(new URL("../dist/server/server/daemon-worker.js", import.meta.url));
    const cleanEnv = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith("PASEO_")),
    );
    const child = spawn(process.execPath, [entry], {
      env: {
        ...cleanEnv,
        PASEO_HOME: root,
        PASEO_LISTEN: path.join(root, "daemon.sock"),
        PASEO_MANAGED_WORKER: "1",
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    let ready = false;
    child.on("message", (message) => {
      if (
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "paseo:ready"
      )
        ready = true;
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    try {
      await expect.poll(() => ready, { timeout: 30000, message: output }).toBe(true);
      const command = (await readFile(`/proc/${child.pid}/cmdline`, "utf8")).split("\0");
      expect(command).toContain(entry);
    } finally {
      if (child.exitCode === null) {
        const closed = new Promise((resolve) => child.once("close", resolve));
        child.kill("SIGTERM");
        await closed;
      }
      await rm(root, { recursive: true, force: true });
    }
  },
  45000,
);

test.each(["VORTEO_INSTALLATION_CLIENT_CONFIG", "VORTEO_COORDINATOR_BOOTSTRAP_SETUP", null])(
  "supervisor native arguments follow the existing installation profile %s",
  async (marker) => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "paseo-supervisor-identity-")));
    const report = path.join(root, "worker.json");
    const preload = path.join(root, "worker-fixture.mjs");
    const entry = fileURLToPath(
      new URL("../dist/scripts/supervisor-entrypoint.js", import.meta.url),
    );
    await writeFile(
      preload,
      `
      import fs from 'node:fs';
      import {execFileSync} from 'node:child_process';
      if (/daemon-worker\\.js$/.test(process.argv[1] ?? '')) {
        const command = process.platform === 'win32' ? null : execFileSync('/bin/ps', ['-ww','-p',String(process.ppid),'-o','command='], {encoding:'utf8'}).trim();
        fs.writeFileSync(${JSON.stringify(report)}, JSON.stringify({pid:process.pid,parent:process.ppid,command}));
        process.on('message', message => { if (message.type === 'paseo:graceful-shutdown') process.exit(0); });
        process.send({type:'paseo:ready',listen:'fixture-only',serverId:'fixture-only'});
        setInterval(() => {}, 1000);
        // Do not import the real daemon or execute providers in this fixture.
        await new Promise(() => {});
      }
    `,
    );
    const child = spawn(process.execPath, [entry], {
      env: {
        PATH: process.env.PATH,
        TMPDIR: process.env.TMPDIR,
        HOME: root,
        USERPROFILE: root,
        PASEO_HOME: root,
        NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
        ...(marker ? { [marker]: path.join(root, "fixture-registration.json") } : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const closed = new Promise((resolve, reject) => {
      child.once("close", resolve);
      child.once("error", reject);
    });
    try {
      await expect
        .poll(() => readFile(report, "utf8").catch(() => null), { timeout: 15000 })
        .not.toBeNull();
      const observed = JSON.parse(await readFile(report, "utf8"));
      expect(observed.parent).toBe(child.pid);
      if (process.platform !== "win32") {
        if (marker) expect(observed.command).toContain(entry);
        else expect(observed.command).toBe("Paseo Supervisor");
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await closed;
      await rm(root, { recursive: true, force: true });
    }
  },
  20000,
);

posixTest.each(["selected schema", "reader alias", "selection changes", "missing reader"])(
  "retained supervisor configuration follows the protected worker release: %s",
  async (mode) => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "supervisor-config-release-")));
    const releases = path.join(root, "releases");
    const release = path.join(releases, "selected");
    const worker = path.join(release, "packages/server/dist/server/server/daemon-worker.js");
    const reader = path.join(path.dirname(worker), "persisted-config.js");
    const selected = path.join(root, "current");
    const home = path.join(root, "home");
    await mkdir(path.dirname(worker), { recursive: true });
    await mkdir(home);
    await writeFile(worker, "// Never executed by configuration validation");
    await writeFile(
      path.join(release, ".installation-source.json"),
      JSON.stringify({ sourceCommit: "a".repeat(40) }),
    );
    await writeFile(path.join(release, "package.json"), JSON.stringify({ type: "module" }));
    await symlink(release, selected);
    const config = { futureWorkerSetting: true };
    await writeFile(path.join(home, "config.json"), JSON.stringify(config));
    const readerCode = `
      import {readFileSync, unlinkSync} from 'node:fs';
      import path from 'node:path';
      ${mode === "selection changes" ? `unlinkSync(${JSON.stringify(selected)});` : ""}
      export function readPersistedConfig(home) {
        const value = JSON.parse(readFileSync(path.join(home, 'config.json'), 'utf8'));
        if (value.futureWorkerSetting !== true || Object.keys(value).length !== 1) throw Error('Invalid selected-release config');
        return value;
      }
      export const loadPersistedConfig = readPersistedConfig;
    `;
    if (mode !== "missing reader") await writeFile(reader, readerCode);
    if (mode === "reader alias") {
      await rename(reader, path.join(root, "outside.js"));
      await symlink(path.join(root, "outside.js"), reader);
    }
    const env = { PASEO_MANAGED_RELEASE_LINK: selected, PASEO_MANAGED_RELEASE_ROOT: releases };
    try {
      if (mode === "selected schema") {
        const local = await supervisorPersistedConfig({});
        expect(() => local.readPersistedConfig(home)).toThrow();
        const selectedReader = await supervisorPersistedConfig(env);
        expect(selectedReader.readPersistedConfig(home)).toEqual(config);
        await writeFile(path.join(home, "config.json"), JSON.stringify({ invalid: true }));
        expect(() => selectedReader.readPersistedConfig(home)).toThrow(
          "Invalid selected-release config",
        );
        expect(await readdir(home)).toEqual(["config.json"]);
      } else await expect(supervisorPersistedConfig(env)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
