import { expect, test } from "vitest";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import {
  workerShellEnvironment,
  verifyWorkerPhysicalWorkspace,
  verifyWorkerPermissionProfile,
} from "./worker-permissions.js";

const denyAllProxy = {
  enabled: true,
  proxy_url: "http://127.0.0.1:0",
  enable_socks5: false,
  enable_socks5_udp: false,
  allow_upstream_proxy: false,
  dangerously_allow_non_loopback_proxy: false,
  dangerously_allow_all_unix_sockets: false,
  mode: "limited",
  domains: {},
  unix_sockets: {},
  allow_local_binding: false,
};
const proxyFeature = { enabled: true, credential_broker: false };
// Policy validation requires an absolute path in the host's native syntax.
const fixtureRoot = resolve("/fixture");
test.each([`${fixtureRoot}${delimiter}extra`, `${fixtureRoot}${delimiter}${delimiter}extra`])(
  "rejects a workspace that would add PATH search entries: %s",
  (cwd) => {
    expect(() => workerShellEnvironment(cwd)).toThrow("without PATH separators");
  },
);

const workerProfile = {
  extends: null,
  workspace_roots: { [fixtureRoot]: true },
  filesystem: {
    ":root": "deny",
    ":minimal": "read",
    ":tmpdir": "deny",
    ":slash_tmp": "deny",
    ":workspace_roots": { ".": "write", ".codex": "deny", ".git": "read" },
  },
};

test("admits audited deny-all managed proxy and retains strict network-denied profiles", () => {
  expect(() =>
    verifyWorkerPermissionProfile(
      { ...workerProfile, network: denyAllProxy },
      fixtureRoot,
      proxyFeature,
    ),
  ).not.toThrow();
  expect(() =>
    verifyWorkerPermissionProfile({ ...workerProfile, network: { enabled: false } }, fixtureRoot),
  ).not.toThrow();
});

test.each([
  { domains: { "example.invalid": "allow" } },
  { unix_sockets: { "/fixture/socket": "allow" } },
  { allow_upstream_proxy: true },
  { enable_socks5: true },
  { enable_socks5_udp: true },
  { allow_local_binding: true },
  { dangerously_allow_non_loopback_proxy: true },
  { dangerously_allow_all_unix_sockets: true },
  { proxy_url: "http://192.0.2.1:3128" },
  { mode: "full" },
  { mitm: {} },
  { credential_broker: true },
])("rejects network expansion or unverified defaults %j", (patch) => {
  expect(() =>
    verifyWorkerPermissionProfile(
      { ...workerProfile, network: { ...denyAllProxy, ...patch } },
      fixtureRoot,
      proxyFeature,
    ),
  ).toThrow("filesystem confinement");
});

test.each([
  undefined,
  false,
  true,
  { enabled: true },
  { enabled: true, credential_broker: true },
  { ...proxyFeature, domains: { "example.invalid": "allow" } },
])("requires the exact enabled proxy feature with broker disabled: %j", (feature) => {
  expect(() =>
    verifyWorkerPermissionProfile(
      { ...workerProfile, network: denyAllProxy },
      fixtureRoot,
      feature,
    ),
  ).toThrow("managed proxy is unverified");
});

test("requires prepared directories without repairing missing or file deny targets", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "worker-paths-")));
  try {
    await expect(verifyWorkerPhysicalWorkspace(root)).rejects.toThrow();
    await writeFile(join(root, ".codex"), "fixture");
    await expect(verifyWorkerPhysicalWorkspace(root)).rejects.toThrow("physical workspace");
    await rm(join(root, ".codex"));
    await mkdir(join(root, ".codex"));
    await expect(verifyWorkerPhysicalWorkspace(root)).resolves.toBeUndefined();
    await expect(verifyWorkerPhysicalWorkspace("relative")).rejects.toThrow("physical workspace");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects symlinks in the workspace and protected directory paths", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "worker-links-")));
  const work = join(root, "work");
  const linked = join(root, "linked");
  const outside = join(root, "outside");
  try {
    await mkdir(work);
    await mkdir(outside);
    await mkdir(join(work, ".codex"));
    await symlink(work, linked, "junction");
    await expect(verifyWorkerPhysicalWorkspace(linked)).rejects.toThrow("physical workspace");
    await rm(join(work, ".codex"), { recursive: true });
    await symlink(outside, join(work, ".codex"), "junction");
    await expect(verifyWorkerPhysicalWorkspace(work)).rejects.toThrow("physical workspace");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const readOnlyRoots = { ".": "read", ".factory-tmp": "write", ".codex": "deny", ".git": "read" };
const readOnlyProfile = {
  ...workerProfile,
  filesystem: { ...workerProfile.filesystem, ":workspace_roots": readOnlyRoots },
};

test("returns the verified workspace mode for both audited shapes", () => {
  expect(
    verifyWorkerPermissionProfile({ ...workerProfile, network: { enabled: false } }, fixtureRoot),
  ).toBe("write");
  expect(
    verifyWorkerPermissionProfile({ ...readOnlyProfile, network: { enabled: false } }, fixtureRoot),
  ).toBe("read-only");
  expect(
    verifyWorkerPermissionProfile(
      { ...readOnlyProfile, network: denyAllProxy },
      fixtureRoot,
      proxyFeature,
    ),
  ).toBe("read-only");
});

test.each([
  { ".": "read", ".codex": "deny", ".git": "read" },
  { ".": "write", ".factory-tmp": "write", ".codex": "deny", ".git": "read" },
  { ".": "read", ".factory-tmp": "read", ".codex": "deny", ".git": "read" },
  { ".": "read", ".factory-tmp": "write", ".codex": "read", ".git": "read" },
  { ".": "read", ".factory-tmp": "write", ".codex": "deny", ".git": "write" },
  { ".": "read", ".factory-tmp": "write", ".codex": "deny" },
  { ".": "read", ".factory-tmp": "write", ".codex": "deny", ".git": "read", ".other": "write" },
  { ".": "deny", ".factory-tmp": "write", ".codex": "deny", ".git": "read" },
  { ".": "write", ".codex": "deny", ".git": "read", ".factory-tmp": "deny" },
])("rejects near-miss workspace shapes %j", (roots) => {
  expect(() =>
    verifyWorkerPermissionProfile(
      {
        ...workerProfile,
        filesystem: { ...workerProfile.filesystem, ":workspace_roots": roots },
        network: { enabled: false },
      },
      fixtureRoot,
    ),
  ).toThrow("filesystem confinement");
});

test("read-only workers require a real .factory-tmp directory; writable workers do not", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "worker-readonly-")));
  const outside = join(root, "outside");
  const work = join(root, "work");
  try {
    await mkdir(work);
    await mkdir(outside);
    await mkdir(join(work, ".codex"));
    await expect(verifyWorkerPhysicalWorkspace(work)).resolves.toBeUndefined();
    await expect(verifyWorkerPhysicalWorkspace(work, "write")).resolves.toBeUndefined();
    await expect(verifyWorkerPhysicalWorkspace(work, "read-only")).rejects.toThrow();
    await writeFile(join(work, ".factory-tmp"), "fixture");
    await expect(verifyWorkerPhysicalWorkspace(work, "read-only")).rejects.toThrow(
      "physical workspace",
    );
    await rm(join(work, ".factory-tmp"));
    await symlink(outside, join(work, ".factory-tmp"), "junction");
    await expect(verifyWorkerPhysicalWorkspace(work, "read-only")).rejects.toThrow(
      "physical workspace",
    );
    await rm(join(work, ".factory-tmp"));
    await mkdir(join(work, ".factory-tmp"));
    await expect(verifyWorkerPhysicalWorkspace(work, "read-only")).resolves.toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
