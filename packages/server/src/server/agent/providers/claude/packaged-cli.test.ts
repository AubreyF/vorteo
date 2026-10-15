import {
  chmod,
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  symlink,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  initializePackagedClaudeCli,
  managedClaudeCli,
  PACKAGED_CLAUDE_VERSION,
  resolvePackagedClaudeCli,
} from "./packaged-cli.js";
import {
  checkProviderLaunchAvailable,
  resolveProviderLaunch,
} from "../../provider-launch-config.js";

const dirs: string[] = [];
afterEach(async () => {
  initializePackagedClaudeCli(false);
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "packaged-claude-"));
  dirs.push(root);
  const main = path.join(root, "main");
  const native = path.join(root, "native");
  await mkdir(path.join(main, "bin"), { recursive: true });
  await mkdir(native);
  const name = "@anthropic-ai/claude-code";
  const platformName = `${name}-linux-x64`;
  const mainManifest = {
    name,
    version: PACKAGED_CLAUDE_VERSION,
    bin: { claude: "bin/claude.exe" },
    optionalDependencies: { [platformName]: PACKAGED_CLAUDE_VERSION },
  };
  const nativeManifest = {
    name: platformName,
    version: PACKAGED_CLAUDE_VERSION,
    os: ["linux"],
    cpu: ["x64"],
    libc: ["glibc"],
  };
  await writeFile(path.join(main, "package.json"), JSON.stringify(mainManifest));
  await writeFile(path.join(native, "package.json"), JSON.stringify(nativeManifest));
  const payload = path.join(native, "claude");
  const installed = path.join(main, "bin/claude.exe");
  await writeFile(payload, "synthetic executable bytes\n", { mode: 0o755 });
  await copyFile(payload, installed);
  const runtime = {
    platform: "linux" as const,
    arch: "x64",
    libc: "glibc" as const,
    resolvePackage: (reference: string) => {
      if (reference === `${name}/package.json`) return path.join(main, "package.json");
      if (reference === `${platformName}/package.json`) return path.join(native, "package.json");
      throw new Error("Unprepared platform");
    },
  };
  return { main, native, installed, payload, runtime, mainManifest, nativeManifest };
}

test("verifies copied postinstall bytes without executing them", async () => {
  const f = await fixture();
  expect(await resolvePackagedClaudeCli(f.runtime)).toBe(await realpath(f.installed));
});

test.each(["missing", "wrong-version", "wrong-platform", "wrapper", "non-executable"])(
  "refuses %s payload without fallback",
  async (failure) => {
    const f = await fixture();
    if (failure === "missing") await rm(f.payload);
    if (failure === "wrong-version")
      await writeFile(
        path.join(f.native, "package.json"),
        JSON.stringify({ ...f.nativeManifest, version: "2.1.246" }),
      );
    if (failure === "wrong-platform")
      await writeFile(
        path.join(f.native, "package.json"),
        JSON.stringify({ ...f.nativeManifest, cpu: ["arm64"] }),
      );
    if (failure === "wrapper") await writeFile(f.installed, "fallback wrapper");
    if (failure === "non-executable") await chmod(f.installed, 0o600);
    await expect(resolvePackagedClaudeCli(f.runtime)).rejects.toThrow();
  },
);

test("refuses unknown Linux libc and unsupported architectures", async () => {
  const f = await fixture();
  await expect(resolvePackagedClaudeCli({ ...f.runtime, libc: undefined })).rejects.toThrow(
    "unsupported",
  );
  await expect(resolvePackagedClaudeCli({ ...f.runtime, arch: "ia32" })).rejects.toThrow(
    "unsupported",
  );
});

test("import is inert and standalone preserves the PATH default", async () => {
  expect(await managedClaudeCli()).toBeNull();
  expect(await resolveProviderLaunch({ defaultBinary: "claude" })).toEqual({
    command: "claude",
    args: [],
    source: "default",
  });
});

test("daemon entry point passes captured mode after deleting marker", async () => {
  const source = await readFile(new URL("../../../daemon-worker.ts", import.meta.url), "utf8");
  expect(source.indexOf("delete process.env.PASEO_MANAGED_WORKER")).toBeLessThan(
    source.indexOf("initializePackagedClaudeCli(managedWorker)"),
  );
  expect(source.indexOf("initializePackagedClaudeCli(managedWorker)")).toBeLessThan(
    source.indexOf("async function main()"),
  );
});

test("rejects same-sized substituted installed bytes and wrong libc", async () => {
  const f = await fixture();
  const bytes = await readFile(f.installed);
  bytes[0] ^= 1;
  await writeFile(f.installed, bytes);
  await expect(resolvePackagedClaudeCli(f.runtime)).rejects.toThrow("postinstall");
  await copyFile(f.payload, f.installed);
  await writeFile(
    path.join(f.native, "package.json"),
    JSON.stringify({ ...f.nativeManifest, libc: ["musl"] }),
  );
  await expect(resolvePackagedClaudeCli(f.runtime)).rejects.toThrow("libc");
});

test("refuses an executable symlink outside its pinned package", async () => {
  const f = await fixture();
  await rm(f.installed);
  await symlink(f.payload, f.installed);
  await expect(resolvePackagedClaudeCli(f.runtime)).rejects.toThrow("escaped its package");
});

test("coordinator selects its release CLI after startup authority and before login construction", async () => {
  const source = await readFile(
    new URL("../../../execution-installation/main.ts", import.meta.url),
    "utf8",
  );
  const initialization = source.indexOf("initializePackagedClaudeCli(true);");
  expect(initialization).toBeGreaterThan(
    source.indexOf("const startupFence = loadCoordinatorStartupFence("),
  );
  expect(initialization).toBeGreaterThan(source.indexOf("configuration: realpathSync(configFile)"));
  expect(initialization).toBeLessThan(
    source.indexOf("const claudeSetup = createClaudeSetupRuntime("),
  );
});

test("managed default and appended commands share the release executable; replacement stays explicit", async () => {
  initializePackagedClaudeCli(true);
  const executable = await managedClaudeCli();
  expect(path.isAbsolute(executable!)).toBe(true);
  const launch = await resolveProviderLaunch({ defaultBinary: "claude" });
  expect(launch).toEqual({ command: executable, args: [], source: "default" });
  expect(await checkProviderLaunchAvailable(launch)).toEqual({
    available: true,
    resolvedPath: executable,
  });
  expect(
    await resolveProviderLaunch({
      defaultBinary: "claude",
      commandConfig: { mode: "append", args: ["--debug"] },
    }),
  ).toEqual({ command: executable, args: ["--debug"], source: "append" });
  expect(
    await resolveProviderLaunch({
      defaultBinary: "claude",
      commandConfig: { mode: "replace", argv: ["/custom/claude", "--flag"] },
    }),
  ).toEqual({ command: "/custom/claude", args: ["--flag"], source: "override" });
});
