// Linux service adapter: units of the owner account's `systemd --user` manager.
// Unit names match the launchd labels plus ".service", which is the form
// packages/server/src/server/execution-installation/config.ts (SystemdUserServiceSchema)
// and coordinator-bootstrap-systemd.ts expect.
import { existsSync, mkdirSync, renameSync } from "node:fs";
import path from "node:path";
import { privateWrite } from "./primitives.mjs";
import { HOST_EXIT_TIMEOUT_SECONDS } from "./launchd.mjs";

const SYSTEMCTL = "systemctl";
const LOGINCTL = "loginctl";

/** Quotes one word for ExecStart= or Environment=; systemd expands `%` specifiers and `$`. */
export function systemdQuote(value) {
  if (/[\n\r]/.test(value)) throw new Error("systemd unit values cannot contain line breaks");
  return `"${value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("%", "%%")
    .replaceAll("$", "$$$$")}"`;
}

/**
 * `Type=exec` with the default `NotifyAccess=none` keeps `MainPID` fixed to the process
 * the manager started, which the coordinator's systemd ownership check requires.
 */
export function renderSystemdUnit({ description, argv, env, log, exitTimeout }) {
  const lines = [
    "[Unit]",
    `Description=${description.replaceAll("\n", " ")}`,
    "",
    "[Service]",
    "Type=exec",
    `ExecStart=${argv.map(systemdQuote).join(" ")}`,
    ...Object.entries(env).map(([key, value]) => `Environment=${systemdQuote(`${key}=${value}`)}`),
    "UMask=0077",
    "Restart=always",
    "RestartSec=5",
    // Matches launchd's ExitTimeOut for the Host supervisor; systemd's default is 90 s.
    `TimeoutStopSec=${exitTimeout ?? 20}`,
    `StandardOutput=append:${log}`,
    `StandardError=append:${log}`,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ];
  return lines.join("\n");
}

export const SYSTEMD_HOST_EXIT_TIMEOUT_SECONDS = HOST_EXIT_TIMEOUT_SECONDS;

/**
 * @param {{ run: Function, uid: number, home: string, user: string }} context
 */
export function createSystemdManager({ run, uid, home, user }) {
  const directory = path.join(home, ".config", "systemd", "user");
  const unit = (label) => `${label}.service`;
  const file = (label) => path.join(directory, unit(label));
  const systemctl = (...args) => run(SYSTEMCTL, ["--user", ...args]);
  async function isRegistered(label) {
    try {
      return (await systemctl("show", "--property=LoadState", "--value", unit(label))) === "loaded";
    } catch {
      return false;
    }
  }
  return {
    kind: "systemd-user",
    directory,
    file,
    descriptor: (label) => ({ systemdService: { kind: "systemd-user", uid, unit: unit(label) } }),
    service: (label) => `systemd-user/${uid}/${unit(label)}`,
    render: (service) =>
      renderSystemdUnit({
        description: service.description ?? service.label,
        argv: service.argv,
        env: service.env,
        log: service.log,
        exitTimeout: service.exitTimeout,
      }),
    /** Without lingering, the user manager and every Vorteo service stop at logout. */
    async preflight() {
      let linger = "";
      try {
        linger = await run(LOGINCTL, ["show-user", String(uid), "--property=Linger", "--value"]);
      } catch {
        /* no session record yet; treat as off */
      }
      if (linger === "yes") return [];
      return [
        {
          ok: false,
          message: "Vorteo stops when you log out because lingering is off for this account.",
          fix: `sudo loginctl enable-linger ${user}`,
        },
      ];
    },
    write(service) {
      privateWrite(file(service.label), this.render(service));
    },
    isRegistered,
    async start(label) {
      await systemctl("daemon-reload");
      await systemctl("enable", "--now", unit(label));
    },
    async reload(label) {
      await systemctl("daemon-reload");
      await systemctl("enable", unit(label));
      await systemctl("restart", unit(label));
    },
    async restart(label) {
      await systemctl("restart", unit(label));
    },
    async stop(label) {
      if (await isRegistered(label)) await systemctl("stop", unit(label));
    },
    async remove(label, disabledDirectory) {
      if (await isRegistered(label)) await systemctl("disable", "--now", unit(label));
      if (existsSync(file(label))) {
        mkdirSync(disabledDirectory, { recursive: true, mode: 0o700 });
        renameSync(file(label), path.join(disabledDirectory, path.basename(file(label))));
      }
      await systemctl("daemon-reload");
    },
  };
}
