import { promisify } from "node:util";
import { execFile, spawn } from "node:child_process";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
  mkdir,
  symlink,
  rename,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import {
  resolveSherpaLoaderEnv,
  sherpaLoaderEnvKey,
} from "../src/server/speech/providers/local/sherpa/sherpa-runtime-env.js";

const loaderKey = sherpaLoaderEnvKey();
const loaderEnv = resolveSherpaLoaderEnv();

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

test("a managed supervisor selects the approved release on restart without replacing itself", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-managed-supervisor-"));
  const releases = path.join(root, "releases");
  const home = path.join(root, "home");
  const link = path.join(releases, "current");
  const report = path.join(root, "workers.jsonl");
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
      entry,
      `
      const fs = require("fs");
      fs.appendFileSync(${JSON.stringify(report)}, JSON.stringify({ pid: process.pid, parent: process.ppid, release: ${JSON.stringify(release)}, managed: process.env.PASEO_MANAGED_WORKER }) + "\\n");
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
  const child = spawn(
    process.execPath,
    ["--import", "tsx", fileURLToPath(new URL("./supervisor-entrypoint.ts", import.meta.url))],
    {
      env: {
        ...cleanEnv,
        PASEO_HOME: home,
        PASEO_MANAGED_RELEASE_LINK: link,
        PASEO_MANAGED_RELEASE_ROOT: releases,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
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
    expect(workers[0].pid).not.toBe(workers[1].pid);
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
  } finally {
    const closed = new Promise((resolve) => child.once("close", resolve));
    child.kill("SIGTERM");
    if (child.exitCode === null) await closed;
    await rm(root, { recursive: true, force: true });
  }
}, 40000);

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
