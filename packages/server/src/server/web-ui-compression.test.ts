import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { ExecutionInstallationSchema } from "@getpaseo/protocol/execution-installation";
import { prepareWebUiHtml } from "./web-ui.js";

const HTML =
  "<!doctype html><html><head></head><body>" +
  "bounded startup payload ".repeat(2000) +
  "</body></html>";
const LABEL = "fixture </script><script>private sentinel</script>";

async function response(acceptEncoding?: string) {
  return prepareWebUiHtml({
    html: HTML,
    label: LABEL,
    req: {
      protocol: "https",
      headers: { host: "fixture.invalid", "accept-encoding": acceptEncoding },
    },
  });
}

describe("final injected HTML content encoding", () => {
  it.each(["br", "gzip"])(
    "compresses final injected bytes using %s without a second payload download",
    async (encoding) => {
      const identity = await response();
      const encoded = await response(encoding);
      const decoded =
        encoding === "br" ? brotliDecompressSync(encoded.body) : gunzipSync(encoded.body);
      expect(encoded.status).toBe(200);
      expect(encoded.contentEncoding).toBe(encoding);
      expect(decoded).toEqual(identity.body);
      expect(encoded.body.length).toBeLessThan(identity.body.length / 4);
      expect(decoded.toString()).toContain("window.__PASEO_INITIAL_DAEMON_CONNECTION__");
      expect(decoded.toString()).toContain('"listen":"fixture.invalid"');
      expect(decoded.toString()).toContain('"useTls":true');
      expect(decoded.toString()).not.toContain(LABEL);
      expect(decoded.toString().match(/__PASEO_INITIAL_DAEMON_CONNECTION__/g)).toHaveLength(1);
    },
  );

  it.each([
    [undefined, null],
    ["", null],
    ["br, gzip", "br"],
    ["br;q=0, gzip", "gzip"],
    ["gzip;q=1, br;q=0.5", "gzip"],
    ["br;q=0, gzip;q=0", null],
    ["gzip;q=0.5, identity;q=0", "gzip"],
    ["gzip;q=0.5", null],
    ["br;q=0.001, gzip;q=0.999, identity;q=0", "gzip"],
    ["*;q=0.5, identity;q=0", "br"],
    ["br;q=invalid, gzip", "gzip"],
    ["zebra", null],
    ["BR;Q=1, GZIP;Q=0", "br"],
    ["br;q=1;q=0, gzip", "gzip"],
    ["br;q=0, br;q=1, gzip", "gzip"],
  ])("negotiates %s with explicit exclusions and quality", async (header, expected) => {
    const result = await response(header);
    expect(result.status).toBe(200);
    expect(result.contentEncoding).toBe(expected);
  });

  it.each(["*;q=0", "identity;q=0,br;q=0,gzip;q=0"])(
    "refuses %s when no available representation is acceptable",
    async (header) => {
      const result = await response(header);
      expect(result.status).toBe(406);
      expect(result.contentEncoding).toBeNull();
      expect(result.body.length).toBe(0);
    },
  );

  it("preserves the installation descriptor in every encoding and does not inject a second hint", async () => {
    const installation = ExecutionInstallationSchema.parse({
      version: 1,
      installationId: "00000000-0000-4000-8000-000000000001",
      origin: "https://fixture.invalid",
      environments: [
        { kind: "host", serverId: "fixture-host", endpoint: "fixture.invalid/host", useTls: true },
        {
          kind: "container",
          serverId: "fixture-dev",
          endpoint: "fixture.invalid/dev",
          useTls: true,
        },
      ],
    });
    for (const encoding of [undefined, "br", "gzip"]) {
      const result = await prepareWebUiHtml({
        html: HTML,
        label: "fixture",
        installation,
        req: {
          protocol: "https",
          headers: { host: "fixture.invalid", "accept-encoding": encoding },
        },
      });
      let decoded = result.body;
      if (encoding === "br") decoded = brotliDecompressSync(decoded);
      if (encoding === "gzip") decoded = gunzipSync(decoded);
      expect(decoded.toString()).toContain(JSON.stringify(installation));
      expect(decoded.toString()).not.toContain("__PASEO_INITIAL_DAEMON_CONNECTION__");
      expect(decoded.toString().match(/__VORTEO_EXECUTION_INSTALLATION__/g)).toHaveLength(1);
    }
  });
});
