import path from "node:path";
import { open, lstat, realpath, link, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { userInfo } from "node:os";
import { z } from "zod";
import type {
  CoordinatorBootstrapPlan,
  CoordinatorBootstrapRequest,
} from "@getpaseo/protocol/coordinator-bootstrap";
import { BootstrapRequestConflict } from "./coordinator-bootstrap.js";
import {
  assertBootstrapPathsProtected,
  readBootstrapPreparedFile,
  readProtectedDocument,
  verifyBootstrapPreparedDependency,
  digestBootstrapArtifact,
} from "./coordinator-bootstrap-artifact.js";
import { readBootstrapLauncher } from "./coordinator-bootstrap-service.js";

/** A login service survives logout and reboot as retained configuration. It
 * runs after the Host account logs in; it cannot promise pre-login recovery. */
export function bootstrapRecoveryLauncher(plan: CoordinatorBootstrapPlan) {
  const recovery = plan.bootRecovery;
  if (!recovery) throw new BootstrapRequestConflict("Boot recovery is not in the approved plan");
  return {
    Label: recovery.service.split("/").slice(2).join("/"),
    ProgramArguments: [
      "/usr/bin/python3",
      "-I",
      "-B",
      recovery.ownerLauncher.path,
      path.join(plan.state.directory, "coordinator-bootstrap-execution.lock"),
      recovery.node.path,
      recovery.entrypoint.path,
      recovery.setup.path,
      "boot-watchdog",
      recovery.requestId,
    ],
    RunAtLoad: true,
    // The recovery runner owns a persistent retry budget. launchd must never
    // turn a failed or completed operation into an unlimited execution loop.
    KeepAlive: false,
    ProcessType: "Background",
    Umask: 0o077,
    StandardErrorPath: path.join(
      plan.state.directory,
      `coordinator-boot-${recovery.requestId}.stderr`,
    ),
  };
}

/** Host account identity and home come from the native account, not the plan.
 * This validates inert configuration; it does not register or start a service. */
export function verifyBootstrapRecoveryLauncher(input: {
  plan: CoordinatorBootstrapPlan;
  hostUid: number;
  hostHome: string;
  launcher: unknown;
  /** Supplied only after reading the plan-addressed protected executor setup. */
  runtimeDirectory?: string;
}): void {
  const { plan } = input;
  const recovery = plan.bootRecovery;
  if (!recovery) throw new BootstrapRequestConflict("Boot recovery is not in the approved plan");
  const expectedService = `${plan.service}-recovery-${recovery.requestId}`;
  const label = expectedService.split("/").slice(2).join("/");
  const expectedLauncher = path.join(input.hostHome, "Library", "LaunchAgents", `${label}.plist`);
  if (
    !plan.service.startsWith(`gui/${input.hostUid}/`) ||
    recovery.service !== expectedService ||
    recovery.installedLauncher !== expectedLauncher ||
    recovery.launcher.path === recovery.installedLauncher
  )
    throw new BootstrapRequestConflict(
      "Boot recovery must use its own Host account startup service",
    );
  const directory = input.runtimeDirectory ?? plan.candidate.directory;
  const separateExecutor = input.runtimeDirectory !== undefined;
  if (
    (!separateExecutor && !isDeepStrictEqual(recovery.node, plan.candidate.node)) ||
    recovery.entrypoint.path !==
      path.join(
        directory,
        "packages/server/dist/server/server/execution-installation/coordinator-bootstrap-runner.js",
      ) ||
    recovery.ownerLauncher.path !== path.join(directory, "scripts/run-coordinator-owner.py")
  )
    throw new BootstrapRequestConflict("Boot recovery must use the approved candidate runner");
  if (!isDeepStrictEqual(input.launcher, bootstrapRecoveryLauncher(plan)))
    throw new BootstrapRequestConflict(
      "Boot recovery launcher changes unapproved startup settings",
    );
}

/** The existing plan-addressed setup may pin an executor separate from the
 * target. Its entire protected runtime and Node are verified before use. */
export async function verifyBootstrapRecoveryArtifacts(
  plan: CoordinatorBootstrapPlan,
  writableMountRoots: readonly string[],
): Promise<void> {
  const recovery = plan.bootRecovery;
  if (!recovery) return;
  for (const file of [recovery.ownerLauncher, recovery.entrypoint])
    await readBootstrapPreparedFile(file, writableMountRoots);
  const bytes = await readBootstrapPreparedFile(recovery.setup, writableMountRoots);
  const fileSchema = z.strictObject({ path: z.string(), sha256: z.string() });
  const setup = z
    .object({
      node: fileSchema,
      entrypoint: fileSchema,
      ownerLauncher: fileSchema,
      runtimeDirectory: z.string(),
      runtimeSha256: z.string(),
      ownershipVerifier: fileSchema,
    })
    .parse(JSON.parse(bytes.toString("utf8")));
  if (
    !isDeepStrictEqual(setup.node, recovery.node) ||
    !isDeepStrictEqual(setup.entrypoint, recovery.entrypoint) ||
    !isDeepStrictEqual(setup.ownerLauncher, recovery.ownerLauncher) ||
    setup.ownershipVerifier.path !==
      path.join(setup.runtimeDirectory, "scripts/verify-coordinator-owner.py")
  )
    throw new BootstrapRequestConflict("Boot recovery setup does not match its approved runner");
  const independent = setup.runtimeDirectory !== plan.candidate.directory;
  if (!independent && setup.runtimeSha256 !== plan.candidate.artifactSha256)
    throw new BootstrapRequestConflict("Boot recovery runtime differs from the reviewed candidate");
  await assertBootstrapPathsProtected(
    [
      setup.runtimeDirectory,
      path.dirname(recovery.installedLauncher),
      recovery.node.path,
      setup.ownershipVerifier.path,
    ],
    writableMountRoots,
  );
  const account = userInfo();
  verifyBootstrapRecoveryLauncher({
    plan,
    hostUid: account.uid,
    hostHome: account.homedir,
    launcher: await readBootstrapLauncher(recovery.launcher, writableMountRoots),
    ...(independent ? { runtimeDirectory: setup.runtimeDirectory } : {}),
  });
  await readBootstrapPreparedFile(setup.ownershipVerifier, writableMountRoots);
  if (independent) {
    // A hash-valid older runtime can still implement candidate-bound execution.
    // Select the versioned contract before reservation, not after it strands a claim.
    const metadata = await readProtectedDocument(
      path.join(setup.runtimeDirectory, "packages/server/package.json"),
    );
    const support = z.object({
      vorteoRuntimeContracts: z.object({ independentCoordinatorExecutor: z.literal(1) }),
    });
    if (!support.safeParse(JSON.parse(metadata.toString("utf8"))).success)
      throw new BootstrapRequestConflict(
        "Prepared runtime does not support independent coordinator execution",
      );
    await verifyBootstrapPreparedDependency(recovery.node, writableMountRoots);
    const actual = await digestBootstrapArtifact(setup.runtimeDirectory, {
      maxFiles: 10_000,
      maxBytes: 1024 * 1024 * 1024,
      timeoutMs: 30_000,
    });
    if (actual !== setup.runtimeSha256)
      throw new BootstrapRequestConflict("Independent recovery executor runtime changed");
  }
}

interface StartupRecoveryRegistration {
  request: CoordinatorBootstrapRequest;
  writableMountRoots: readonly string[];
  /** Recheck the kernel lock and exact claimed generation before each effect. */
  requireClaim(): Promise<void>;
  verifyServiceAbsent(): Promise<void>;
  register(serviceDomain: string, launcherFile: string): Promise<void>;
  verifyRegistered(): Promise<void>;
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** This is invoked only inside the approved executor's ownership fence. An
 * uncertain registration is never retried; the persisted launcher can resume
 * the same request after login without replaying the installation. */
export async function registerBootstrapRecovery(
  input: StartupRecoveryRegistration,
  verifyArtifacts: typeof verifyBootstrapRecoveryArtifacts = verifyBootstrapRecoveryArtifacts,
): Promise<void> {
  const { request } = input;
  const recovery = request.plan.bootRecovery;
  if (
    !recovery ||
    recovery.requestId !== request.id ||
    request.status !== "approved" ||
    request.execution?.stage !== "claimed"
  )
    throw new BootstrapRequestConflict("Startup registration requires an exact claimed approval");
  await input.requireClaim();
  await verifyArtifacts(request.plan, input.writableMountRoots);
  const parent = path.dirname(recovery.installedLauncher);
  const before = await lstat(parent);
  if (
    (await realpath(parent)) !== parent ||
    !before.isDirectory() ||
    before.uid !== process.getuid?.() ||
    (before.mode & 0o022) !== 0
  )
    throw new BootstrapRequestConflict("Startup service directory must be canonical and protected");
  await input.verifyServiceAbsent();
  const bytes = await readBootstrapPreparedFile(recovery.launcher, input.writableMountRoots);
  await input.requireClaim();
  const receipt = path.join(
    request.plan.state.directory,
    `coordinator-boot-registration-${request.execution.generation}.json`,
  );
  const intent = await open(receipt, "wx", 0o600);
  try {
    await intent.writeFile(
      JSON.stringify({
        version: 1,
        requestId: request.id,
        generation: request.execution.generation,
        planSha256: request.planSha256,
      }),
    );
    await intent.sync();
  } finally {
    await intent.close();
  }
  await syncDirectory(request.plan.state.directory);
  const temporary = path.join(parent, `.installation-recovery-${randomUUID()}`);
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await input.requireClaim();
    const current = await lstat(parent);
    if (
      before.dev !== current.dev ||
      before.ino !== current.ino ||
      before.mode !== current.mode ||
      (await realpath(parent)) !== parent
    )
      throw new BootstrapRequestConflict("Startup service directory changed");
    // Exclusive link publishes complete bytes atomically and never replaces an
    // existing startup service. Drop the temporary name before hash verification.
    await link(temporary, recovery.installedLauncher);
  } finally {
    await unlink(temporary);
  }
  await syncDirectory(parent);
  await readBootstrapPreparedFile(
    { ...recovery.launcher, path: recovery.installedLauncher },
    input.writableMountRoots,
  );
  await input.requireClaim();
  await input.register(
    recovery.service.split("/").slice(0, 2).join("/"),
    recovery.installedLauncher,
  );
  await input.verifyRegistered();
  await input.requireClaim();
}

/** Terminal recovery no longer needs a login hook. Remove only the exact
 * approved file; an altered selection requires inspection and is left alone. */
export async function removeCompletedBootstrapRecovery(input: {
  request: CoordinatorBootstrapRequest;
  writableMountRoots: readonly string[];
  requireTerminal(): Promise<void>;
}): Promise<void> {
  const { request } = input;
  const recovery = request.plan.bootRecovery;
  if (!recovery) return;
  if (
    !request.execution ||
    !["succeeded", "resumed", "rolled_back"].includes(request.execution.stage)
  )
    throw new BootstrapRequestConflict("Startup recovery remains necessary for this request");
  await input.requireTerminal();
  try {
    await readBootstrapPreparedFile(
      { ...recovery.launcher, path: recovery.installedLauncher },
      input.writableMountRoots,
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  await input.requireTerminal();
  await unlink(recovery.installedLauncher);
  await syncDirectory(path.dirname(recovery.installedLauncher));
}
