// Test doubles for the installer engine: a recording command runner and a context
// that never reaches launchctl, systemctl, tailscale, Docker or the network.
import { mkdtempSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * `rules` are [match, reply] pairs tried in order. `match` is a command basename, a
 * "basename arg0 arg1" prefix, or a predicate; `reply` is a string, an Error to throw,
 * or a function of (args, options) returning either.
 */
export function fakeRunner(rules = []) {
  const calls = [];
  const matches = (match, command, args) => {
    if (typeof match === "function") return match(path.basename(command), args);
    const words = match.split(" ");
    return (
      path.basename(command) === words[0] &&
      words.slice(1).every((word, index) => args[index] === word)
    );
  };
  async function run(command, args = [], options = {}) {
    calls.push({ command: path.basename(command), args, options });
    for (const [match, reply] of rules) {
      if (!matches(match, command, args)) continue;
      const value = typeof reply === "function" ? await reply(args, options) : reply;
      if (value instanceof Error) throw value;
      return value ?? "";
    }
    return "";
  }
  run.calls = calls;
  run.commands = () => calls.map((call) => [call.command, ...call.args].join(" "));
  return run;
}

export function temporaryHome() {
  const home = mkdtempSync(path.join(os.tmpdir(), "vorteo-installer-"));
  mkdirSync(path.join(home, "bin"));
  return home;
}

export const TAILSCALE_STATUS = JSON.stringify({
  BackendState: "Running",
  Self: { DNSName: "box.example.ts.net." },
});

/** Answers for a machine with every tool installed, Docker running and Tailscale signed in. */
export function fakeContext({
  home = temporaryHome(),
  platform = "darwin",
  rules = [],
  busyPorts = [],
  ...overrides
} = {}) {
  const run = fakeRunner([
    ...rules,
    ["git --version", "git version 2.50.0"],
    ["git rev-parse", "a".repeat(40)],
    ["docker info", "27.0.0"],
    ["docker network ls", "n1"],
    [
      "docker network inspect",
      JSON.stringify([{ IPAM: { Config: [{ Subnet: "172.17.0.0/16" }] } }]),
    ],
    ["tailscale status", TAILSCALE_STATUS],
    ["tailscale serve status", "{}"],
  ]);
  const busy = new Set(busyPorts);
  let ids = 0;
  return {
    platform,
    home,
    root: path.join(home, "vorteo"),
    uid: 501,
    user: "owner",
    nodeVersion: "v24.18.0",
    execPath: "/opt/node/bin/node",
    run,
    which: (name) => `/usr/bin/${name}`,
    isPortFree: async (port) => !busy.has(port),
    fetch: async () => {
      throw new Error("no network in tests");
    },
    sleep: async () => {},
    randomId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`,
    secret: () => `secret-${++ids}`,
    now: () => new Date("2026-10-30T12:00:00Z"),
    serverModules: undefined,
    ...overrides,
  };
}
