import http from "node:http";
import net, { type AddressInfo } from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import { NetworkPolicy } from "./headless-host-network-policy.js";
import { startFilteringProxy, type FilteringProxy } from "./headless-host-proxy.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

async function upstreamServer(): Promise<number> {
  const server = http.createServer((request, response) => {
    response.end(`upstream saw ${request.method} ${request.url} host=${request.headers.host}`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise((resolve) => server.close(() => resolve())));
  return (server.address() as AddressInfo).port;
}

async function proxyWith(allowedHosts: string[], dns: Record<string, string[]> = {}) {
  const blocked: string[] = [];
  const proxy = await startFilteringProxy({
    policy: new NetworkPolicy(
      { deniedHosts: ["owner.example.com"], allowedHosts },
      async (host) => {
        const addresses = dns[host];
        if (!addresses) throw new Error("ENOTFOUND");
        return addresses;
      },
    ),
    onBlocked: ({ host }) => blocked.push(host),
  });
  cleanups.push(() => proxy.close());
  return { proxy, blocked };
}

function authorization(proxy: FilteringProxy): string {
  return `Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString("base64")}`;
}

function proxyGet(
  proxy: FilteringProxy,
  url: string,
  auth = true,
): Promise<{ status: number; body: string }> {
  const { port } = new URL(proxy.server);
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: "127.0.0.1",
      port: Number(port),
      method: "GET",
      path: url,
      headers: {
        host: new URL(url).host,
        ...(auth ? { "proxy-authorization": authorization(proxy) } : {}),
      },
    });
    request.on("response", (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => (body += chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
    });
    request.on("error", reject);
    request.end();
  });
}

function proxyConnect(proxy: FilteringProxy, authority: string): Promise<string> {
  const { port } = new URL(proxy.server);
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(port), "127.0.0.1", () => {
      socket.write(
        `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\nProxy-Authorization: ${authorization(proxy)}\r\n\r\n`,
      );
    });
    socket.once("data", (data) => {
      resolve(data.toString("utf8").split("\r\n")[0] ?? "");
      socket.destroy();
    });
    socket.on("error", reject);
  });
}

describe("startFilteringProxy", () => {
  test("requires its credentials", async () => {
    const { proxy } = await proxyWith([]);
    await expect(proxyGet(proxy, "http://example.com/", false)).resolves.toMatchObject({
      status: 407,
    });
  });

  test("forwards allowed requests to the checked address with the original host", async () => {
    const port = await upstreamServer();
    const { proxy } = await proxyWith([`preview.test:${port}`], { "preview.test": ["127.0.0.1"] });
    await expect(proxyGet(proxy, `http://preview.test:${port}/page?x=1`)).resolves.toEqual({
      status: 200,
      body: `upstream saw GET /page?x=1 host=preview.test:${port}`,
    });
  });

  test("refuses loopback, private resolution and denied hosts over HTTP", async () => {
    const port = await upstreamServer();
    const { proxy, blocked } = await proxyWith([], {
      "rebind.example.com": ["127.0.0.1"],
      "owner.example.com": ["93.184.215.14"],
    });
    for (const url of [
      `http://127.0.0.1:${port}/`,
      `http://localhost:${port}/`,
      `http://rebind.example.com:${port}/`,
      "http://owner.example.com/",
    ]) {
      await expect(proxyGet(proxy, url)).resolves.toMatchObject({ status: 403 });
    }
    expect(blocked).toEqual(["127.0.0.1", "localhost", "rebind.example.com", "owner.example.com"]);
  });

  test("refuses private CONNECT tunnels and opens allowed ones", async () => {
    const port = await upstreamServer();
    const { proxy } = await proxyWith([`127.0.0.1:${port}`], {
      "rebind.example.com": ["10.0.0.8"],
    });
    await expect(proxyConnect(proxy, "[::1]:443")).resolves.toBe("HTTP/1.1 403 Forbidden");
    await expect(proxyConnect(proxy, "rebind.example.com:443")).resolves.toBe(
      "HTTP/1.1 403 Forbidden",
    );
    await expect(proxyConnect(proxy, "100.100.100.100:443")).resolves.toBe(
      "HTTP/1.1 403 Forbidden",
    );
    await expect(proxyConnect(proxy, `127.0.0.1:${port}`)).resolves.toBe(
      "HTTP/1.1 200 Connection Established",
    );
  });
});

describe("startFilteringProxy address fallback", () => {
  test("tries each checked address until one connects", async () => {
    const port = await upstreamServer();
    // localhost commonly resolves to ::1 first; the upstream listens on IPv4 only.
    const { proxy } = await proxyWith([`localhost:${port}`], { localhost: ["::1", "127.0.0.1"] });
    await expect(proxyGet(proxy, `http://localhost:${port}/ok`)).resolves.toEqual({
      status: 200,
      body: `upstream saw GET /ok host=localhost:${port}`,
    });
  });
});
