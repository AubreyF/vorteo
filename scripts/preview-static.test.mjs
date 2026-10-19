import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { get } from "node:http";
import { fileURLToPath } from "node:url";
import { sealArtifact } from "./instance-web-artifact.mjs";

test("sealed static preview enforces its origin and exposes only sealed assets", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sealed-preview-"));
  let child;
  try {
    await writeFile(path.join(root, "index.html"), "<title>Preview</title>");
    await sealArtifact(root, { deployment: null });
    await writeFile(path.join(root, "private.txt"), "not in the export");
    const reservation = createServer();
    reservation.listen(0, "127.0.0.1");
    await once(reservation, "listening");
    const port = reservation.address().port;
    await new Promise((resolve) => reservation.close(resolve));
    child = spawn(
      process.execPath,
      [fileURLToPath(new URL("./preview-static.mjs", import.meta.url)), "--directory", root],
      {
        env: {
          ...process.env,
          PASEO_PORT: String(port),
          PASEO_PREVIEW_ORIGIN: "https://preview.example.ts.net:44446",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    await Promise.race([
      once(child.stdout, "data"),
      once(child, "exit").then(() => {
        throw Error("Preview failed to start");
      }),
    ]);
    const base = `http://127.0.0.1:${port}`;
    assert.equal((await fetch(base)).status, 200);
    assert.equal(
      (await fetch(base + "/settings/appearance", { headers: { Accept: "text/html" } })).status,
      200,
    );
    assert.equal((await fetch(base + "/private.txt")).status, 404);
    assert.equal((await fetch(base + "/.build-manifest.json")).status, 404);
    assert.equal(
      (await fetch(base, { headers: { Origin: "https://unrelated.example" } })).status,
      403,
    );
    const wrongHost = await new Promise((resolve, reject) => {
      get(base, { headers: { Host: "unrelated.example" } }, (response) => {
        response.resume();
        resolve(response.statusCode);
      }).on("error", reject);
    });
    assert.equal(wrongHost, 403);
    assert.equal((await fetch(base, { method: "POST" })).status, 405);
  } finally {
    if (child && child.exitCode === null) {
      child.kill();
      await once(child, "exit");
    }
    await rm(root, { recursive: true, force: true });
  }
});
