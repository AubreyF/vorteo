import type { ProviderRemovalPlan } from "@getpaseo/protocol/provider-removal";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import type { MutableDaemonConfig } from "@getpaseo/protocol/messages";
import { ProviderOverrideSchema } from "@getpaseo/protocol/provider-config";
import { BUILTIN_PROVIDER_IDS } from "@getpaseo/protocol/provider-manifest";

export class ProviderRemovalError extends Error {}

interface RemovalInput {
  paseoHome: string;
  providers: MutableDaemonConfig["providers"];
  providerId: string;
  defaultCodexHome: string;
  defaultClaudeHome: string;
}

export function defaultProviderAccountHomes() {
  return {
    defaultCodexHome: process.env.CODEX_HOME ?? path.join(homedir(), ".codex"),
    defaultClaudeHome: process.env.CLAUDE_CONFIG_DIR ?? path.join(homedir(), ".claude"),
  };
}

/** Legacy config removal must not orphan managed files, including batched removals. */
export function assertProviderConfigRemoval(
  input: Omit<RemovalInput, "providerId"> & { removeProviders: string[] },
): void {
  for (const providerId of input.removeProviders) {
    const provider = input.providers[providerId];
    if (!provider) continue;
    const parsed = ProviderOverrideSchema.parse(provider);
    if (parsed.extends !== "codex" && parsed.extends !== "claude") continue;
    const removal = {
      ...input,
      providerId,
      providers: Object.fromEntries(
        Object.entries(input.providers).filter(
          ([id]) => id === providerId || !input.removeProviders.includes(id),
        ),
      ),
    };
    const plan = planProviderRemoval(removal);
    const home = accountHome(removal);
    if (plan.credentials === "managed" && home && existsSync(home)) {
      throw new ProviderRemovalError(
        "Use connection deletion to remove this account and its saved credentials.",
      );
    }
  }
}

// Resolve existing ancestors too: an absent child under a symlink still belongs
// to the symlink target, not to the apparent managed directory.
function canonicalPath(location: string): string {
  const absolute = path.resolve(location);
  if (existsSync(absolute)) return realpathSync(absolute);
  const parent = path.dirname(absolute);
  if (parent === absolute) return absolute;
  return path.join(canonicalPath(parent), path.basename(absolute));
}

function overlaps(left: string, right: string): boolean {
  return left === right || left.startsWith(right + path.sep) || right.startsWith(left + path.sep);
}

function accountHome(input: RemovalInput): string | null {
  const configured = input.providers[input.providerId];
  if (!configured)
    throw new ProviderRemovalError("This provider was already removed. Refresh the provider list.");
  const provider = ProviderOverrideSchema.parse(configured);
  if (BUILTIN_PROVIDER_IDS.includes(input.providerId))
    throw new ProviderRemovalError("Built-in providers can be disabled, but cannot be deleted.");
  if (provider.extends === "claude")
    return provider.env?.CLAUDE_CONFIG_DIR ?? input.defaultClaudeHome;
  if (provider.extends !== "codex") return null;
  return provider.env?.CODEX_HOME ?? input.defaultCodexHome;
}

export function planProviderRemoval(input: RemovalInput): ProviderRemovalPlan {
  const home = accountHome(input);
  const provider = ProviderOverrideSchema.parse(input.providers[input.providerId]);
  const baseProvider = provider.extends === "claude" ? "claude" : "codex";
  const homeVariable = baseProvider === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME";
  const defaultHome = baseProvider === "claude" ? input.defaultClaudeHome : input.defaultCodexHome;
  const name = provider.label ?? input.providerId;
  const sharedWith: string[] = [];
  const sharedProviderIds: string[] = [];
  let credentials: ProviderRemovalPlan["credentials"] = "external";
  let canonicalHome: string | null = null;
  if (home) {
    canonicalHome = canonicalPath(home);
    const root = path.join(canonicalPath(input.paseoHome), `${baseProvider}-accounts`);
    const inManagedRoot = path.dirname(canonicalHome) === root;
    const isAccountDirectory = new RegExp(
      `^${baseProvider}-account-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`,
    ).test(path.basename(canonicalHome));
    if (inManagedRoot && isAccountDirectory) credentials = "managed";
    for (const [id, configured] of Object.entries(input.providers)) {
      if (id === input.providerId) continue;
      const candidate = ProviderOverrideSchema.parse(configured);
      const candidateHome = candidate.env?.[homeVariable];
      const usesDefault = id === baseProvider || candidate.extends === baseProvider;
      const otherHome = candidateHome ?? (usesDefault ? defaultHome : null);
      if (otherHome && overlaps(canonicalHome, canonicalPath(otherHome))) {
        sharedWith.push(candidate.label ?? id);
        sharedProviderIds.push(id);
      }
    }
    // Built-ins may be absent from the override map while still using the host's CLI home.
    if (!input.providers[baseProvider] && overlaps(canonicalHome, canonicalPath(defaultHome))) {
      sharedWith.push({ claude: "Claude", codex: "Codex" }[baseProvider]);
      sharedProviderIds.push(baseProvider);
    }
    if (sharedWith.length > 0) credentials = "shared";
  }
  // A policy projection can disable the connection after confirmation. Runtime
  // credentials and ownership must still match the reviewed deletion target.
  const revision = createHash("sha256")
    .update(
      JSON.stringify({
        providerId: input.providerId,
        providerType: provider.extends,
        accountId: provider.installationAccountId,
        runtime: {
          command: provider.command,
          env: provider.env,
          options: provider.options,
          params: provider.params,
          removed: provider.removed,
        },
        name,
        canonicalHome,
        credentials,
        sharedWith,
        sharedProviderIds,
      }),
    )
    .digest("hex");
  return {
    providerId: input.providerId,
    name,
    credentials,
    sharedWith,
    revision,
  };
}

/** Call only after provider processes and sign-in have stopped, then remove config.
 * A cleanup failure leaves the connection present so the user can retry. */
export function deleteManagedProviderCredentials(
  input: RemovalInput,
  expectedRevision: string,
): ProviderRemovalPlan {
  const plan = planProviderRemoval(input);
  if (plan.revision !== expectedRevision)
    throw new ProviderRemovalError("Provider settings changed. Review deletion again.");
  if (plan.credentials !== "managed") return plan;
  const home = accountHome(input);
  if (!home) throw new ProviderRemovalError("The account directory is unavailable.");
  // Refuse a final-component symlink even when it points back inside the managed root.
  // Otherwise unlinking it would leave the actual credential directory behind.
  if (existsSync(home) && lstatSync(home).isSymbolicLink())
    throw new ProviderRemovalError(
      "The account directory is a symbolic link. Remove its credentials manually.",
    );
  rmSync(home, { recursive: true, force: true });
  return plan;
}
