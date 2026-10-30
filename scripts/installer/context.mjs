// The engine's only door to the machine. Tests replace any of these members, so no
// test reaches launchctl, systemctl, tailscale, Docker or the network.
import { randomBytes, randomUUID } from "node:crypto";
import { accessSync, constants } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { run } from "./primitives.mjs";

// Places installers put these tools that a non-login shell's PATH can miss.
const KNOWN_LOCATIONS = {
  docker: ["/usr/local/bin/docker", "/Applications/Docker.app/Contents/Resources/bin/docker"],
  tailscale: [
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
    "/opt/homebrew/bin/tailscale",
    "/usr/local/bin/tailscale",
    "/usr/bin/tailscale",
  ],
};

function executable(file) {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function findExecutable(name, searchPath = process.env.PATH ?? "") {
  for (const directory of searchPath.split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, name);
    if (executable(candidate)) return candidate;
  }
  return (KNOWN_LOCATIONS[name] ?? []).find(executable) ?? null;
}

/** True when nothing listens on the loopback port. */
export function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen({ port, host: "127.0.0.1", exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

/**
 * @param {{ root?: string, home?: string }} [options]
 */
export function createContext({ root, home = os.homedir() } = {}) {
  return {
    platform: process.platform,
    // Read for test overrides only: VORTEO_SERVICE_MANAGER and VORTEO_DEV_IMAGE.
    env: process.env,
    home,
    root: path.resolve(root ?? path.join(home, "vorteo")),
    uid: process.getuid(),
    user: os.userInfo().username,
    nodeVersion: process.version,
    execPath: process.execPath,
    run,
    which: (name) => findExecutable(name),
    isPortFree,
    fetch: (...args) => fetch(...args),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    randomId: () => randomUUID(),
    secret: () => randomBytes(32).toString("base64url"),
    now: () => new Date(),
    /** Loaded lazily from the built release; replaced in tests. */
    serverModules: undefined,
  };
}
