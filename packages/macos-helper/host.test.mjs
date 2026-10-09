import { afterEach, describe, expect, it } from "vitest";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { invokeHelper, privateFile, parseConfiguration } from "./host.mjs";

const directories = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function fixture() {
  const path = await mkdtemp(join(tmpdir(), "vorteo-helper-test-"));
  directories.push(path);
  return path;
}
describe("Host capability boundary", () => {
  it("does not include malformed private configuration in its error", () => {
    expect(() => parseConfiguration("private-capability-sentinel")).toThrow(
      "Invalid private helper configuration",
    );
    expect(() => parseConfiguration('{"token":"private-capability-sentinel"}')).toThrow(
      "Invalid private helper configuration",
    );
  });
  it("rejects arbitrary operations before opening private state", async () => {
    await expect(invokeHelper("execute-applescript")).rejects.toThrow(
      "Unsupported helper operation",
    );
  });
  it("accepts an owner-only regular capability file", async () => {
    const path = join(await fixture(), "config.json");
    await writeFile(path, "{}", { mode: 0o600 });
    await expect(privateFile(path)).resolves.toBeUndefined();
  });
  it("rejects a group-readable capability file", async () => {
    const path = join(await fixture(), "config.json");
    await writeFile(path, "{}", { mode: 0o600 });
    await chmod(path, 0o640);
    await expect(privateFile(path)).rejects.toThrow("Unsafe helper private path");
  });
  it("rejects symlinks even when the destination is private", async () => {
    const root = await fixture();
    const path = join(root, "config.json");
    await writeFile(path, "{}", { mode: 0o600 });
    await symlink(path, join(root, "link"));
    await expect(privateFile(join(root, "link"))).rejects.toThrow("Unsafe helper private path");
  });
  it("rejects a writable runtime directory", async () => {
    const path = await fixture();
    await chmod(path, 0o770);
    await expect(privateFile(path, true)).rejects.toThrow("Unsafe helper private path");
  });
});
