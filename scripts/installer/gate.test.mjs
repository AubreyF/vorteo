// Gate configuration is rendered by docker/multiplex/common.sh, the one implementation
// that install.sh and gate.sh share; the engine supplies its routes and origins.
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { devPublicHostname, gateRoutes, interfaceOrigins } from "./coordinator-config.mjs";

const COMMON = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../docker/multiplex/common.sh",
);

function shell(functionName, ...args) {
  return spawnSync("bash", ["-c", `source "$0"; ${functionName} "$@"`, COMMON, ...args], {
    encoding: "utf8",
  });
}

function gateConfig(...args) {
  const result = shell("paseo_gate_config", ...args);
  if (result.status !== 0) throw new Error(result.stderr);
  return JSON.parse(result.stdout);
}

const plan = (mode) => ({
  devContainer: true,
  remote: { mode },
  ports: { coordinator: 6772, https: 44447 },
});

describe("gate configuration", () => {
  test("renders the Dev environment, its relay and the coordinator route", () => {
    const routes = gateRoutes(plan("tailscale"), "box.example.ts.net").join(",");
    expect(gateConfig("paseo-0123456789ab", "172.31.251.0/24", routes)).toEqual({
      log: "/var/log/gate/connections.jsonl",
      proxy: ":3128",
      policy: "standard",
      environments: [{ name: "dev", generation: "paseo-0123456789ab", subnet: "172.31.251.0/24" }],
      relays: [{ listen: ":6768", target: "paseo:6767", environment: "dev" }],
      routes: ["box.example.ts.net:44447"],
    });
  });

  test("local mode routes the coordinator's loopback port through a name only the gate resolves", () => {
    const local = plan("local");
    expect(gateConfig("paseo-x", "172.31.250.0/24", gateRoutes(local).join(",")).routes).toEqual([
      "host.docker.internal:6772",
    ]);
    expect(devPublicHostname(local)).toBe("localhost");
    expect(interfaceOrigins(local)).toEqual(["http://localhost:6772", "http://127.0.0.1:6772"]);
  });

  test("several routes and none", () => {
    expect(gateConfig("paseo-x", "172.31.250.0/24", "a.example:443,b.example:8443").routes).toEqual(
      ["a.example:443", "b.example:8443"],
    );
    expect(gateConfig("paseo-x", "172.31.250.0/24", "").routes).toEqual([]);
  });

  test.each([
    ["Paseo-X", "172.31.250.0/24", ""],
    ["paseo-x", "192.168.1.0/24", ""],
    ["paseo-x", "172.31.256.0/24", ""],
    ["paseo-x", "172.31.250.0/16", ""],
    ["paseo-x", "172.31.250.0/24", 'evil.example:443","x'],
    ["paseo-x", "172.31.250.0/24", "no-port.example"],
  ])("refuses %s %s %s", (...args) => {
    expect(() => gateConfig(...args)).toThrow();
  });

  test("the gate address is .2 of its subnet", () => {
    expect(shell("paseo_gate_address", "172.16.4.0/24").stdout.trim()).toBe("172.16.4.2");
    expect(
      execFileSync(
        "bash",
        ["-c", 'source "$0"; paseo_gate_hostname "$1" && echo ok', COMMON, "box.example.ts.net"],
        {
          encoding: "utf8",
        },
      ).trim(),
    ).toBe("ok");
    expect(shell("paseo_gate_hostname", "localhost").status).toBe(0);
    expect(shell("paseo_gate_hostname", "-bad.example").status).not.toBe(0);
    expect(
      shell(
        "paseo_gate_origins",
        interfaceOrigins(plan("tailscale"), "box.example.ts.net").join(","),
      ).status,
    ).toBe(0);
  });
});
