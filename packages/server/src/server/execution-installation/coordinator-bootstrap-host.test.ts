import { afterEach, test, expect } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  writeFileSync,
  rmSync,
  chmodSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { hashSync } from "bcryptjs";
import {
  readBootstrapHostBinding,
  bootstrapWritableMountRoots,
} from "./coordinator-bootstrap-host.js";

const roots: string[] = [];

test("bootstrap mount evidence distinguishes Host binds from verified local VM volumes", () => {
  const containerId = "a".repeat(64);
  const container = {
    Id: containerId,
    State: { Running: true },
    Mounts: [
      { Type: "bind", Source: "/private/guest", RW: true },
      { Type: "bind", Source: "/private/read-only", RW: false },
      { Type: "volume", Name: "state", RW: true },
      { Type: "tmpfs", RW: true },
    ],
  };
  const volumes = [{ Name: "state", Driver: "local", Scope: "local", Options: null }];
  expect(bootstrapWritableMountRoots({ container, containerId, volumes })).toEqual([
    "/private/guest",
  ]);
  expect(() =>
    bootstrapWritableMountRoots({ container, containerId: "b".repeat(64), volumes }),
  ).toThrow("identity changed");
  expect(() => bootstrapWritableMountRoots({ container, containerId, volumes: [] })).toThrow(
    "missing or ambiguous",
  );
  expect(() =>
    bootstrapWritableMountRoots({ container, containerId, volumes: [...volumes, ...volumes] }),
  ).toThrow("missing or ambiguous");
  expect(() =>
    bootstrapWritableMountRoots({
      container,
      containerId,
      volumes: [{ ...volumes[0], Options: { type: "none", o: "bind", device: "/private" } }],
    }),
  ).toThrow("driver options");
});

test("bootstrap mount evidence fails closed on incomplete or unsupported Docker output", () => {
  const containerId = "a".repeat(64);
  const base = { Id: containerId, State: { Running: true } };
  for (const container of [
    base,
    { ...base, State: { Running: false }, Mounts: [] },
    { ...base, Mounts: [{ Type: "bind", Source: "/private" }] },
    { ...base, Mounts: [{ Type: "bind", Source: "relative", RW: true }] },
    { ...base, Mounts: [{ Type: "unknown", RW: true }] },
  ]) {
    expect(() => bootstrapWritableMountRoots({ container, containerId, volumes: [] })).toThrow();
  }
});
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "bootstrap-host-")));
  roots.push(root);
  const file = path.join(root, "coordinator.json");
  const installationId = randomUUID();
  const stateDir = path.join(root, "state");
  mkdirSync(stateDir, { mode: 0o700 });
  const config = {
    public: {
      version: 1,
      installationId,
      origin: "https://installation.example.test",
      environments: [
        { kind: "host", serverId: "host-id", endpoint: "127.0.0.1:6768", useTls: false },
        { kind: "container", serverId: "dev-id", endpoint: "127.0.0.1:6769", useTls: false },
      ],
    },
    ownerPasswordHash: hashSync("fixture-password", 4),
    stateDir,
    host: { launchdService: `gui/${process.getuid!()}/local.vorteo.${installationId}.host` },
  };
  const save = () => writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  save();
  return { root, file, config, save };
}

test("bootstrap binding pins Host daemon and service, and observes owner credential changes", () => {
  const f = fixture();
  const context = readBootstrapHostBinding(f.file, "host-id");
  expect(context.binding.installationId).toBe(f.config.public.installationId);
  expect(context.binding.service).toBe(
    f.config.host.launchdService.replace(/\.host$/, ".installation"),
  );
  expect(context.stateDirectory).toBe(f.config.stateDir);
  expect(() => readBootstrapHostBinding(f.file, "dev-id")).toThrow("configured Host");
  f.config.ownerPasswordHash = hashSync("changed-password", 4);
  f.save();
  expect(readBootstrapHostBinding(f.file, "host-id").binding.ownerPasswordHash).not.toBe(
    context.binding.ownerPasswordHash,
  );
  f.config.host.launchdService = "gui/501/local.vorteo.other.host";
  f.save();
  expect(() => readBootstrapHostBinding(f.file, "host-id")).toThrow("service identity");
});

test("bootstrap binding rejects exposed or aliased configuration and invalid owner authentication", () => {
  const f = fixture();
  const alias = path.join(f.root, "alias.json");
  symlinkSync(f.file, alias);
  expect(() => readBootstrapHostBinding(alias, "host-id")).toThrow("canonical");
  chmodSync(f.file, 0o644);
  expect(() => readBootstrapHostBinding(f.file, "host-id")).toThrow("private owned file");
  chmodSync(f.file, 0o600);
  chmodSync(f.root, 0o755);
  expect(() => readBootstrapHostBinding(f.file, "host-id")).toThrow("private Host directory");
  chmodSync(f.root, 0o700);
  chmodSync(f.config.stateDir, 0o755);
  expect(() => readBootstrapHostBinding(f.file, "host-id")).toThrow("private Host directory");
  chmodSync(f.config.stateDir, 0o700);
  f.config.ownerPasswordHash = "";
  f.save();
  expect(() => readBootstrapHostBinding(f.file, "host-id")).toThrow();
});
