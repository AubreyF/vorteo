import { promisify } from "node:util";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
  const options = { env: { ...process.env, PASEO_HOME: root, PASEO_VALIDATE_STARTUP: "1" } };
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
