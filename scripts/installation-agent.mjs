#!/usr/bin/env node
import { readFileSync, mkdtempSync, rmSync, statSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

/** This client is copied alone into Dev. Use built-ins, not an undeclared
 * dispatcher dependency, to avoid fetch's shorter independent headers timeout.
 * One deadline covers connection, headers and body; failure never retries. */
export async function postCoordinatorRequest(url, options, timers = { setTimeout, clearTimeout }) {
  const send = url.protocol === "https:" ? httpsRequest : httpRequest;
  if (
    url.username ||
    url.password ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname)))
  )
    throw new Error("TLS without URL credentials is required");
  const controller = new AbortController();
  const timer = timers.setTimeout(() => controller.abort(), 16 * 60_000);
  let request;
  try {
    const incoming = await new Promise((resolve, reject) => {
      request = send(
        url,
        {
          method: "POST",
          headers: options.headers,
          agent: false,
          signal: controller.signal,
        },
        resolve,
      );
      request.once("error", reject);
      request.end(options.body);
    });
    // Never forward scoped credentials or a preparation to a redirect target.
    if (incoming.statusCode >= 300 && incoming.statusCode < 400)
      throw new Error(
        "Coordinator preparation redirected; inspect the retained request before retrying",
      );
    const chunks = [];
    for await (const chunk of incoming) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    return new Response(bytes.length ? bytes : null, { status: incoming.statusCode });
  } finally {
    timers.clearTimeout(timer);
    request?.destroy();
  }
}

/** Session host job commands need a coordinator that advertises them to this token. */
async function requireSessionHostJob(base, config) {
  const response = await fetch(new URL("/api/installation/capabilities", base), {
    headers: { Authorization: `Bearer ${config.token}` },
    redirect: "error",
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok || (await response.json()).sessionHostJob?.available !== true)
    throw new Error(
      "The coordinator does not advertise session host jobs to this client. No request submitted.",
    );
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: "string" },
      target: { type: "string" },
      update: { type: "boolean" },
      "require-owner-approval": { type: "boolean" },
      "supervisor-plan": { type: "string" },
      "factory-runtime-plan": { type: "string" },
      "factory-runtime-recovery-of": { type: "string" },
      repository: { type: "string" },
      "contribution-id": { type: "string" },
      replaces: { type: "string" },
      requester: { type: "string" },
      "reason-file": { type: "string" },
      "request-file": { type: "string" },
      install: { type: "boolean" },
      remove: { type: "boolean" },
      reason: { type: "string" },
      "instructions-file": { type: "string" },
      "base-revision": { type: "string" },
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
  if (values["require-owner-approval"]) {
    if (
      config.kind !== "host-agent" ||
      !["request-restart", "request-coordinator"].includes(positionals[0]) ||
      values["factory-runtime-plan"] ||
      (positionals[0] === "request-restart" &&
        !["host", "container-daemon"].includes(values.target))
    )
      throw new Error(
        "--require-owner-approval requires a trusted Host restart, source update, supervisor or coordinator request",
      );
    const response = await fetch(new URL("/api/installation/capabilities", base), {
      headers: { Authorization: `Bearer ${config.token}` },
      redirect: "error",
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok || (await response.json()).requireOwnerApproval !== true)
      throw new Error(
        "Coordinator does not advertise explicit owner approval. No request or upload submitted.",
      );
  }
  if (values["factory-runtime-plan"]) {
    if (
      config.kind !== "host-agent" ||
      values.update ||
      values["supervisor-plan"] ||
      values.target !== "container-daemon" ||
      positionals[0] !== "request-restart"
    )
      throw new Error(
        "--factory-runtime-plan requires a separate trusted Host Dev adoption request",
      );
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
    case "monitor-inspect":
      if (config.kind !== "host-agent")
        throw new Error("Monitor inspection requires trusted Host client");
      resource = "/api/installation/monitor-selection";
      break;
    case "request-monitor": {
      if (config.kind !== "host-agent")
        throw new Error("Preview monitor maintenance requires the trusted Host client");
      if (!values["request-file"])
        throw new Error("Use --request-file with the exact prepared monitor plan and request ID");
      const capabilityResponse = await fetch(new URL("/api/installation/capabilities", base), {
        headers: { Authorization: `Bearer ${config.token}` },
        redirect: "error",
        signal: AbortSignal.timeout(60_000),
      });
      if (!capabilityResponse.ok || !(await capabilityResponse.json()).previewMonitor?.available)
        throw new Error("Preview monitor maintenance is unavailable. No installation requested.");
      resource = "/api/installation/monitor-requests";
      body = JSON.parse(readFileSync(values["request-file"], "utf8"));
      break;
    }
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
    case "request-session-host": {
      if (config.kind !== "host-agent")
        throw new Error("Session host job requests require the trusted Host client");
      if (Boolean(values.install) === Boolean(values.remove))
        throw new Error("Use exactly one of --install or --remove");
      await requireSessionHostJob(base, config);
      resource = "/api/installation/session-host-requests";
      // The coordinator derives the plan itself; the request names only the operation.
      body = {
        id: randomUUID(),
        operation: values.install ? "session-host-install" : "session-host-remove",
        reason:
          values.reason?.trim() || "Requested by a Host agent through the installation client.",
      };
      break;
    }
    case "session-host-status":
      await requireSessionHostJob(base, config);
      resource = "/api/installation/session-host";
      break;
    case "monitor-status":
      if (config.kind !== "host-agent")
        throw new Error("Preview monitor inspection requires the trusted Host client");
      if (!/^[a-f0-9-]{36}$/.test(positionals[1] ?? ""))
        throw new Error("A request ID is required");
      resource = `/api/installation/monitor-requests/${positionals[1]}`;
      break;
    case "helper-status":
      if (config.kind !== "host-agent")
        throw new Error("Native helper inspection requires the trusted Host client");
      if (!/^[a-f0-9-]{36}$/.test(positionals[1] ?? ""))
        throw new Error("A request ID is required");
      resource = `/api/installation/helper-requests/${positionals[1]}`;
      break;
    case "request-coordinator": {
      if (!values["request-file"])
        throw new Error(
          "Use --request-file with the exact coordinator preparation and retained request ID",
        );
      if (
        values.target ||
        values.update ||
        values["supervisor-plan"] ||
        values["factory-runtime-plan"]
      )
        throw new Error("Coordinator maintenance requires a separate preparation request");
      const preparation = JSON.parse(readFileSync(values["request-file"], "utf8"));
      if (!/^[a-f0-9-]{36}$/.test(preparation.id ?? ""))
        throw new Error("The coordinator preparation must contain a retained request ID");
      const capabilityResponse = await fetch(new URL("/api/installation/capabilities", base), {
        headers: { Authorization: `Bearer ${config.token}` },
        redirect: "error",
        signal: AbortSignal.timeout(60_000),
      });
      if (!capabilityResponse.ok)
        throw new Error("Coordinator capability is unavailable. No preparation submitted.");
      const capability = (await capabilityResponse.json()).coordinatorMaintenance;
      if (!capability?.available)
        throw new Error(
          "Coordinator preparation is unavailable. Inspect retained requests; no preparation submitted.",
        );
      if (
        capability.ownerApprovalRequired === false &&
        !capability.automaticAvailable &&
        !values["require-owner-approval"]
      )
        throw new Error(
          "Automatic coordinator preparation is unavailable. Update the Host or request explicit owner review; no preparation submitted.",
        );
      resource = "/api/installation/coordinator-requests";
      body = {
        preparation,
        ...(values["require-owner-approval"] ? { requireOwnerApproval: true } : {}),
      };
      process.stderr.write(`Coordinator request: ${preparation.id}\n`);
      break;
    }
    case "coordinator-status":
      if (!/^[a-f0-9-]{36}$/.test(positionals[1] ?? ""))
        throw new Error("A request ID is required");
      resource = `/api/installation/coordinator-requests/${positionals[1]}`;
      break;
    case "request-worker-launch": {
      if (config.kind !== "container-agent" || !values["request-file"] || !values["reason-file"])
        throw new Error("Use the Dev requester with --request-file hints and --reason-file");
      const response = await fetch(new URL("/api/installation/capabilities", base), {
        headers: { Authorization: `Bearer ${config.token}` },
        redirect: "error",
      });
      const capabilities = response.ok ? await response.json() : null;
      if (capabilities?.workerLaunch?.available !== true)
        throw new Error(
          "Protected Linux worker launch capability is unavailable; no launch requested",
        );
      resource = "/api/installation/restart-requests?workerLaunch=1";
      body = {
        target: "container-daemon",
        reason: readFileSync(values["reason-file"], "utf8"),
        workerLaunchRequest: JSON.parse(readFileSync(values["request-file"], "utf8")),
        ...(values.requester ? { requester: values.requester } : {}),
      };
      break;
    }
    case "worker-launch-status":
      if (!/^[a-f0-9-]{36}$/.test(positionals[1] ?? ""))
        throw new Error("A request ID is required");
      resource = `/api/installation/restart-requests/${positionals[1]}?workerLaunch=1`;
      break;
    case "request-restart":
      if (!values["reason-file"])
        throw new Error("Use --reason-file with the disruption and restart reason");
      resource = "/api/installation/restart-requests";
      body = {
        target: values.target,
        ...(values["require-owner-approval"] ? { requireOwnerApproval: true } : {}),
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
      if (!/^[a-f0-9-]{36}$/.test(positionals[1] ?? ""))
        throw new Error("A request ID is required");
      // Batch details include each contribution's merge result, such as a conflict.
      resource = `/api/installation/restart-requests/${positionals[1]}?sourceBatches=1`;
      break;
    case "read-instructions":
      // Prints the shared agent instructions and the revision a change must be based on.
      resource = "/api/installation/settings/admission";
      break;
    case "request-instructions": {
      if (!values["instructions-file"] || !values["base-revision"] || !values.reason?.trim())
        throw new Error(
          "Use --instructions-file with the complete new instructions, --base-revision from read-instructions, and --reason",
        );
      if (!/^\d+$/.test(values["base-revision"]))
        throw new Error("--base-revision must be the revision printed by read-instructions");
      resource = "/api/installation/instruction-requests";
      body = {
        appendSystemPrompt: readFileSync(values["instructions-file"], "utf8"),
        baseRevision: Number(values["base-revision"]),
        reason: values.reason.trim(),
        requester: values.requester?.trim() || `${config.kind} through the installation client`,
      };
      break;
    }
    case "instructions-status":
      if (!/^[a-f0-9-]{36}$/.test(positionals[1] ?? ""))
        throw new Error("A request ID is required");
      resource = `/api/installation/instruction-requests/${positionals[1]}`;
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
        "Commands: capabilities, request-worker-launch, worker-launch-status, request-restart, restart-status, contribution-status, request-coordinator, coordinator-status, request-helper, helper-status, request-session-host --install|--remove, session-host-status, read-instructions, request-instructions, instructions-status, container-agents (Host only)",
      );
  }
  let upload;
  let metadata;
  const contributionId = values["contribution-id"] ?? randomUUID();
  if (values.update) {
    if (
      positionals[0] !== "request-restart" ||
      !["host", "container-daemon"].includes(values.target)
    )
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
  const requestUrl = new URL(resource, base);
  if (["request-restart", "restart-status", "contribution-status"].includes(positionals[0]))
    requestUrl.searchParams.set("requireOwnerApproval", "1");
  const requestOptions = {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${config.token}`,
      "Content-Type": upload ? "application/octet-stream" : "application/json",
      ...(metadata ? { "x-vorteo-update": metadata } : {}),
    },
    body: requestBody,
  };
  const response =
    positionals[0] === "request-coordinator"
      ? await postCoordinatorRequest(requestUrl, requestOptions)
      : await fetch(requestUrl, {
          ...requestOptions,
          redirect: "error",
          signal: AbortSignal.timeout(60_000),
        });
  if (!response.ok) {
    const failure = await response.json().catch(() => null);
    const detail = typeof failure?.error === "string" ? `: ${failure.error}` : "";
    throw new Error(`Installation rejected the request (${response.status})${detail}`);
  }
  let result = await response.json();
  if (
    positionals[0] === "request-monitor" ||
    positionals[0] === "monitor-status" ||
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
  if (["request-restart", "restart-status"].includes(positionals[0])) reportBatchConflicts(result);
  if (positionals[0] === "request-session-host") {
    // The link opens Installation controls, where the owner reviews the plan and presses Approve.
    const review = new URL(
      "/settings/general",
      new URL(config.publicOrigin ?? config.origin).origin,
    );
    review.searchParams.set("installation", "1");
    review.searchParams.set("sessionHost", result.id);
    result = {
      id: result.id,
      operation: result.operation,
      status: result.status,
      stage: result.stage,
      planSha256: result.planSha256,
      approvalUrl: review.href,
    };
  }
  if (positionals[0] === "read-instructions") {
    result = { revision: result.revision, appendSystemPrompt: result.settings?.appendSystemPrompt };
  }
  if (["request-instructions", "instructions-status"].includes(positionals[0])) {
    // The owner reviews the full text in Installation controls and presses Approve.
    const review = new URL(
      "/settings/general",
      new URL(config.publicOrigin ?? config.origin).origin,
    );
    review.searchParams.set("installation", "1");
    review.searchParams.set("instructions", result.id);
    const { appendSystemPrompt: _text, ...summary } = result;
    result = { ...summary, approvalUrl: review.href };
  }
  if (["request-coordinator", "coordinator-status"].includes(positionals[0])) {
    const approval = new URL(
      "/settings/general",
      new URL(config.publicOrigin ?? config.origin).origin,
    );
    approval.searchParams.set("installation", "1");
    approval.searchParams.set("bootstrap", result.id);
    result.approvalUrl = approval.href;
  }
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

/**
 * A conflicted source batch stays pending and is never approved, automatically or by the owner,
 * until its contribution is corrected. Say so plainly instead of leaving it to the JSON.
 */
function reportBatchConflicts(result) {
  const batch = result.batch?.sourceBatch ?? result.sourceBatch;
  if (batch?.status !== "conflict" || !Array.isArray(batch.contributions)) return;
  for (const contribution of batch.contributions) {
    if (contribution?.status !== "conflict") continue;
    const where =
      String(contribution.detail ?? "")
        .split("\n")[0]
        .trim() || "the current source";
    process.stderr.write(
      `Source batch conflict: contribution ${contribution.id} conflicts in ${where}. ` +
        `Rebase it on the current source and resubmit with --replaces ${contribution.id}.\n`,
    );
  }
}
