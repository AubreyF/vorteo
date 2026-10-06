#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    config: { type: "string" },
    target: { type: "string" },
    requester: { type: "string" },
    "reason-file": { type: "string" },
    "request-file": { type: "string" },
  },
});
if (!values.config) throw new Error("An installed client config is required");
const config = JSON.parse(readFileSync(values.config, "utf8"));
const base = new URL(config.origin);
const local = base.hostname === "127.0.0.1" || base.hostname === "localhost";
if (base.protocol !== "https:" && !(base.protocol === "http:" && local))
  throw new Error("TLS is required");
let resource;
let body;
switch (positionals[0]) {
  case "request-restart":
    if (!values["reason-file"])
      throw new Error("Use --reason-file with the disruption and restart reason");
    resource = "/api/installation/restart-requests";
    body = {
      target: values.target,
      reason: readFileSync(values["reason-file"], "utf8"),
      ...(values.requester ? { requester: values.requester } : {}),
    };
    break;
  case "restart-status":
    if (!/^[a-f0-9-]{36}$/.test(positionals[1] ?? "")) throw new Error("A request ID is required");
    resource = `/api/installation/restart-requests/${positionals[1]}`;
    break;
  case "container-agents":
    if (config.kind !== "host-agent")
      throw new Error("Container agents cannot address another environment");
    if (!values["request-file"])
      throw new Error("Use --request-file with the explicit container operation");
    resource = "/api/installation/container-agents";
    body = JSON.parse(readFileSync(values["request-file"], "utf8"));
    break;
  default:
    throw new Error("Commands: request-restart, restart-status, container-agents (host only)");
}
const response = await fetch(new URL(resource, base), {
  method: body ? "POST" : "GET",
  headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
  ...(body ? { body: JSON.stringify(body) } : {}),
  redirect: "error",
  signal: AbortSignal.timeout(60_000),
});
if (!response.ok) throw new Error(`Installation rejected the request (${response.status})`);
const result = await response.json();
if (positionals[0] === "request-restart" || positionals[0] === "restart-status") {
  const publicOrigin = config.publicOrigin ?? config.origin;
  const approval = new URL("/settings/general", new URL(publicOrigin).origin);
  approval.searchParams.set("installation", "1");
  approval.searchParams.set("restart", result.id);
  result.approvalUrl = approval.href;
}
process.stdout.write(JSON.stringify(result, null, 2) + "\n");
