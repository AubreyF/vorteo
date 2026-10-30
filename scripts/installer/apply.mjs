// Executes a plan step by step, and the lifecycle commands that work from its journal.
// Every line written through `emit` is one JSON object: {step, status, message, fix?},
// with status "start", "done", "skip" or "fail".
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describeServices, localOrigins } from "./coordinator-config.mjs";
import { JOURNAL } from "./detect.mjs";
import { buildRelease, serveRouteTarget } from "./host-installation.mjs";
import { createJournalHandle, openJournal, readJournal } from "./journal.mjs";
import { createLaunchdManager } from "./launchd.mjs";
import { PLAN_VERSION, publicOrigin } from "./plan.mjs";
import { InstallerError } from "./primitives.mjs";
import { STEPS, STEP_TITLES, pointLink, remoteRoutes } from "./steps.mjs";
import { ADOPTION_STEPS, ADOPTION_STEP_TITLES } from "./host-adoption.mjs";
import { createSystemdManager } from "./systemd.mjs";
import { createProcessManager } from "./process-manager.mjs";

// Looked up when a step runs: host-adoption.mjs imports this module, so its tables are
// not ready while this module first loads.
const stepFor = (name) => STEPS[name] ?? ADOPTION_STEPS[name];
const titleFor = (name) => STEP_TITLES[name] ?? ADOPTION_STEP_TITLES[name];

const RERUN =
  "Fix the problem above, then run the same apply command again; it resumes at this step.";

export function createServiceManager(kind, context) {
  const options = { run: context.run, uid: context.uid, home: context.home, user: context.user };
  if (kind === "launchd") return createLaunchdManager(options);
  if (kind === "systemd-user") return createSystemdManager(options);
  if (kind === "process") return createProcessManager(options);
  throw new InstallerError(`Unknown service manager ${kind}.`, "Plan again on this machine.");
}

export function validatePlan(plan, context) {
  if (!plan || plan.version !== PLAN_VERSION || !Array.isArray(plan.steps))
    throw new InstallerError("This is not an installer plan.", "Create one with `main.mjs plan`.");
  if (plan.platform !== context.platform)
    throw new InstallerError(
      `The plan is for ${plan.platform}, not ${context.platform}.`,
      "Plan again on this machine.",
    );
  if (path.resolve(plan.paths.root) !== context.root)
    throw new InstallerError(
      `The plan installs into ${plan.paths.root}, not ${context.root}.`,
      "Pass the plan's folder with --root, or plan again.",
    );
  const unknown = plan.steps.filter((step) => !stepFor(step));
  if (unknown.length)
    throw new InstallerError(
      `Unknown plan steps: ${unknown.join(", ")}.`,
      "Plan again with this installer.",
    );
  return plan;
}

export function installResult(plan, outputs) {
  return {
    origin: outputs.origin ?? publicOrigin(plan, outputs.hostname),
    localOrigin: localOrigins(plan)[0],
    passwordFile: plan.paths.ownerPassword,
    name: plan.name,
  };
}

async function runSteps(steps, state, emit, { force = false } = {}) {
  for (const step of steps) {
    if (!force && state.journal.isDone(step)) {
      emit({ step, status: "skip", message: "Already done." });
      continue;
    }
    emit({ step, status: "start", message: titleFor(step) });
    let result;
    try {
      result = await stepFor(step)(state);
    } catch (error) {
      state.journal.mark(step, "fail", error.message);
      emit({ step, status: "fail", message: error.message, fix: error.fix ?? RERUN });
      return false;
    }
    state.journal.mark(step, "done", result?.skip ?? result?.message);
    if (result?.skip) emit({ step, status: "skip", message: result.skip });
    else
      emit({
        step,
        status: "done",
        message: result.message,
        ...(result.fix ? { fix: result.fix } : {}),
      });
  }
  return true;
}

/** Applies `plan`, resuming after the last completed step. Returns false on failure. */
export async function applyPlan(plan, context, emit) {
  validatePlan(plan, context);
  const journal = openJournal(plan, context.now);
  const state = {
    plan: journal.data.plan,
    context,
    journal,
    outputs: journal.data.outputs,
    manager: createServiceManager(plan.services.manager, context),
  };
  if (!(await runSteps(state.plan.steps, state, emit))) return false;
  emit({ result: installResult(state.plan, state.outputs) });
  return true;
}

function loadInstallation(context) {
  const file = path.join(context.root, JOURNAL);
  const data = readJournal(file);
  if (!data)
    throw new InstallerError(
      `No installation journal in ${context.root}.`,
      "Pass the installation folder with --root.",
    );
  const journal = createJournalHandle(file, data, context.now);
  return {
    plan: data.plan,
    context,
    journal,
    outputs: data.outputs,
    manager: createServiceManager(data.plan.services.manager, context),
  };
}

async function dockerHealth(state) {
  try {
    return await state.context.run(state.plan.executables.docker, [
      "inspect",
      "--format",
      "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}",
      `${state.outputs.instance}-paseo-1`,
    ]);
  } catch {
    return "missing";
  }
}

function lifecycleState(journal) {
  if (journal.uninstalledAt) return "uninstalled";
  return journal.completedAt ? "installed" : "installing";
}

export async function installationStatus(context) {
  const state = loadInstallation(context);
  const { plan, journal, manager } = state;
  const services = {};
  for (const service of describeServices(plan))
    services[service.role] = {
      label: service.label,
      registered: await manager.isRegistered(service.label),
    };
  let coordinatorReady = false;
  try {
    const response = await context.fetch(
      `http://127.0.0.1:${plan.ports.coordinator}/api/installation/health`,
      {
        signal: AbortSignal.timeout(3000),
      },
    );
    const body = await response.json();
    coordinatorReady = response.ok && body.installationId === plan.installationId;
  } catch {
    /* not listening */
  }
  const devHealth = plan.devContainer && state.outputs.instance ? await dockerHealth(state) : null;
  const result = installResult(plan, state.outputs);
  return {
    installationId: plan.installationId,
    name: plan.name,
    state: lifecycleState(journal.data),
    kind: plan.kind,
    ...result,
    access: { local: result.localOrigin },
    steps: journal.data.steps,
    services,
    coordinator: { ready: coordinatorReady },
    environments: statusEnvironments(plan, state.outputs, coordinatorReady, devHealth),
    ...(devHealth !== null
      ? {
          dev: { deployment: plan.paths.container, health: devHealth },
          gate: { log: path.join(plan.paths.container, "gate", "logs", "connections.jsonl") },
        }
      : {}),
  };
}

/** Each environment's identity and readiness, from the coordinator configuration. */
function statusEnvironments(plan, outputs, coordinatorReady, devHealth) {
  let configured = [];
  try {
    configured = JSON.parse(readFileSync(plan.paths.coordinatorConfig, "utf8")).public.environments;
  } catch {
    return [];
  }
  return configured.map((environment) => {
    const status = {
      kind: environment.kind,
      serverId: environment.serverId,
      ready: environment.kind === "host" ? coordinatorReady : devHealth === "healthy",
    };
    if (environment.kind === "container" && outputs.instance)
      status.container = `${outputs.instance}-paseo-1`;
    return status;
  });
}

/** Removes the routes this installation added, leaving any route that changed owner. */
async function removeRoutes(state, emit) {
  const { plan, context, outputs } = state;
  if (plan.remote.mode !== "tailscale" || !outputs.hostname) return;
  const serve = JSON.parse(
    await context.run(plan.executables.tailscale, ["serve", "status", "--json"]),
  );
  for (const { port, target } of remoteRoutes(plan)) {
    const current = serveRouteTarget(serve, outputs.hostname, port);
    if (current === target)
      await context.run(plan.executables.tailscale, ["serve", `--https=${port}`, "off"]);
    else if (current)
      emit({
        step: "remote",
        status: "skip",
        message: `Left HTTPS port ${port}; it now belongs to ${current}.`,
      });
  }
}

async function stopDev(state, { keepData }) {
  const { plan, context } = state;
  const deployment = plan.paths.container;
  if (!plan.devContainer || !existsSync(path.join(deployment, ".container-installation")))
    return "No Dev container to stop.";
  if (plan.kind !== "new") {
    // The adopted deployment returns to the standalone Tailscale mode it came from.
    await context.run("bash", [path.join(deployment, "gate.sh"), "rollback"], {
      timeout: 10 * 60_000,
    });
    return `Returned ${deployment} to its standalone Tailscale mode. Its data is untouched.`;
  }
  await context.run(
    "bash",
    [
      "-c",
      'deployment="$1"; source "$deployment/common.sh"; paseo_compose down',
      "compose-down",
      deployment,
    ],
    { timeout: 10 * 60_000 },
  );
  return keepData ? `Stopped Dev; ${deployment} is kept.` : `Stopped Dev.`;
}

/**
 * Stops and unregisters this installation's services, routes and Dev container. With
 * `keepData`, every file stays; otherwise the Host, state and a Dev deployment created
 * by this installation are deleted. The source folder, the Projects folder and an
 * adopted deployment are never deleted.
 */
// Progress titles while removing, so uninstall never reads as installing.
const REMOVAL_TITLES = {
  remote: "Removing Tailscale HTTPS routes",
  services: "Stopping the Host and coordinator services",
  dev: "Stopping the Dev container",
  data: "Deleting installation data",
};

export async function uninstall(context, { keepData }, emit) {
  const state = loadInstallation(context);
  const { plan, manager, journal } = state;
  const step = async (name, action) => {
    emit({
      step: name,
      status: "start",
      message: REMOVAL_TITLES[name] ?? STEP_TITLES[name] ?? name,
    });
    try {
      emit({ step: name, status: "done", message: await action() });
      return true;
    } catch (error) {
      emit({
        step: name,
        status: "fail",
        message: error.message,
        fix: error.fix ?? "Fix the problem above, then run uninstall again.",
      });
      return false;
    }
  };
  const sessionHost = `${plan.services.coordinator.replace(/\.installation$/, "")}.session-host`;
  const steps = [
    [
      "session-host",
      async () => {
        if ((await manager.isRegistered(sessionHost)) || existsSync(manager.file(sessionHost)))
          throw new InstallerError(
            `The session host job ${sessionHost} still runs sessions.`,
            "Remove it from Installation controls, then run uninstall again.",
          );
        return "No session host job is running.";
      },
    ],
    [
      "remote",
      async () => (await removeRoutes(state, emit), "Removed this installation's HTTPS routes."),
    ],
    [
      "services",
      async () => {
        for (const service of describeServices(plan).toReversed())
          await manager.remove(service.label, path.join(plan.paths.host, "disabled-services"));
        return "Stopped and unregistered the Host daemon and coordinator.";
      },
    ],
    ["dev", () => stopDev(state, { keepData })],
  ];
  for (const [name, action] of steps) if (!(await step(name, action))) return false;
  if (keepData) {
    journal.data.uninstalledAt = context.now().toISOString();
    journal.save();
    emit({ step: "data", status: "skip", message: `Kept every file in ${plan.paths.root}.` });
    return true;
  }
  const removed = [
    plan.paths.host,
    plan.paths.state,
    ...(plan.kind === "new" && plan.devContainer ? [plan.paths.container] : []),
  ];
  for (const directory of removed) rmSync(directory, { recursive: true, force: true });
  emit({
    step: "data",
    status: "done",
    message: `Deleted ${removed.join(", ")}. Kept ${plan.paths.source} and ${plan.paths.projectsFolder}.`,
  });
  return true;
}

/** Rewrites and re-registers the services, then reruns the idempotent checks and routes. */
export async function repair(context, emit) {
  const state = loadInstallation(context);
  const { plan, manager } = state;
  if (!existsSync(plan.paths.record))
    throw new InstallerError(
      "The installation was never configured.",
      "Run apply with its plan to finish it.",
    );
  emit({
    step: "services",
    status: "start",
    message: "Re-registering the Host and coordinator services",
  });
  try {
    for (const service of describeServices(plan)) {
      manager.write(service);
      await manager.reload(service.label);
    }
  } catch (error) {
    emit({
      step: "services",
      status: "fail",
      message: error.message,
      fix: error.fix ?? "Fix the problem above, then run repair again.",
    });
    return false;
  }
  emit({
    step: "services",
    status: "done",
    message: "Re-registered the Host daemon and coordinator.",
  });
  // dev-create and dev-adopt start an existing deployment again instead of creating one.
  const steps = [
    ...plan.steps.filter((step) => ["dev-create", "dev-adopt", "dev-identity"].includes(step)),
    "ready",
    ...(plan.remote.mode === "tailscale" ? ["remote"] : []),
  ];
  // Repair reruns these steps even when the journal already marks them done.
  return runSteps(steps, state, emit, { force: true });
}

/**
 * The Host step of an interface upgrade on an installation this engine created: build the
 * release for `revision` from the source checkout (the coordinator already fetched and
 * verified its tag), point the Host link at it and restart the Host daemon. The
 * coordinator replaces itself afterwards through its own link. Writes `outcome` as JSON.
 */
export async function hostRelease(context, { revision, outcome }) {
  const report = (value) => writeFileSync(outcome, JSON.stringify(value) + "\n", { mode: 0o600 });
  try {
    if (!/^[0-9a-f]{40}$/.test(revision ?? ""))
      throw new InstallerError("A 40-character revision is required.", "Pass --revision <commit>.");
    const { plan, manager } = loadInstallation(context);
    const release = path.join(plan.paths.host, "releases", revision);
    const marker = path.join(release, ".installer-release.json");
    const built =
      existsSync(marker) && JSON.parse(readFileSync(marker, "utf8")).revision === revision;
    if (!built) {
      const nodeDirectory = path.dirname(plan.executables.node);
      const tools = { npm: plan.executables.npm, git: plan.executables.git };
      await buildRelease({
        release,
        revision,
        sourceDirectory: plan.paths.source,
        logDir: plan.paths.logs,
        runCommand: (command, args, options = {}) =>
          context.run(tools[command] ?? command, args, {
            ...options,
            env: {
              ...process.env,
              ...options.env,
              PATH: `${nodeDirectory}:${process.env.PATH ?? ""}`,
            },
          }),
      });
      writeFileSync(
        marker,
        JSON.stringify({ revision, builtAt: context.now().toISOString() }) + "\n",
      );
    }
    pointLink(plan.paths.hostReleaseLink, release);
    await manager.restart(plan.services.host);
    report({ status: "succeeded", release, detail: `The Host runs ${revision.slice(0, 12)}.` });
    return true;
  } catch (error) {
    report({ status: "failed", detail: error.message, ...(error.fix ? { fix: error.fix } : {}) });
    return false;
  }
}
