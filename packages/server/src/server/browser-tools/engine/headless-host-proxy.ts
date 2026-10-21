import { randomBytes, timingSafeEqual } from "node:crypto";
import http, { type IncomingHttpHeaders, type IncomingMessage } from "node:http";
import net, { type Socket } from "node:net";
import type { NetworkPolicy } from "./headless-host-network-policy.js";

// A loopback forward proxy that every Chromium request goes through. It
// resolves each destination itself, applies the network policy to the
// resolved addresses, and connects to the exact address it checked, so DNS
// rebinding and redirects cannot reach a refused destination. Random
// credentials keep other local processes from using it.

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export interface FilteringProxy {
  server: string;
  username: string;
  password: string;
  close(): Promise<void>;
}

export interface FilteringProxyInput {
  policy: NetworkPolicy;
  onBlocked?: (detail: { host: string; reason: string }) => void;
}

function splitAuthority(
  authority: string,
  defaultPort: number,
): { host: string; port: number } | null {
  const match = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(authority);
  if (!match?.[1]) return null;
  const port = match[2] ? Number(match[2]) : defaultPort;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  return { host: match[1], port };
}

function forwardHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const result: IncomingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase())) result[name] = value;
  }
  return result;
}

// Rebuilds an origin-form upgrade request without proxy credentials.
function serializeUpgradeRequest(request: IncomingMessage, target: URL): string {
  const lines = [`${request.method} ${target.pathname}${target.search} HTTP/1.1`];
  for (const [name, value] of Object.entries(request.headers)) {
    if (name.toLowerCase().startsWith("proxy-") || value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${item}`);
  }
  return `${lines.join("\r\n")}\r\n\r\n`;
}

export async function startFilteringProxy(input: FilteringProxyInput): Promise<FilteringProxy> {
  const username = "vorteo";
  const password = randomBytes(24).toString("hex");
  const expected = Buffer.from(
    `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
  );
  const sockets = new Set<Socket>();

  function authorized(request: IncomingMessage): boolean {
    const header = Buffer.from(request.headers["proxy-authorization"] ?? "");
    return header.length === expected.length && timingSafeEqual(header, expected);
  }

  async function decide(host: string, port: number): Promise<string[] | null> {
    const decision = await input.policy.check(host, port);
    if (decision.allowed && decision.addresses.length > 0) return decision.addresses;
    const reason = decision.allowed ? `${host} has no address` : decision.reason;
    input.onBlocked?.({ host, reason });
    return null;
  }

  // Connects to the first reachable checked address, in resolver order.
  async function connectFirst(addresses: readonly string[], port: number): Promise<Socket | null> {
    for (const address of addresses) {
      const socket = await new Promise<Socket | null>((resolve) => {
        const candidate = net.connect({ host: address, port });
        candidate.once("connect", () => resolve(candidate));
        candidate.once("error", () => {
          candidate.destroy();
          resolve(null);
        });
      });
      if (socket) {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
        return socket;
      }
    }
    return null;
  }

  function refuseSocket(socket: Socket, status: string, extra = ""): void {
    socket.end(`HTTP/1.1 ${status}\r\n${extra}Connection: close\r\nContent-Length: 0\r\n\r\n`);
  }

  const server = http.createServer((request, response) => {
    void (async () => {
      if (!authorized(request)) {
        response.writeHead(407, { "Proxy-Authenticate": 'Basic realm="browser"' }).end();
        return;
      }
      let target: URL;
      try {
        target = new URL(request.url ?? "");
      } catch {
        response.writeHead(400).end();
        return;
      }
      if (target.protocol !== "http:") {
        response.writeHead(400).end();
        return;
      }
      const port = target.port ? Number(target.port) : 80;
      const addresses = await decide(target.hostname, port);
      if (!addresses) {
        response
          .writeHead(403, { "Content-Type": "text/plain" })
          .end("Blocked by browser policy\n");
        return;
      }
      const socket = await connectFirst(addresses, port);
      if (!socket) {
        response.writeHead(502).end();
        return;
      }
      const upstream = http.request({
        agent: false,
        createConnection: () => socket,
        port,
        method: request.method,
        path: `${target.pathname}${target.search}`,
        headers: forwardHeaders(request.headers),
        setHost: false,
      });
      upstream.on("response", (upstreamResponse) => {
        response.writeHead(
          upstreamResponse.statusCode ?? 502,
          forwardHeaders(upstreamResponse.headers),
        );
        upstreamResponse.pipe(response);
      });
      upstream.on("error", () => {
        if (!response.headersSent) response.writeHead(502);
        response.end();
      });
      request.pipe(upstream);
    })().catch(() => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
  });

  // HTTPS and secure WebSockets arrive as CONNECT tunnels.
  server.on("connect", (request: IncomingMessage, client: Socket, head: Buffer) => {
    sockets.add(client);
    client.once("close", () => sockets.delete(client));
    client.on("error", () => client.destroy());
    void (async () => {
      if (!authorized(request)) {
        refuseSocket(
          client,
          "407 Proxy Authentication Required",
          'Proxy-Authenticate: Basic realm="browser"\r\n',
        );
        return;
      }
      const authority = splitAuthority(request.url ?? "", 443);
      const addresses = authority ? await decide(authority.host, authority.port) : null;
      if (!authority || !addresses) {
        refuseSocket(client, "403 Forbidden");
        return;
      }
      const upstream = await connectFirst(addresses, authority.port);
      if (!upstream) {
        refuseSocket(client, "502 Bad Gateway");
        return;
      }
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
      upstream.on("error", () => client.destroy());
      client.once("close", () => upstream.destroy());
    })().catch(() => client.destroy());
  });

  // Plain-text WebSockets can arrive as absolute-form upgrade requests.
  server.on("upgrade", (request: IncomingMessage, client: Socket, head: Buffer) => {
    sockets.add(client);
    client.once("close", () => sockets.delete(client));
    client.on("error", () => client.destroy());
    void (async () => {
      if (!authorized(request)) {
        refuseSocket(
          client,
          "407 Proxy Authentication Required",
          'Proxy-Authenticate: Basic realm="browser"\r\n',
        );
        return;
      }
      let target: URL;
      try {
        target = new URL(request.url ?? "");
      } catch {
        refuseSocket(client, "400 Bad Request");
        return;
      }
      const port = target.port ? Number(target.port) : 80;
      const addresses =
        target.protocol === "http:" || target.protocol === "ws:"
          ? await decide(target.hostname, port)
          : null;
      if (!addresses) {
        refuseSocket(client, "403 Forbidden");
        return;
      }
      const upstream = await connectFirst(addresses, port);
      if (!upstream) {
        refuseSocket(client, "502 Bad Gateway");
        return;
      }
      upstream.write(serializeUpgradeRequest(request, target));
      if (head.length > 0) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
      upstream.on("error", () => client.destroy());
      client.once("close", () => upstream.destroy());
    })().catch(() => client.destroy());
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Proxy has no port.");

  return {
    server: `http://127.0.0.1:${address.port}`,
    username,
    password,
    async close() {
      for (const socket of sockets) socket.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
