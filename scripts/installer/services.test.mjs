import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { fakeRunner, temporaryHome } from "./fakes.mjs";
import { createLaunchdManager, plist } from "./launchd.mjs";
import { createSystemdManager, renderSystemdUnit, systemdQuote } from "./systemd.mjs";

const service = {
  label: "local.vorteo.00000000-0000-4000-8000-000000000001.host",
  description: "Vorteo Studio Host daemon",
  argv: ["/opt/node 24/bin/node", "/home/owner/vorteo/host/releases/x/supervisor-entrypoint.js"],
  env: { HOME: "/home/owner", PASEO_HOME: "/home/owner/vorteo/host/state/host", ODD: 'a"b$c%d\\e' },
  log: "/home/owner/vorteo/host/logs/host.log",
  exitTimeout: 30,
};

describe("systemd user units", () => {
  test("render a fixed-MainPID unit with quoted arguments and environment", () => {
    expect(renderSystemdUnit(service)).toBe(
      [
        "[Unit]",
        "Description=Vorteo Studio Host daemon",
        "",
        "[Service]",
        "Type=exec",
        'ExecStart="/opt/node 24/bin/node" "/home/owner/vorteo/host/releases/x/supervisor-entrypoint.js"',
        'Environment="HOME=/home/owner"',
        'Environment="PASEO_HOME=/home/owner/vorteo/host/state/host"',
        'Environment="ODD=a\\"b$$c%%d\\\\e"',
        "UMask=0077",
        "Restart=always",
        "RestartSec=5",
        "TimeoutStopSec=30",
        "StandardOutput=append:/home/owner/vorteo/host/logs/host.log",
        "StandardError=append:/home/owner/vorteo/host/logs/host.log",
        "",
        "[Install]",
        "WantedBy=default.target",
        "",
      ].join("\n"),
    );
    expect(renderSystemdUnit({ ...service, exitTimeout: undefined })).toContain(
      "TimeoutStopSec=20",
    );
  });

  test("refuse values that would break out of their line", () => {
    expect(() => systemdQuote("a\nExecStartPre=/bin/evil")).toThrow("line breaks");
  });

  test("install under ~/.config/systemd/user and drive systemctl --user", async () => {
    const home = temporaryHome();
    let loaded = false;
    const run = fakeRunner([
      ["systemctl --user show", () => (loaded ? "loaded" : "not-found")],
      ["loginctl show-user", "yes"],
    ]);
    const manager = createSystemdManager({ run, uid: 1000, home, user: "owner" });
    manager.write(service);
    const unitFile = path.join(home, ".config/systemd/user", `${service.label}.service`);
    expect(readFileSync(unitFile, "utf8")).toContain("Type=exec");
    expect(manager.descriptor(service.label)).toEqual({
      systemdService: { kind: "systemd-user", uid: 1000, unit: `${service.label}.service` },
    });
    expect(manager.service(service.label)).toBe(`systemd-user/1000/${service.label}.service`);
    await manager.start(service.label);
    await manager.restart(service.label);
    expect(await manager.preflight()).toEqual([]);
    loaded = true;
    await manager.remove(service.label, path.join(home, "disabled"));
    expect(existsSync(unitFile)).toBe(false);
    expect(existsSync(path.join(home, "disabled", `${service.label}.service`))).toBe(true);
    expect(run.commands()).toEqual([
      "systemctl --user daemon-reload",
      `systemctl --user enable --now ${service.label}.service`,
      `systemctl --user restart ${service.label}.service`,
      "loginctl show-user 1000 --property=Linger --value",
      `systemctl --user show --property=LoadState --value ${service.label}.service`,
      `systemctl --user disable --now ${service.label}.service`,
      "systemctl --user daemon-reload",
    ]);
  });

  test("lingering off yields the exact enable-linger command", async () => {
    for (const reply of ["no", new Error("Failed to get user: No such user")]) {
      const manager = createSystemdManager({
        run: fakeRunner([["loginctl", reply]]),
        uid: 1000,
        home: temporaryHome(),
        user: "owner",
      });
      expect(await manager.preflight()).toEqual([
        expect.objectContaining({ ok: false, fix: "sudo loginctl enable-linger owner" }),
      ]);
    }
  });
});

describe("launchd agents", () => {
  test("bootstrap once, reload through bootout, and move aside on removal", async () => {
    const home = temporaryHome();
    let registered = false;
    const run = fakeRunner([["launchctl print", () => (registered ? "" : new Error("not found"))]]);
    const manager = createLaunchdManager({ run, uid: 501, home });
    manager.write(service);
    const file = path.join(home, "Library/LaunchAgents", `${service.label}.plist`);
    expect(readFileSync(file, "utf8")).toBe(
      plist(service.label, service.argv, service.env, service.log, service.exitTimeout),
    );
    expect(readFileSync(file, "utf8")).toContain("a&quot;b$c%d\\e");
    await manager.start(service.label);
    registered = true;
    await manager.start(service.label);
    await manager.reload(service.label);
    await manager.remove(service.label, path.join(home, "disabled"));
    expect(existsSync(path.join(home, "disabled", `${service.label}.plist`))).toBe(true);
    expect(run.commands().filter((command) => !command.startsWith("launchctl print"))).toEqual([
      `launchctl bootstrap gui/501 ${file}`,
      `launchctl bootout gui/501/${service.label}`,
      `launchctl bootstrap gui/501 ${file}`,
      `launchctl bootout gui/501/${service.label}`,
    ]);
  });
});
