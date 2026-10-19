import { execFileSync, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
const [input, profile] = process.argv.slice(2);
if (!input || !profile || process.platform !== "darwin") {
  throw new Error("Usage: node notarize.mjs <signed-app> <existing-notary-keychain-profile>");
}
const app = resolve(input);
const signature = spawnSync("/usr/bin/codesign", ["-dv", "--verbose=4", app], { encoding: "utf8" });
if (
  signature.status !== 0 ||
  !signature.stderr.includes("Authority=Developer ID Application:") ||
  !signature.stderr.includes("Identifier=com.vorteo.macos-helper\n")
) {
  throw new Error("Notarization requires the production Developer ID signed helper");
}
const archive = app + ".notarization.zip";
if (existsSync(archive)) throw new Error("Notarization archive already exists");
execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", app], { stdio: "inherit" });
execFileSync("/usr/bin/ditto", ["-c", "-k", "--keepParent", app, archive], { stdio: "inherit" });
// This contacts Apple. Invoke only with owner authorization for the upload.
execFileSync(
  "/usr/bin/xcrun",
  ["notarytool", "submit", archive, "--keychain-profile", profile, "--wait"],
  { stdio: "inherit" },
);
execFileSync("/usr/bin/xcrun", ["stapler", "staple", app], { stdio: "inherit" });
execFileSync("/usr/sbin/spctl", ["--assess", "--type", "execute", "--verbose=2", app], {
  stdio: "inherit",
});
