import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "vitest";
import { ClaudeSetupTokenStore } from "./setup-token-store.js";

const credential = {
  version: 1,
  accessToken: `sk-ant-oat01-${"synthetic".repeat(8)}`,
  createdAt: 1,
};

test("private atomic replacement and removal preserve account history", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "setup-store-"));
  const directory = join(root, "auth");
  const store = new ClaudeSetupTokenStore({ directory });
  try {
    await fs.writeFile(join(root, "history.jsonl"), "history");
    expect(await store.read()).toBeNull();
    await store.write(credential);
    expect(await store.read()).toEqual(credential);
    expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(join(directory, "claude-setup-token.json"))).mode & 0o777).toBe(0o600);
    const failing = new ClaudeSetupTokenStore({
      directory,
      files: {
        ...fs,
        rename: async () => {
          throw new Error(credential.accessToken);
        },
      },
    });
    await expect(failing.write({ ...credential, createdAt: 2 })).rejects.toThrow(
      /^Claude subscription sign-in could not be completed\. Start sign-in again\.$/,
    );
    expect(await store.read()).toEqual(credential);
    expect(await fs.readdir(directory)).toEqual(["claude-setup-token.json"]);
    await store.remove();
    expect(await store.read()).toBeNull();
    expect(await fs.readFile(join(root, "history.jsonl"), "utf8")).toBe("history");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("rejects refresh grants, unknown fields, linked files and cancellation before commit", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "setup-store-"));
  const directory = join(root, "auth");
  const store = new ClaudeSetupTokenStore({ directory });
  try {
    await expect(store.write({ ...credential, refreshToken: "never" })).rejects.toThrow();
    await store.write(credential);
    const cancellation = new AbortController();
    cancellation.abort();
    await expect(
      store.write({ ...credential, createdAt: 2 }, cancellation.signal),
    ).rejects.toThrow();
    expect(await store.read()).toEqual(credential);
    await store.remove();
    await fs.writeFile(join(root, "outside"), JSON.stringify(credential), { mode: 0o600 });
    await fs.symlink(join(root, "outside"), join(directory, "claude-setup-token.json"));
    await expect(store.read()).rejects.toThrow();
    await expect(store.write(credential)).rejects.toThrow();
    await expect(store.remove()).rejects.toThrow();
    expect(await fs.readFile(join(root, "outside"), "utf8")).toBe(JSON.stringify(credential));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
