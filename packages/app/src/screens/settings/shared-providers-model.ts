import type { InstallationProvider } from "@getpaseo/protocol/installation-provider";
import { AGENT_PROVIDER_DEFINITIONS } from "@getpaseo/protocol/provider-manifest";

/** One environment's provider snapshot, as each daemon reports it. */
export interface ProviderDetectionSource {
  serverId: string;
  kind: "host" | "container";
  /** Undefined while the snapshot is still loading. */
  entries: readonly { provider: string; status: string }[] | undefined;
}

export interface ProviderAccount {
  id: string;
  name: string;
  enabled: boolean;
  definitions: InstallationProvider[];
}
export interface ProviderFamily {
  id: string;
  name: string;
  enabled: boolean;
  /** Its CLI was found in at least one environment. Null while snapshots are still loading. */
  installed: boolean | null;
  accounts: ProviderAccount[];
}

type Detection = "ready" | "installed" | "missing" | "unknown";

/** "error" means the CLI ran and failed (for example it needs sign-in), so it is installed. */
function detectIn(definition: InstallationProvider, source: ProviderDetectionSource): Detection {
  const localId = definition.bindings[source.serverId];
  if (!localId) return "missing";
  if (!source.entries) return "unknown";
  const status = source.entries.find((entry) => entry.provider === localId)?.status;
  if (status === "ready") return "ready";
  if (status === "error") return "installed";
  if (status === "loading") return "unknown";
  return "missing";
}

function installedAnywhere(
  definition: InstallationProvider,
  sources: readonly ProviderDetectionSource[],
): boolean | null {
  const states = sources.map((source) => detectIn(definition, source));
  if (states.some((state) => state === "ready" || state === "installed")) return true;
  return states.includes("unknown") || sources.length === 0 ? null : false;
}

/**
 * Whether a shared provider is on. An explicit owner choice always wins. Without one, a
 * provider is on only while the Host reports it ready: its CLI is on the Host service PATH
 * and it is configured and signed in. Detection is never written back as a choice.
 */
export function providerEnabled(
  definition: InstallationProvider,
  sources: readonly ProviderDetectionSource[],
): boolean {
  if (definition.policy.enabled !== undefined) return definition.policy.enabled;
  // Installations always have a Host; the fallback keeps a Dev-only view usable.
  const host = sources.find((source) => source.kind === "host") ?? sources[0];
  return host ? detectIn(definition, host) === "ready" : false;
}

export function groupInstallationProviders(
  definitions: readonly InstallationProvider[],
  visibility: "active" | "removed" = "active",
  sources: readonly ProviderDetectionSource[] = [],
): ProviderFamily[] {
  const families = new Map<string, ProviderFamily>();
  for (const definition of definitions) {
    if ((definition.removed === true) !== (visibility === "removed")) continue;
    const type = definition.providerType;
    const manifest = AGENT_PROVIDER_DEFINITIONS.find((entry) => entry.id === type);
    let family = families.get(type);
    if (!family) {
      family = {
        id: type,
        name: manifest?.label ?? type,
        enabled: false,
        installed: false,
        accounts: [],
      };
      families.set(type, family);
    }
    const enabled = providerEnabled(definition, sources);
    family.enabled ||= enabled;
    const installed = installedAnywhere(definition, sources);
    if (installed === true || family.installed === true) family.installed = true;
    else if (installed === null) family.installed = null;
    const isDefault =
      !definition.accountId && Object.values(definition.bindings).every((id) => id === type);
    const id = isDefault ? `default/${type}` : definition.id;
    const account = family.accounts.find((entry) => entry.id === id);
    if (account) {
      account.definitions.push(definition);
      account.enabled ||= enabled;
    } else
      family.accounts.push({
        id,
        name: definition.policy.label ?? "Default connection",
        enabled,
        definitions: [definition],
      });
  }
  return [...families.values()];
}

/**
 * Snapshot entries that belong in Needs attention. A failing provider counts only when it
 * is on: a provider the owner never enabled and the Host cannot use is off, not broken.
 * Without a shared catalog (a standalone daemon) every enabled failing entry counts.
 */
export function providersNeedingAttention<
  T extends { provider: string; status: string; enabled?: boolean },
>(input: {
  entries: readonly T[];
  serverId: string;
  definitions: readonly InstallationProvider[] | undefined;
  sources: readonly ProviderDetectionSource[];
}): T[] {
  return input.entries.filter((entry) => {
    if (entry.enabled === false || entry.status !== "error") return false;
    if (!input.definitions) return true;
    const definition = input.definitions.find(
      (candidate) => !candidate.removed && candidate.bindings[input.serverId] === entry.provider,
    );
    return definition ? providerEnabled(definition, input.sources) : true;
  });
}

// Commands come from the repository's own docs and images; providers without a documented
// command name their CLI instead.
const INSTALL_HINTS: Record<string, string> = {
  claude: "Install on the Host with npm install -g @anthropic-ai/claude-code, then sign in.",
  codex: "Install on the Host with npm install -g @openai/codex, then sign in.",
  opencode: "Install on the Host with npm install -g opencode-ai, then sign in.",
  pi: "Install on the Host with npm install -g @earendil-works/pi-coding-agent, then sign in.",
  copilot: "Install the GitHub Copilot CLI (copilot) on the Host, then sign in.",
  omp: "Install the Oh My Pi CLI (omp) on the Host, then sign in.",
  antigravity: "Install the Antigravity CLI (agy) on the Host, then run agy once to sign in.",
  muse: "Install on the Host with curl -fsSL https://dev.meta.ai/install.sh | sh, then sign in.",
};

export function providerInstallHint(providerType: string): string {
  return INSTALL_HINTS[providerType] ?? "Install its CLI on the Host, then sign in.";
}
