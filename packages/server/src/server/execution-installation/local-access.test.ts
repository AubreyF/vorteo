import { expect, test } from "vitest";
import { localInstallationOrigin, localInstallationEnvironments } from "./local-access.js";

const config = { listenPort: 6770 };
test.each(["127.0.0.1:6770", "localhost:6770"])("accepts exact direct %s", (host) => {
  expect(
    localInstallationOrigin(config, { headers: { host }, socket: { remoteAddress: "127.0.0.1" } }),
  ).toBe(`http://${host}`);
});
test.each([
  { host: "127.0.0.1:6771" },
  { host: "localhost.evil.test:6770" },
  { host: "127.0.0.2:6770" },
  { host: "localhost:6770", forwarded: "host=localhost:6770" },
  { host: "localhost:6770", "x-forwarded-proto": "http" },
  { host: "localhost:6770", "x-forwarded-for": "127.0.0.1" },
])("rejects wrong authority and forwarded local access: %j", (headers) => {
  expect(
    localInstallationOrigin(config, { headers, socket: { remoteAddress: "127.0.0.1" } }),
  ).toBeNull();
});
test.each([undefined, "100.90.222.80", "192.168.1.2"])(
  "rejects non-loopback peer %s",
  (remoteAddress) => {
    expect(
      localInstallationOrigin(config, {
        headers: { host: "localhost:6770" },
        socket: { remoteAddress },
      }),
    ).toBeNull();
  },
);

test.each([
  "remote.example:6771",
  "127.0.0.1:6771/path",
  "owner@localhost:6771",
  "localhost:6771?token=private",
  "127.0.0.2:6771",
])("rejects unsafe local Host endpoint %s", (endpoint) => {
  expect(() =>
    localInstallationEnvironments({
      host: { endpoint, password: "fixture" },
      public: {
        version: 1,
        origin: "https://example.test",
        installationId: "fixture",
        environments: [],
      },
    }),
  ).toThrow();
});

test.each(["::1", "::ffff:127.0.0.1"])("accepts loopback socket peer %s", (remoteAddress) => {
  expect(
    localInstallationOrigin(config, {
      headers: { host: "localhost:6770" },
      socket: { remoteAddress },
    }),
  ).toBe("http://localhost:6770");
});

test("local descriptor preserves the Dev environment", () => {
  const dev = {
    kind: "container" as const,
    serverId: "dev-id",
    endpoint: "dev.example.test",
    useTls: true,
  };
  const environments = localInstallationEnvironments({
    host: { endpoint: "localhost:6771", password: "fixture" },
    public: {
      version: 1,
      origin: "https://example.test",
      installationId: "fixture",
      environments: [
        { kind: "host", serverId: "host-id", endpoint: "host.example.test", useTls: true },
        dev,
      ],
    },
  });
  expect(environments).toEqual([
    { kind: "host", serverId: "host-id", endpoint: "localhost:6771", useTls: false },
    dev,
  ]);
  expect(environments[1]).toBe(dev);
});
