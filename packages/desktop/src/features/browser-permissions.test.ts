import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createBrowserPermissionStore,
  decideBrowserPermissions,
  permissionOrigin,
  requestedPermissions,
} from "./browser-permissions.js";

const dirs: string[] = [];
async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), "vorteo-permissions-"));
  dirs.push(dir);
  return { dir, store: await createBrowserPermissionStore(dir) };
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
const site = { origin: "https://example.com", topOrigin: "https://example.com" };

describe("browser permission choices", () => {
  it("accepts only unambiguous web origins and separates media types", () => {
    expect(permissionOrigin("https://example.com/path")).toBe(site.origin);
    for (const url of [
      "file:///tmp/site",
      "data:text/html,x",
      "null",
      "https://user@example.com",
      "paseo://app",
    ])
      expect(permissionOrigin(url)).toBeNull();
    expect(requestedPermissions("media", ["audio", "video", "audio"])).toEqual([
      "microphone",
      "camera",
    ]);
    expect(requestedPermissions("media", ["unknown"])).toEqual([]);
    expect(requestedPermissions("media")).toEqual([]);
    expect(requestedPermissions("usb")).toEqual([]);
  });

  it("asks again unless remembering was explicitly selected", async () => {
    const { store, dir } = await fixture();
    const prompt = vi.fn().mockResolvedValue({ allow: true, remember: false });
    const request = () =>
      decideBrowserPermissions({
        store,
        site,
        permissions: ["camera"],
        isCurrent: () => true,
        prompt,
      });
    expect(await request()).toBe(true);
    expect(await request()).toBe(true);
    expect(prompt).toHaveBeenCalledTimes(2);
    expect((await createBrowserPermissionStore(dir)).get(site, "camera")).toBeUndefined();
  });

  it("persists both allow and block without extending them to another permission, origin or embedding site", async () => {
    const { store, dir } = await fixture();
    await Promise.all([
      store.remember(site, "camera", true, store.generation),
      store.remember(site, "microphone", false, store.generation),
    ]);
    const restored = await createBrowserPermissionStore(dir);
    expect(restored.get(site, "camera")).toBe(true);
    expect(restored.get(site, "microphone")).toBe(false);
    expect(restored.get(site, "location")).toBeUndefined();
    expect(restored.get({ ...site, origin: "https://other.com" }, "camera")).toBeUndefined();
    expect(restored.get({ ...site, topOrigin: "https://other.com" }, "camera")).toBeUndefined();
    const prompt = vi.fn();
    expect(
      await decideBrowserPermissions({
        store: restored,
        site,
        permissions: ["camera", "microphone"],
        isCurrent: () => true,
        prompt,
      }),
    ).toBe(false);
    expect(prompt).not.toHaveBeenCalled();
  });

  it("prompts separately for camera and microphone", async () => {
    const { store } = await fixture();
    const prompt = vi
      .fn()
      .mockResolvedValueOnce({ allow: true, remember: true })
      .mockResolvedValueOnce({ allow: false, remember: true });
    expect(
      await decideBrowserPermissions({
        store,
        site,
        permissions: ["camera", "microphone"],
        isCurrent: () => true,
        prompt,
      }),
    ).toBe(false);
    expect(prompt.mock.calls).toEqual([["camera"], ["microphone"]]);
    expect(store.get(site, "camera")).toBe(true);
    expect(store.get(site, "microphone")).toBe(false);
  });

  it("does not grant or remember a response after navigation", async () => {
    const { store } = await fixture();
    let current = true;
    const result = await decideBrowserPermissions({
      store,
      site,
      permissions: ["camera"],
      isCurrent: () => current,
      prompt: async () => {
        current = false;
        return { allow: true, remember: true };
      },
    });
    expect(result).toBe(false);
    expect(store.get(site, "camera")).toBeUndefined();
  });

  it("reset revokes saved choices and invalidates outstanding decisions", async () => {
    const { store, dir } = await fixture();
    await store.remember(site, "camera", true, store.generation);
    const result = await decideBrowserPermissions({
      store,
      site,
      permissions: ["location"],
      isCurrent: () => true,
      prompt: async () => {
        await store.reset();
        return { allow: true, remember: true };
      },
    });
    expect(result).toBe(false);
    const restored = await createBrowserPermissionStore(dir);
    expect(restored.get(site, "camera")).toBeUndefined();
    expect(restored.get(site, "location")).toBeUndefined();
  });

  it("reset wins over an earlier queued write", async () => {
    const { store, dir } = await fixture();
    await Promise.all([store.remember(site, "camera", true, store.generation), store.reset()]);
    expect((await createBrowserPermissionStore(dir)).get(site, "camera")).toBeUndefined();
    expect(store.get(site, "camera")).toBeUndefined();
  });

  it("invalid saved data grants nothing", async () => {
    const { dir } = await fixture();
    await writeFile(
      path.join(dir, "browser-permissions.json"),
      JSON.stringify([[JSON.stringify([site.topOrigin, site.origin, "camera"]), "true"]]),
    );
    expect((await createBrowserPermissionStore(dir)).get(site, "camera")).toBeUndefined();
  });

  it("a failed write cannot silently become an in-memory remembered grant", async () => {
    const { dir } = await fixture();
    const file = path.join(dir, "not-a-directory");
    await writeFile(file, "x");
    const store = await createBrowserPermissionStore(file);
    await expect(store.remember(site, "camera", true, store.generation)).rejects.toThrow();
    expect(store.get(site, "camera")).toBeUndefined();
  });
});
