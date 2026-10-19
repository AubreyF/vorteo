import { it, expect, vi } from "vitest";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const home = vi.hoisted(() => ({ path: "" }));
vi.mock("node:os", async (original) => ({ ...(await original()), homedir: () => home.path }));
import { adapterEntry, invokeHelper } from "./dispatch.mjs";

it("dispatches the compatible protocol through selected bundle upgrade and rollback", async () => {
  home.path = await mkdtemp(join(tmpdir(), "vorteo-adapter-rollback-"));
  const app = join(home.path, "Applications/Vorteo Permission Helper.app");
  const previous = app + ".previous";
  const next = app + ".next";
  async function release(path, version) {
    await mkdir(join(path, "Contents/Resources/adapter"), { recursive: true });
    // Distinct wire behaviors exercise the real dispatcher and its stdin framing.
    const program = `let body = ""; for await (const part of process.stdin) body += part; const request = JSON.parse(body); process.stdout.write(JSON.stringify({ ok: request.protocol === ${version}, code: "protocol-${version}" }));`;
    await writeFile(adapterEntry(path), program);
  }
  const call = (version) => invokeHelper("status", { parameters: { protocol: version } });
  try {
    await release(app, 1);
    await release(next, 2);
    expect(await call(1)).toEqual({ ok: true, code: "protocol-1" });
    await rename(app, previous);
    await rename(next, app);
    expect(await call(2)).toEqual({ ok: true, code: "protocol-2" });
    expect((await call(1)).ok).toBe(false);
    await rename(app, next);
    await rename(previous, app);
    expect(await call(1)).toEqual({ ok: true, code: "protocol-1" });
    expect((await call(2)).ok).toBe(false);
  } finally {
    await rm(home.path, { recursive: true, force: true });
  }
});
