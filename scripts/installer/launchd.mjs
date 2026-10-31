// macOS service adapter: per-user LaunchAgents in the owner's gui/<uid> domain.
import { existsSync, mkdirSync, renameSync } from "node:fs";
import path from "node:path";
import { privateWrite, xml } from "./primitives.mjs";

const LAUNCHCTL = "/bin/launchctl";

// The Host supervisor needs its 10 s worker grace plus the worker's 15 s hard
// deadline before launchd escalates to SIGKILL; the default leaves no margin.
export const HOST_EXIT_TIMEOUT_SECONDS = 30;

export function plist(label, argv, environment, log, exitTimeOut) {
  const args = argv.map((arg) => `<string>${xml(arg)}</string>`).join("");
  const env = Object.entries(environment)
    .map(([key, value]) => `<key>${xml(key)}</key><string>${xml(value)}</string>`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${xml(
    label,
  )}</string><key>ProgramArguments</key><array>${args}</array><key>EnvironmentVariables</key><dict>${env}</dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>5</integer>${
    exitTimeOut === undefined ? "" : `<key>ExitTimeOut</key><integer>${exitTimeOut}</integer>`
  }<key>StandardOutPath</key><string>${xml(log)}</string><key>StandardErrorPath</key><string>${xml(
    log,
  )}</string></dict></plist>\n`;
}

/**
 * @param {{ run: Function, uid: number, home: string }} context
 */
export function createLaunchdManager({
  run,
  uid,
  home,
  sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
}) {
  const directory = path.join(home, "Library", "LaunchAgents");
  const target = (label) => `gui/${uid}/${label}`;
  const file = (label) => path.join(directory, `${label}.plist`);
  async function isRegistered(label) {
    try {
      await run(LAUNCHCTL, ["print", target(label)]);
      return true;
    } catch {
      return false;
    }
  }
  return {
    kind: "launchd",
    directory,
    file,
    /** The coordinator configuration's Host service descriptor. */
    descriptor: (label) => ({ launchdService: target(label) }),
    service: target,
    render: (service) =>
      plist(service.label, service.argv, service.env, service.log, service.exitTimeout),
    /** Lingering is a systemd concept; launchd agents run while the owner is signed in. */
    preflight: async () => [],
    write(service) {
      privateWrite(file(service.label), this.render(service));
    },
    isRegistered,
    async start(label) {
      if (!(await isRegistered(label)))
        await run(LAUNCHCTL, ["bootstrap", `gui/${uid}`, file(label)]);
    },
    /** Reloads the written definition: launchd keeps the loaded copy until bootout. */
    async reload(label) {
      if (await isRegistered(label)) {
        await run(LAUNCHCTL, ["bootout", target(label)]);
        // bootout returns before the old job unloads; bootstrapping the same label too soon
        // fails with "5: Input/output error".
        for (let wait = 0; wait < 40 && (await isRegistered(label)); wait += 1) await sleep(250);
      }
      for (let attempt = 1; ; attempt += 1) {
        try {
          await run(LAUNCHCTL, ["bootstrap", `gui/${uid}`, file(label)]);
          return;
        } catch (error) {
          if (attempt >= 5) throw error;
          await sleep(1000);
        }
      }
    },
    async restart(label) {
      await run(LAUNCHCTL, ["kickstart", "-k", target(label)]);
    },
    async stop(label) {
      if (await isRegistered(label)) await run(LAUNCHCTL, ["bootout", target(label)]);
    },
    /** Stops the agent and moves its definition aside, never deleting it. */
    async remove(label, disabledDirectory) {
      await this.stop(label);
      if (existsSync(file(label))) {
        mkdirSync(disabledDirectory, { recursive: true, mode: 0o700 });
        renameSync(file(label), path.join(disabledDirectory, path.basename(file(label))));
      }
    },
  };
}
