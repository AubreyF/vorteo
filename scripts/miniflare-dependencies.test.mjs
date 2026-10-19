import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const consumers = [
  ["root", "../node_modules/miniflare/package.json"],
  ["app", "../packages/app/node_modules/miniflare/package.json"],
  ["website", "../packages/website/node_modules/miniflare/package.json"],
];

for (const [name, manifest] of consumers) {
  test(
    `${name} Miniflare serves requests and transforms images with its patched dependencies`,
    { timeout: 30000 },
    async () => {
      const require = createRequire(new URL(manifest, import.meta.url));
      const { Miniflare } = require("miniflare");
      const sharp = require("sharp");
      const png = await sharp({
        create: { width: 4, height: 3, channels: 4, background: "#6699cc" },
      })
        .png()
        .toBuffer();
      const runtime = new Miniflare({
        modules: true,
        compatibilityDate: "2024-12-01",
        cf: false,
        images: { binding: "IMAGES" },
        outboundService: () =>
          new Response("External network is disabled in this test", { status: 403 }),
        script: `export default {
        async fetch(request, env) {
          const pathname = new URL(request.url).pathname;
          if (pathname === '/') return new Response('ready');
          try {
            if (pathname === '/info') return Response.json(await env.IMAGES.info(request.body));
            const image = await env.IMAGES.input(request.body).transform({ width: 2, height: 2 }).output({ format: 'image/png' });
            const response = image.response();
            // Consume the stream here so deferred decoder errors reach the catch.
            return new Response(await response.arrayBuffer(), { status: response.status, headers: response.headers });
          } catch { return new Response('Invalid image', { status: 400 }); }
        }
      }`,
      });
      try {
        assert.equal(await (await runtime.dispatchFetch("http://local.test/")).text(), "ready");
        const info = await runtime.dispatchFetch("http://local.test/info", {
          method: "POST",
          body: png,
        });
        assert.equal(info.status, 200);
        const metadata = await info.json();
        assert.equal(metadata.width, 4);
        assert.equal(metadata.height, 3);
        const transformed = await runtime.dispatchFetch("http://local.test/resize", {
          method: "POST",
          body: png,
        });
        assert.equal(transformed.status, 200);
        assert.equal(transformed.headers.get("content-type"), "image/png");
        const output = await sharp(Buffer.from(await transformed.arrayBuffer())).metadata();
        assert.equal(output.width, 2);
        assert.equal(output.height, 2);
        const svg =
          '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="3"><rect width="4" height="3" fill="blue"/></svg>';
        const rasterized = await runtime.dispatchFetch("http://local.test/resize", {
          method: "POST",
          body: svg,
        });
        assert.equal(rasterized.status, 200);
        const svgOutput = await sharp(Buffer.from(await rasterized.arrayBuffer())).metadata();
        assert.equal(svgOutput.format, "png");
        assert.equal(svgOutput.width, 2);
        assert.equal(svgOutput.height, 2);
        const invalid = await runtime.dispatchFetch("http://local.test/info", {
          method: "POST",
          body: "not an image",
        });
        assert.equal(invalid.status, 400);
      } finally {
        await runtime.dispose();
      }
    },
  );
}
