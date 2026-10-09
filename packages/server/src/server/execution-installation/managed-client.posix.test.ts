import { afterEach, expect, test } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveManagedInstallationClient } from "./managed-client.js";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function fixture() {
  const homeDir = mkdtempSync(path.join(tmpdir(), "managed-installation-client-"));
  homes.push(homeDir);
  const file = path.join(homeDir, ".local/share/vorteo-installation-client/client.json");
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const config = {
    kind: "container-agent",
    origin: "https://installation.example.test",
    token: "fixture-only-client-token",
  };
  writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  const input = {
    managedWorker: true,
    environment: "container" as const,
    platform: "linux" as const,
    homeDir,
    uid: process.getuid?.(),
  };
  return { file, config, input };
}

test("paired managed Dev workers discover the existing private client when launcher inheritance is absent", () => {
  const { file, input } = fixture();
  expect(resolveManagedInstallationClient(input)).toBe(file);
  expect(
    resolveManagedInstallationClient({ ...input, configuredPath: "/explicit/client.json" }),
  ).toBe("/explicit/client.json");
});

test("standalone workers and Host do not adopt the Dev pairing client", () => {
  const { input } = fixture();
  expect(resolveManagedInstallationClient({ ...input, managedWorker: false })).toBeUndefined();
  expect(resolveManagedInstallationClient({ ...input, environment: undefined })).toBeUndefined();
  expect(resolveManagedInstallationClient({ ...input, environment: "host" })).toBeUndefined();
  expect(resolveManagedInstallationClient({ ...input, platform: "darwin" })).toBeUndefined();
});

test.each([
  "missing",
  "public",
  "symlink",
  "foreign-owner",
  "host-token",
  "http",
  "redirect-path",
  "malformed",
])("rejects %s client configuration without exposing its content", (failure) => {
  const { file, config, input } = fixture();
  if (failure === "missing") rmSync(file);
  if (failure === "public") chmodSync(file, 0o644);
  if (failure === "symlink") {
    const target = `${file}.original`;
    writeFileSync(target, JSON.stringify(config), { mode: 0o600 });
    rmSync(file);
    symlinkSync(target, file);
  }
  if (failure === "host-token")
    writeFileSync(file, JSON.stringify({ ...config, kind: "host-agent" }));
  if (failure === "http")
    writeFileSync(file, JSON.stringify({ ...config, origin: "http://installation.example.test" }));
  if (failure === "redirect-path")
    writeFileSync(file, JSON.stringify({ ...config, origin: `${config.origin}/path` }));
  if (failure === "malformed") writeFileSync(file, config.token);
  const uid = failure === "foreign-owner" ? -1 : input.uid;
  expect(() => resolveManagedInstallationClient({ ...input, uid })).toThrow(
    "The paired Dev installation client is missing or invalid. Repair its managed installation client before starting the daemon.",
  );
});
