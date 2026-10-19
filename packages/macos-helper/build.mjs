import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const source = dirname(fileURLToPath(import.meta.url));
const [output, identity, mode] = process.argv.slice(2);
if (
  process.platform !== "darwin" ||
  !output ||
  !identity ||
  (mode && !["--preview", "--local-signing"].includes(mode))
) {
  throw new Error(
    "Usage: node build.mjs <new-output-directory> <signing-identity> [--preview|--local-signing]",
  );
}
const preview = mode === "--preview";
const localSigning = mode === "--local-signing";
if (localSigning && !/^[a-f0-9]{40}$/i.test(identity))
  throw new Error("Local signing requires the certificate SHA-1 fingerprint");
if ((identity === "-") !== preview) {
  throw new Error(
    "Ad hoc signatures are allowed only for isolated previews; previews must use '-'.",
  );
}
if (!preview) {
  const identities = execFileSync(
    "/usr/bin/security",
    ["find-identity", ...(localSigning ? [] : ["-v"]), "-p", "codesigning"],
    { encoding: "utf8" },
  );
  const available = identities
    .split("\n")
    .some(
      (line) =>
        (localSigning || line.includes("Developer ID Application:")) &&
        (line.includes(`"${identity}"`) || line.includes(` ${identity} `)),
    );
  if (!available) throw new Error("Requested signing identity is unavailable in the Host keychain");
}
const destination = resolve(output);
if (existsSync(destination)) throw new Error("Build output must be a new directory");
const app = join(destination, "Vorteo Permission Helper.app");
const contents = join(app, "Contents");
const binaries = join(contents, "MacOS");
mkdirSync(binaries, { recursive: true, mode: 0o700 });
cpSync(join(source, "Info.plist"), join(contents, "Info.plist"));
mkdirSync(join(contents, "Resources"));
cpSync(join(source, "../desktop/assets/icon.icns"), join(contents, "Resources/icon.icns"));
cpSync(join(source, "browser"), join(contents, "Resources/browser"), { recursive: true });
mkdirSync(join(contents, "Resources/adapter"));
for (const file of ["host.mjs", "invoke.mjs", "protocol.mjs"]) {
  cpSync(join(source, file), join(contents, "Resources/adapter", file));
}
function run(cmd, args) {
  const result = spawnSync(cmd, args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${cmd} failed: ${result.stderr}`);
  return result.stdout;
}
const plist = join(contents, "Info.plist");
const version = JSON.parse(readFileSync(join(source, "../../package.json"), "utf8")).version;
run("/usr/libexec/PlistBuddy", ["-c", `Set :CFBundleVersion ${version.split(".").at(-1)}`, plist]);
if (preview) {
  run("/usr/libexec/PlistBuddy", [
    "-c",
    "Set :CFBundleIdentifier com.vorteo.macos-helper.preview",
    plist,
  ]);
  run("/usr/libexec/PlistBuddy", ["-c", "Set :CFBundleDisplayName Vorteo Preview", plist]);
  run("/usr/libexec/PlistBuddy", ["-c", "Set :CFBundleName Vorteo Preview", plist]);
}
const architecture = { arm64: "arm64", x64: "x86_64" }[process.arch];
if (!architecture) throw new Error("Unsupported native Mac architecture");
const swift = [
  "swiftc",
  "-target",
  `${architecture}-apple-macosx13.0`,
  "-O",
  "-warnings-as-errors",
  "-framework",
  "AppKit",
  "-framework",
  "Security",
  "-framework",
  "Carbon",
];
if (preview) swift.push("-D", "PREVIEW");
for (const [input, name] of [
  ["Application.swift", "VorteoPermissionHelper"],
  ["Client.swift", "vorteo-helper-client"],
]) {
  // Swift top-level entry must be named main.swift when compiling multiple sources.
  const entry = join(destination, "main.swift");
  cpSync(join(source, "src", input), entry);
  run("/usr/bin/xcrun", [
    ...swift,
    join(source, "src/Transport.swift"),
    join(source, "src/BrowserModels.swift"),
    ...(input === "Application.swift" ? [join(source, "src/Browser.swift")] : []),
    entry,
    "-o",
    join(binaries, name),
  ]);
}
const sign = ["--force", "--sign", identity, "--options", "runtime"];
if (!preview && !localSigning) sign.push("--timestamp");
if (localSigning) sign.push("--timestamp=none");
function localRequirement(id) {
  return localSigning
    ? ["-r", `=designated => identifier "${id}" and certificate leaf = H"${identity}"`]
    : [];
}
run("/usr/bin/codesign", [
  ...sign,
  "--identifier",
  preview ? "com.vorteo.macos-helper.client.preview" : "com.vorteo.macos-helper.client",
  ...localRequirement("com.vorteo.macos-helper.client"),
  join(binaries, "vorteo-helper-client"),
]);
run("/usr/bin/codesign", [
  ...sign,
  ...localRequirement("com.vorteo.macos-helper"),
  "--entitlements",
  join(source, "entitlements.plist"),
  app,
]);
run("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]);
const sourceCommit = run("/usr/bin/git", ["-C", source, "rev-parse", "HEAD"]).trim();
const sourceDirty = run("/usr/bin/git", ["-C", source, "status", "--porcelain"]).trim().length > 0;
const signature = spawnSync("/usr/bin/codesign", ["-dv", "--verbose=4", app], {
  encoding: "utf8",
}).stderr;
// Installation independently revalidates the signature before selecting a bundle.
writeFileSync(
  join(destination, "build.json"),
  JSON.stringify(
    {
      version,
      sourceCommit,
      sourceDirty,
      preview,
      localSigning,
      app,
      architecture: process.arch,
      signature,
    },
    null,
    2,
  ) + "\n",
);
process.stdout.write(`${app}\n`);
