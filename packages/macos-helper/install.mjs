import { execFileSync, spawnSync } from "node:child_process";
import { chmod, cp, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import { privateFile, parseConfiguration } from "./host.mjs";
import { invokeHelper } from "./dispatch.mjs";

// Inject external operations so installer acceptance can use an isolated home without
// invoking signing tools, Launch Services, or an installed helper.
export async function installHelper({
  installerArgs = process.argv.slice(2),
  home = homedir(),
  exec = execFileSync,
  spawn = spawnSync,
  copy = cp,
  invoke = invokeHelper,
} = {}) {
  const operation = installerArgs[0];
  const options = installerArgs.slice(1).filter((value) => value.startsWith("--"));
  const operands = installerArgs.slice(1).filter((value) => !value.startsWith("--"));
  if (
    operands.length > 1 ||
    options.some((value) => !["--preview", "--local-signing"].includes(value))
  )
    throw new Error("Unsupported installer arguments");
  const input = operands[0];
  const preview = options.includes("--preview");
  const localSigning = options.includes("--local-signing");
  const productionMode = localSigning ? "local" : "developer-id";
  const signingMode = preview ? "preview" : productionMode;
  if (preview && localSigning) throw new Error("Choose one signing mode");
  if (!["install", "rollback", "uninstall", "diagnostics", "launch"].includes(operation)) {
    throw new Error(
      "Usage: node install.mjs install <app> [--preview] | rollback|uninstall|diagnostics|launch [--preview]",
    );
  }
  const app = join(
    home,
    "Applications",
    preview ? "Vorteo Permission Helper Preview.app" : "Vorteo Permission Helper.app",
  );
  const runtime = join(
    home,
    ".local/share",
    preview ? "vorteo-macos-helper-preview" : "vorteo-macos-helper",
  );
  const configPath = join(runtime, "config.json");
  const previous = app + ".previous";
  const staged = app + ".staged";
  const socket = join(runtime, "helper.sock");
  const identifier = preview ? "com.vorteo.macos-helper.preview" : "com.vorteo.macos-helper";
  const clientIdentifier = preview
    ? "com.vorteo.macos-helper.client.preview"
    : "com.vorteo.macos-helper.client";

  async function exists(path) {
    try {
      await lstat(path);
      return true;
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
  }
  function codesign(args) {
    const result = spawn("/usr/bin/codesign", args, { encoding: "utf8" });
    if (result.status !== 0) throw new Error(`Signature validation failed: ${result.stderr}`);
    return result.stdout + result.stderr;
  }
  function requirement(path) {
    const text = codesign(["-dr", "-", path]);
    const match = text.match(/designated => (.+)/);
    if (!match) throw new Error("Missing designated requirement");
    return match[1];
  }
  function signature(path) {
    const text = codesign(["-dv", "--verbose=4", path]);
    if (!text.includes("runtime)")) throw new Error("Hardened runtime is required");
    const match = text.match(/^Identifier=(.+)$/m);
    if (!match) throw new Error("Missing signing identifier");
    if (!preview && !localSigning && !text.includes("Authority=Developer ID Application:")) {
      throw new Error("Production installation requires Developer ID Application signing");
    }
    if (!preview && text.includes("Signature=adhoc"))
      throw new Error("Ad hoc production signing is prohibited");
    const rule = requirement(path);
    if (localSigning && !/certificate leaf = H"[a-f0-9]{40}"/i.test(rule))
      throw new Error("Local signature must pin the certificate leaf");
    return {
      identifier: match[1],
      requirement: rule,
      team: text.match(/^TeamIdentifier=(.+)$/m)?.[1] ?? null,
    };
  }
  function validate(candidate, config) {
    codesign(["--verify", "--deep", "--strict", candidate]);
    const helper = signature(candidate);
    for (const file of ["host.mjs", "invoke.mjs", "protocol.mjs"]) {
      if (
        !exec("/usr/bin/stat", ["-f", "%HT", join(candidate, "Contents/Resources/adapter", file)], {
          encoding: "utf8",
        }).includes("Regular File")
      )
        throw new Error("Missing bundled adapter");
    }
    const clientPath = join(candidate, "Contents/MacOS/vorteo-helper-client");
    const client = signature(clientPath);
    if (
      helper.identifier !== identifier ||
      client.identifier !== clientIdentifier ||
      helper.team !== client.team ||
      (localSigning &&
        helper.requirement.match(/certificate leaf = H"([a-f0-9]{40})"/i)[1] !==
          client.requirement.match(/certificate leaf = H"([a-f0-9]{40})"/i)[1])
    ) {
      throw new Error("Unexpected helper/client identity");
    }
    const bundleIdentifier = exec(
      "/usr/libexec/PlistBuddy",
      ["-c", "Print :CFBundleIdentifier", join(candidate, "Contents/Info.plist")],
      { encoding: "utf8" },
    ).trim();
    if (bundleIdentifier !== identifier) throw new Error("Unexpected bundle identity");
    const entitlementOutput = spawn(
      "/usr/bin/codesign",
      ["-d", "--entitlements", "-", "--xml", candidate],
      { encoding: "utf8" },
    );
    const entitlementKeys = [...entitlementOutput.stdout.matchAll(/<key>(.*?)<\/key>/g)].map(
      (entry) => entry[1],
    );
    if (
      entitlementKeys.length !== 1 ||
      entitlementKeys[0] !== "com.apple.security.automation.apple-events" ||
      !entitlementOutput.stdout.includes("<true/>")
    ) {
      throw new Error("Helper must carry only the Apple Events entitlement");
    }
    if (config) {
      const mode = signingMode;
      if (config.signingMode && config.signingMode !== mode)
        throw new Error("Signing strategy migration requires separate review");
      codesign(["--verify", "--strict", "-R", `=${config.helperRequirement}`, candidate]);
      codesign(["--verify", "--strict", "-R", `=${config.clientRequirement}`, clientPath]);
    }
    return { helper, client };
  }
  // Requirements identify a signer, not a particular build. Bind the entire bundle,
  // including sealed adapters, to the candidate validated before copying.
  function bundleDigest(root) {
    const hash = createHash("sha256");
    function visit(relative) {
      const path = join(root, relative);
      const stat = lstatSync(path);
      const metadata = [relative, stat.mode & 0o7777];
      if (stat.isDirectory()) {
        hash.update(JSON.stringify([...metadata, "directory"]) + "\n");
        for (const name of readdirSync(path).sort()) visit(join(relative, name));
      } else if (stat.isFile()) {
        const content = createHash("sha256").update(readFileSync(path)).digest("hex");
        hash.update(JSON.stringify([...metadata, "file", content]) + "\n");
      } else if (stat.isSymbolicLink()) {
        hash.update(JSON.stringify([...metadata, "symlink", readlinkSync(path)]) + "\n");
      } else {
        throw new Error("Unsupported bundle entry");
      }
    }
    visit("");
    return hash.digest("hex");
  }
  function validateSnapshot(path, config) {
    const bundleSHA256 = bundleDigest(path);
    const signed = validate(path, config);
    if (bundleDigest(path) !== bundleSHA256)
      throw new Error("Bundle changed during signature validation");
    return { ...signed, bundleSHA256 };
  }
  async function loadConfig() {
    if (!(await exists(runtime))) return null;
    await privateFile(runtime, true);
    if (!(await exists(configPath))) return null;
    await privateFile(configPath);
    return parseConfiguration(await readFile(configPath, "utf8"));
  }
  function isRunning() {
    const commands = exec("/bin/ps", ["-axo", "comm="], { encoding: "utf8" }).split("\n");
    return commands.includes(join(app, "Contents/MacOS/VorteoPermissionHelper"));
  }
  async function stop() {
    if (isRunning()) {
      const reply = await invoke("quit", { preview });
      if (!reply.ok) throw new Error("Helper refused shutdown");
      for (let attempt = 0; attempt < 50 && isRunning(); attempt++) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 100));
      }
      if (isRunning()) throw new Error("Helper remains active; update deferred");
    }
    // Only after confirming this helper is absent may a stale socket be removed.
    if (await exists(socket)) await rm(socket);
  }
  async function selectStaged() {
    try {
      await rename(staged, app);
    } catch (error) {
      if (await exists(previous)) await rename(previous, app);
      throw error;
    }
  }
  async function launch() {
    // Launch Services establishes the app's native launch responsibility.
    if (isRunning()) {
      const reply = await invoke("status", { preview });
      if (reply.ok) return;
      for (let attempt = 0; attempt < 50 && isRunning(); attempt++)
        await new Promise((done) => setTimeout(done, 100));
      if (isRunning()) throw new Error("Existing helper has not stopped; launch deferred");
    }
    // A fresh Launch Services instance avoids reusing an exited process cached by LS.
    exec("/usr/bin/open", ["-n", "-g", app]);
    for (let attempt = 0; attempt < 50; attempt++) {
      const reply = await invoke("status", { preview });
      if (reply.ok) return;
      if (reply.code !== "helper_unavailable")
        throw new Error(`Helper readiness failed: ${reply.code}`);
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
    throw new Error(
      "Helper did not become ready; inspect diagnostics and retained previous bundle",
    );
  }
  async function installCandidate(config) {
    if (!input || input === "--preview") throw new Error("App path required");
    const candidate = resolve(input);
    if (candidate === app || candidate === previous || candidate === staged)
      throw new Error("Use an independent built app");
    const approved = validateSnapshot(candidate, config);
    if (await exists(staged))
      throw new Error("Staging path already exists; reconcile previous installation first");
    if (await exists(app)) {
      if (!config) throw new Error("Existing app has no matching private configuration");
      validate(app, config);
    }
    await mkdir(dirname(app), { recursive: true });
    await copy(candidate, staged, { recursive: true, errorOnExist: true, force: false });
    try {
      const signed = validateSnapshot(staged, config);
      if (JSON.stringify(signed) !== JSON.stringify(approved))
        throw new Error("Staged bundle differs from validated candidate");
      await stop();
      await mkdir(runtime, { recursive: true, mode: 0o700 });
      await chmod(runtime, 0o700);
      if (!config) {
        config = {
          token: randomBytes(32).toString("hex"),
          signingMode: signingMode,
          clientRequirement: signed.client.requirement,
          helperRequirement: signed.helper.requirement,
        };
        await writeFile(configPath, JSON.stringify(config) + "\n", { flag: "wx", mode: 0o600 });
      }
      await rm(previous, { recursive: true, force: true });
      if (await exists(app)) await rename(app, previous);
      await selectStaged();
      await copy(
        join(dirname(fileURLToPath(import.meta.url)), "dispatch.mjs"),
        join(runtime, "host.mjs"),
      );
      await copy(
        join(dirname(fileURLToPath(import.meta.url)), "dispatch-cli.mjs"),
        join(runtime, "invoke.mjs"),
      );
      await chmod(join(runtime, "host.mjs"), 0o600);
      await chmod(join(runtime, "invoke.mjs"), 0o600);
      await writeFile(
        join(runtime, "installation.json"),
        JSON.stringify({ installedAt: new Date().toISOString(), preview, app, signed }, null, 2) +
          "\n",
        { mode: 0o600 },
      );
      await launch();
      process.stdout.write("Helper installed and launched. No agent daemon restarted.\n");
    } catch (error) {
      await rm(staged, { recursive: true, force: true });
      throw error;
    }
  }
  async function runOperation() {
    const mutating = ["install", "rollback", "uninstall", "launch"].includes(operation);
    const lock = app + ".install-lock";
    if (mutating) {
      await mkdir(dirname(app), { recursive: true });
      await mkdir(lock, { mode: 0o700 });
    }
    try {
      let config = await loadConfig();
      if (operation === "diagnostics") {
        const signed = validate(app, config);
        const gatekeeper = spawn(
          "/usr/sbin/spctl",
          ["--assess", "--type", "execute", "--verbose=2", app],
          { encoding: "utf8" },
        );
        process.stdout.write(
          JSON.stringify(
            {
              preview,
              signed,
              running: isRunning(),
              socketPresent: await exists(socket),
              gatekeeper: { status: gatekeeper.status, message: gatekeeper.stderr.trim() },
            },
            null,
            2,
          ) + "\n",
        );
      } else if (operation === "launch") {
        if (!config) throw new Error("Helper not provisioned");
        validate(app, config);
        if (!isRunning() && (await exists(socket))) await rm(socket);
        await launch();
      } else if (operation === "uninstall") {
        await stop();
        await rm(app, { recursive: true, force: true });
        await rm(previous, { recursive: true, force: true });
        await rm(runtime, { recursive: true, force: true });
        process.stdout.write(
          "Helper and local capability removed. Review Automation settings to revoke the macOS grant.\n",
        );
      } else if (operation === "rollback") {
        if (!config) throw new Error("Helper not provisioned");
        validate(previous, config);
        if (await exists(staged))
          throw new Error("Staging path already exists; reconcile before rollback");
        await stop();
        await rename(app, staged);
        try {
          await rename(previous, app);
        } catch (error) {
          await rename(staged, app);
          throw error;
        }
        await rename(staged, previous);
        await launch();
      } else {
        await installCandidate(config);
      }
    } finally {
      if (mutating) await rm(lock, { recursive: true });
    }
  }
  await runOperation();
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await installHelper();
}
