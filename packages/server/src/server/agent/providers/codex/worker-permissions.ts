import { delimiter, isAbsolute, normalize } from "node:path";
import { join } from "node:path";
import { lstat, realpath } from "node:fs/promises";
import { z } from "zod";

const Unset = z.null().optional();

/** Only the controller-owned toolchain and system tools enter a confined shell. */
export function workerShellEnvironment(cwd: string | undefined): { PATH: string } {
  if (!cwd || !isAbsolute(cwd) || normalize(cwd) !== cwd || cwd.includes(delimiter)) {
    throw new Error("Native worker shell requires a canonical workspace without PATH separators.");
  }
  return { PATH: [join(cwd, ".git/factory-tools/bin"), "/usr/bin", "/bin"].join(delimiter) };
}

const ProxyFeature = z
  .object({ enabled: z.literal(true), credential_broker: z.literal(false) })
  .strict();
const DenyAllProxyNetwork = z
  .object({
    enabled: z.literal(true),
    proxy_url: z.literal("http://127.0.0.1:0"),
    enable_socks5: z.literal(false),
    socks_url: Unset,
    enable_socks5_udp: z.literal(false),
    allow_upstream_proxy: z.literal(false),
    dangerously_allow_non_loopback_proxy: z.literal(false),
    dangerously_allow_all_unix_sockets: z.literal(false),
    mode: z.literal("limited"),
    domains: z.object({}).strict(),
    unix_sockets: z.object({}).strict(),
    allow_local_binding: z.literal(false),
    mitm: Unset,
  })
  .strict();
// Exactly two audited workspace shapes. Writable workers own the workspace. Read-only workers
// (Factory issue qualification) may write only their private scratch directory .factory-tmp.
const WritableWorkspaceRoots = z
  .object({
    ".": z.literal("write"),
    ".codex": z.literal("deny"),
    ".git": z.literal("read"),
  })
  .strict();
const ReadOnlyWorkspaceRoots = z
  .object({
    ".": z.literal("read"),
    ".factory-tmp": z.literal("write"),
    ".codex": z.literal("deny"),
    ".git": z.literal("read"),
  })
  .strict();
export type WorkerWorkspaceMode = "write" | "read-only";

const WorkerProfile = z
  .object({
    description: z.string().nullable().optional(),
    extends: Unset,
    workspace_roots: z.record(z.string(), z.literal(true)),
    filesystem: z
      .object({
        glob_scan_max_depth: Unset,
        ":root": z.literal("deny"),
        ":minimal": z.literal("read"),
        ":tmpdir": z.literal("deny"),
        ":slash_tmp": z.literal("deny"),
        ":workspace_roots": z.union([WritableWorkspaceRoots, ReadOnlyWorkspaceRoots]),
      })
      .strict(),
    network: z.union([
      z
        .object({
          enabled: z.literal(false),
          proxy_url: Unset,
          enable_socks5: Unset,
          socks_url: Unset,
          enable_socks5_udp: Unset,
          allow_upstream_proxy: Unset,
          dangerously_allow_non_loopback_proxy: Unset,
          dangerously_allow_all_unix_sockets: Unset,
          mode: Unset,
          domains: Unset,
          unix_sockets: Unset,
          allow_local_binding: Unset,
          mitm: Unset,
        })
        .strict(),
      DenyAllProxyNetwork,
    ]),
  })
  .strict();

// A profile name is provenance, not proof of its effective grants. Accept only
// the audited offline worker boundary; inherited profiles can widen it silently.
// Returns the verified workspace mode so the physical check can require its directories.
export function verifyWorkerPermissionProfile(
  profile: unknown,
  cwd: string | undefined,
  networkProxyFeature?: unknown,
): WorkerWorkspaceMode {
  const result = WorkerProfile.safeParse(profile);
  if (!result.success || !cwd || !isAbsolute(cwd) || normalize(cwd) !== cwd) {
    throw new Error("Native worker filesystem confinement is unavailable.");
  }
  const roots = Object.keys(result.data.workspace_roots);
  if (roots.length !== 1 || roots[0] !== cwd) {
    throw new Error("Native worker filesystem confinement is unavailable.");
  }
  // Native Restricted seccomp denies shutdown(), breaking Node's stdin pipes.
  // Managed proxy mode uses a separate tool network namespace and an empty
  // allowlist, retaining process-local IPC without granting an egress path.
  if (result.data.network.enabled && !ProxyFeature.safeParse(networkProxyFeature).success) {
    throw new Error("Native worker deny-all managed proxy is unverified.");
  }
  return result.data.filesystem[":workspace_roots"]["."] === "write" ? "write" : "read-only";
}

export function verifyWorkerRuntimeRoots(roots: unknown, cwd: string | undefined): void {
  if (!cwd || !Array.isArray(roots) || roots.length !== 1 || roots[0] !== cwd) {
    throw new Error("Native worker runtime workspace roots are unverified.");
  }
}

export async function verifyWorkerPhysicalWorkspace(
  cwd: string | undefined,
  mode: WorkerWorkspaceMode = "write",
): Promise<void> {
  if (!cwd || !isAbsolute(cwd) || normalize(cwd) !== cwd) {
    throw new Error("Native worker requires a prepared physical workspace.");
  }
  // Missing deny targets can fail native mount setup. Preparation owns their
  // creation; verification never follows a link or repairs a worker's paths.
  // A read-only worker's only writable path must also be a real directory.
  const directories = [cwd, join(cwd, ".codex")];
  if (mode === "read-only") directories.push(join(cwd, ".factory-tmp"));
  for (const directory of directories) {
    const info = await lstat(directory);
    if (!info.isDirectory() || (await realpath(directory)) !== directory) {
      throw new Error("Native worker requires a prepared physical workspace.");
    }
  }
}
