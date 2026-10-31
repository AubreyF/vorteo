#!/usr/bin/env node
// SSH ProxyCommand for gate mode: tunnels one TCP connection through the
// installation gate with HTTP CONNECT, so SSH follows the same policy and
// audit log as every other connection. Usage: gate-connect HOST PORT
import net from "node:net";

const [host, port] = process.argv.slice(2);
const proxy = new URL(process.env.HTTPS_PROXY || process.env.https_proxy || "");
if (!host || !/^\d+$/.test(port ?? "") || proxy.protocol !== "http:") {
  console.error("Usage: gate-connect HOST PORT, with HTTPS_PROXY set to the gate");
  process.exit(2);
}
const target = host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
const headers = [`CONNECT ${target} HTTP/1.1`, `Host: ${target}`];
if (proxy.username) {
  const user = decodeURIComponent(proxy.username);
  const secret = decodeURIComponent(proxy.password);
  headers.push(`Proxy-Authorization: Basic ${Buffer.from(`${user}:${secret}`).toString("base64")}`);
}
const socket = net.connect(Number(proxy.port || 80), proxy.hostname);
socket.write(headers.join("\r\n") + "\r\n\r\n");
let pending = Buffer.alloc(0);
socket.on("data", function onHeader(chunk) {
  pending = Buffer.concat([pending, chunk]);
  const end = pending.indexOf("\r\n\r\n");
  if (end === -1) {
    if (pending.length > 16384) process.exit(1);
    return;
  }
  socket.off("data", onHeader);
  const status = pending.subarray(0, end).toString("latin1").split("\r\n")[0];
  if (!/^HTTP\/1\.[01] 200 /.test(status)) {
    console.error(`gate refused ${target}: ${status}`);
    process.exit(1);
  }
  const rest = pending.subarray(end + 4);
  if (rest.length) process.stdout.write(rest);
  socket.pipe(process.stdout);
  process.stdin.pipe(socket);
});
socket.on("error", (error) => {
  console.error(`gate-connect: ${error.message}`);
  process.exit(1);
});
socket.on("close", () => process.exit(0));
