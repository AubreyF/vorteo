import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const updater = createRequire(require.resolve("electron-updater"));
const { HttpExecutor } = updater("builder-util-runtime");
const headers = () => ({
  Authorization: "synthetic",
  "PRIVATE-TOKEN": "synthetic",
  "x_Api-Key": "synthetic",
  Cookie: "synthetic=value",
  Accept: "application/octet-stream",
});
const options = () => ({
  protocol: "https:",
  hostname: "source.invalid",
  path: "/release",
  headers: headers(),
});

for (const destination of [
  "https://other.invalid/release",
  "http://source.invalid/release",
  "https://source.invalid:8443/release",
]) {
  test(`updater removes known sensitive headers across origin boundary ${destination}`, () => {
    const result = HttpExecutor.prepareRedirectUrlOptions(destination, options());
    for (const name of Object.keys(headers()).filter((key) => key !== "Accept")) {
      assert.equal(result.headers[name], undefined, name);
    }
    assert.equal(result.headers.Accept, "application/octet-stream");
  });
}

test("updater retains authentication on same-origin redirects", () => {
  const result = HttpExecutor.prepareRedirectUrlOptions("https://source.invalid/next", options());
  for (const [name, value] of Object.entries(headers())) assert.equal(result.headers[name], value);
});
