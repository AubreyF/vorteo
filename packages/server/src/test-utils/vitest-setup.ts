import { chmodSync, mkdirSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

// Load package-local .env.test first for integration/E2E credentials, then repo-root .env fallback.
const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
dotenv.config({ path: path.resolve(serverRoot, ".env.test"), override: true });
dotenv.config({ path: path.resolve(serverRoot, "../.env") });

// Agent shells on a managed Host inherit the installation client marker, which makes Claude
// credential code refuse undelivered setup tokens. Suites that test managed behavior stub it.
delete process.env.VORTEO_INSTALLATION_CLIENT_CONFIG;

// Installation custody refuses files under group- or world-writable directories, such as a shared
// /tmp on Linux. Point temporary fixtures at a private root, as on macOS's per-user tmpdir.
if (process.platform !== "win32" && hasSharedAncestor(realpathSync(os.tmpdir()))) {
  const privateRoot = path.join(os.homedir(), ".cache", "paseo-server-tests");
  mkdirSync(privateRoot, { recursive: true, mode: 0o700 });
  chmodSync(privateRoot, 0o700);
  process.env.TMPDIR = realpathSync(privateRoot);
}

function hasSharedAncestor(directory: string): boolean {
  for (let current = directory; ; current = path.dirname(current)) {
    if ((statSync(current).mode & 0o022) !== 0) return true;
    if (path.dirname(current) === current) return false;
  }
}

process.env.PASEO_SUPERVISED = "0";
process.env.GIT_TERMINAL_PROMPT = "0";
process.env.GIT_SSH_COMMAND = "ssh -oBatchMode=yes";
process.env.SSH_ASKPASS = "/usr/bin/false";
process.env.SSH_ASKPASS_REQUIRE = "force";
process.env.DISPLAY = process.env.DISPLAY ?? "1";
