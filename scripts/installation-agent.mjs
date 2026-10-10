#!/usr/bin/env node
import { readFileSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    config: { type: "string" },
    target: { type: "string" },
    update: { type: "boolean" },
    "supervisor-plan": { type: "string" },
    "factory-runtime-plan": { type: "string" },
    "factory-runtime-recovery-of": { type: "string" },
    repository: { type: "string" },
    "contribution-id": { type: "string" },
    replaces: { type: "string" },
    requester: { type: "string" },
    "reason-file": { type: "string" },
    "request-file": { type: "string" },
  },
});
if (
  values["supervisor-plan"] &&
  (values.update || values.target !== "container-daemon" || positionals[0] !== "request-restart")
)
  throw new Error("--supervisor-plan requires a Dev maintenance request, not a source update");
if (!values.config) throw new Error("An installed client config is required");
if (values["factory-runtime-recovery-of"] && !values["factory-runtime-plan"])
  throw new Error("Factory recovery requires --factory-runtime-plan");
const config = JSON.parse(readFileSync(values.config, "utf8"));
const base = new URL(config.origin);
const local = base.hostname === "127.0.0.1" || base.hostname === "localhost";
if (base.protocol !== "https:" && !(base.protocol === "http:" && local))
  throw new Error("TLS is required");
if (values["factory-runtime-plan"]) {
  if (
    config.kind !== "host-agent" ||
    values.update ||
    values["supervisor-plan"] ||
    values.target !== "container-daemon" ||
    positionals[0] !== "request-restart"
  )
    throw new Error("--factory-runtime-plan requires a separate trusted Host Dev adoption request");
  const response = await fetch(new URL("/api/installation/capabilities", base), {
    headers: { Authorization: `Bearer ${config.token}` },
    redirect: "error",
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok)
    throw new Error("Coordinator cannot advertise Factory adoption. No request submitted.");
  const capability = (await response.json()).factoryRuntimeAdoption;
  if (!capability?.available || capability.sha256 !== values["factory-runtime-plan"])
    throw new Error(
      "Reviewed Factory adoption plan is unavailable or changed. No request submitted.",
    );
}
if (values["supervisor-plan"]) {
  if (config.kind !== "host-agent")
    throw new Error("Supervisor maintenance requires the trusted Host client");
  const response = await fetch(new URL("/api/installation/capabilities", base), {
    headers: { Authorization: `Bearer ${config.token}` },
    redirect: "error",
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok)
    throw new Error("Coordinator cannot advertise supervisor maintenance. No restart requested.");
  const capability = (await response.json()).supervisorMaintenance;
  if (!capability?.available || capability.sha256 !== values["supervisor-plan"])
    throw new Error("Reviewed supervisor plan is unavailable or changed. No restart requested.");
}
let resource;
let body;
switch (positionals[0]) {
  case "capabilities":
    resource = "/api/installation/capabilities";
    break;
  case "request-helper": {
    if (config.kind !== "host-agent")
      throw new Error("Native helper maintenance requires the trusted Host client");
    if (!values["request-file"])
      throw new Error("Use --request-file with the exact prepared helper plan and request ID");
    const capabilityResponse = await fetch(new URL("/api/installation/capabilities", base), {
      headers: { Authorization: `Bearer ${config.token}` },
      redirect: "error",
      signal: AbortSignal.timeout(60_000),
    });
    if (!capabilityResponse.ok || !(await capabilityResponse.json()).nativeHelper?.available)
      throw new Error("Native helper maintenance is unavailable. No installation requested.");
    resource = "/api/installation/helper-requests";
    body = JSON.parse(readFileSync(values["request-file"], "utf8"));
    break;
  }
  case "helper-status":
    if (config.kind !== "host-agent")
      throw new Error("Native helper inspection requires the trusted Host client");
    if (!/^[a-f0-9-]{36}$/.test(positionals[1] ?? "")) throw new Error("A request ID is required");
    resource = `/api/installation/helper-requests/${positionals[1]}`;
    break;
  case "request-restart":
    if (!values["reason-file"])
      throw new Error("Use --reason-file with the disruption and restart reason");
    resource = "/api/installation/restart-requests";
    body = {
      target: values.target,
      ...(values["supervisor-plan"] ? { supervisorPlanSha256: values["supervisor-plan"] } : {}),
      ...(values["factory-runtime-plan"]
        ? { factoryRuntimePlanSha256: values["factory-runtime-plan"] }
        : {}),
      ...(values["factory-runtime-recovery-of"]
        ? { factoryRuntimeRecoveryOf: values["factory-runtime-recovery-of"] }
        : {}),
      reason: readFileSync(values["reason-file"], "utf8"),
      ...(values.requester ? { requester: values.requester } : {}),
    };
    break;
  case "contribution-status":
    if (!/^[a-f0-9-]{36}$/.test(positionals[1] ?? ""))
      throw new Error("A contribution ID is required");
    resource = `/api/installation/source-contributions/${positionals[1]}`;
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
    throw new Error(
      "Commands: capabilities, request-restart, restart-status, contribution-status, request-helper, helper-status, container-agents (Host only)",
    );
}
let upload;
let metadata;
const contributionId = values["contribution-id"] ?? randomUUID();
if (values.update) {
  if (positionals[0] !== "request-restart" || !["host", "container-daemon"].includes(values.target))
    throw new Error("--update requires request-restart --target host or container-daemon");
  const sourceUrl = new URL("/api/installation/update-source", base);
  // COMPAT(containerSourceUpdates): legacy Host coordinators use the unqualified route.
  if (values.target === "container-daemon") sourceUrl.searchParams.set("target", values.target);
  const sourceResponse = await fetch(sourceUrl, {
    headers: { Authorization: `Bearer ${config.token}` },
    redirect: "error",
    signal: AbortSignal.timeout(60_000),
  });
  if (!sourceResponse.ok)
    throw new Error(
      `${values.target} update capability unavailable (${sourceResponse.status}). Inspect capabilities and repair or bootstrap the scoped installation updater on Host. No plain restart was requested.`,
    );
  const source = await sourceResponse.json();
  if (values.target === "container-daemon" && source.target !== values.target)
    throw new Error(
      "The coordinator does not advertise Dev source updates. Bootstrap it on Host; no upload or restart was requested.",
    );
  if (
    !/^[a-f0-9]{40}$/.test(source.baseCommit) ||
    !/^refs\/heads\/[a-zA-Z0-9_./-]+$/.test(source.integrationRef) ||
    !Number.isSafeInteger(source.maxBytes)
  )
    throw new Error("Invalid update source descriptor");
  const repository = path.resolve(values.repository ?? process.cwd());
  const git = (args) =>
    execFileSync("git", args, {
      cwd: repository,
      encoding: "utf8",
      maxBuffer: 8192,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  if (git(["status", "--porcelain"]))
    throw new Error("Commit changes in a clean integration checkout before requesting an update");
  const sourceCommit = git(["rev-parse", "HEAD"]);
  if (sourceCommit !== git(["rev-parse", source.integrationRef]))
    throw new Error("Checkout must match the installation integration branch");
  if (sourceCommit === source.baseCommit)
    throw new Error("This source revision is already installed");
  let baseCommit = source.baseCommit;
  if (source.sourceBatches && Array.isArray(source.baseCandidates)) {
    const known = source.baseCandidates.find((candidate) => {
      if (typeof candidate !== "string" || !/^[a-f0-9]{40}$/.test(candidate)) return false;
      try {
        git(["merge-base", "--is-ancestor", candidate, sourceCommit]);
        return true;
      } catch {
        return false;
      }
    });
    if (!known)
      throw new Error("Checkout must contain a known installed source base before upload");
    baseCommit = known;
  } else git(["merge-base", "--is-ancestor", baseCommit, sourceCommit]);
  const temporary = mkdtempSync(path.join(tmpdir(), "vorteo-source-update-"));
  try {
    const file = path.join(temporary, "source.bundle");
    git(["bundle", "create", file, `${baseCommit}..${source.integrationRef}`]);
    if (statSync(file).size > Math.min(source.maxBytes, 128 * 1024 * 1024))
      throw new Error("Source bundle exceeds the upload limit");
    upload = readFileSync(file);
    metadata = Buffer.from(
      JSON.stringify({
        request: body,
        ...(source.sourceBatches
          ? {
              contributionId: contributionId,
              ...(values.replaces ? { replaces: values.replaces } : {}),
            }
          : {}),
        update: {
          sourceCommit,
          baseCommit,
          sha256: createHash("sha256").update(upload).digest("hex"),
          bytes: upload.length,
        },
      }),
    ).toString("base64");
    if ((values.replaces || values["contribution-id"]) && !source.sourceBatches)
      throw new Error("Coordinator does not support source contributions");
    if (source.sourceBatches) process.stderr.write(`Contribution receipt: ${contributionId}\n`);
    resource = `/api/installation/source-update-requests?target=${values.target}${source.sourceBatches ? "&sourceBatches=1" : ""}`;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
let requestBody;
if (upload) requestBody = upload;
else if (body) requestBody = JSON.stringify(body);
const response = await fetch(new URL(resource, base), {
  method: body ? "POST" : "GET",
  headers: {
    Authorization: `Bearer ${config.token}`,
    "Content-Type": upload ? "application/octet-stream" : "application/json",
    ...(metadata ? { "x-vorteo-update": metadata } : {}),
  },
  body: requestBody,
  redirect: "error",
  signal: AbortSignal.timeout(60_000),
});
if (!response.ok) {
  const failure = await response.json().catch(() => null);
  const detail = typeof failure?.error === "string" ? `: ${failure.error}` : "";
  throw new Error(`Installation rejected the request (${response.status})${detail}`);
}
const result = await response.json();
if (
  positionals[0] === "request-helper" ||
  positionals[0] === "helper-status" ||
  positionals[0] === "request-restart" ||
  positionals[0] === "restart-status" ||
  positionals[0] === "contribution-status"
) {
  const publicOrigin = config.publicOrigin ?? config.origin;
  const approval = new URL("/settings/general", new URL(publicOrigin).origin);
  approval.searchParams.set("installation", "1");
  approval.searchParams.set("restart", result.batch?.id ?? result.id);
  result.approvalUrl = approval.href;
}
process.stdout.write(JSON.stringify(result, null, 2) + "\n");
