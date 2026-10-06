import { isDeepStrictEqual } from "node:util";
import { readFileSync } from "node:fs";
import { z } from "zod";
import {
  MutableDaemonConfigSchema,
  type MutableDaemonConfig,
  type MutableDaemonConfigPatch,
  type SharedProviderPreferences,
} from "@getpaseo/protocol/messages";
import {
  InstallationSettingsSchema,
  InstallationSettingsFieldSchema,
} from "@getpaseo/protocol/installation-settings";
import { projectInstallationSettings, readInstallationSettings } from "./projection.js";

export const InstallationSettingsAdmissionSchema = z.object({
  installationId: z.string().uuid(),
  serverId: z.string().min(1),
  environment: z.enum(["host", "container"]),
  revision: z.number().int().positive(),
  settings: InstallationSettingsSchema,
  installationInstructions: z.string(),
});
export type InstallationSettingsAdmission = z.infer<typeof InstallationSettingsAdmissionSchema>;
type InstallationBinding = NonNullable<SharedProviderPreferences["installation"]>;
export interface InstallationSettingsReader {
  read(binding: InstallationBinding): Promise<InstallationSettingsAdmission>;
}

export class InstallationSettingsAdmissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstallationSettingsAdmissionError";
  }
}

function candidatePolicy(current: MutableDaemonConfig, patch: MutableDaemonConfigPatch) {
  return readInstallationSettings(
    MutableDaemonConfigSchema.parse({
      ...current,
      ...patch,
      // Account bindings are environment-owned. Compare policy in the current binding context.
      providers: current.providers,
      mcp: { ...current.mcp, ...patch.mcp },
      metadataGeneration: { ...current.metadataGeneration, ...patch.metadataGeneration },
    }),
  );
}

export function changesInstallationSettings(
  current: MutableDaemonConfig,
  patch: MutableDaemonConfigPatch,
): boolean {
  return !isDeepStrictEqual(readInstallationSettings(current), candidatePolicy(current, patch));
}

interface InstallationSettingsProjectionCheck {
  current: MutableDaemonConfig;
  patch: MutableDaemonConfigPatch;
  admission?: InstallationSettingsAdmission;
}

export function assertInstallationSettingsProjection({
  current,
  patch,
  admission,
}: InstallationSettingsProjectionCheck): void {
  const binding = current.sharedProviderPreferences?.installation;
  if (!binding || !changesInstallationSettings(current, patch)) return;
  if (!admission)
    throw new InstallationSettingsAdmissionError(
      "Shared settings must be edited through the installation coordinator.",
    );
  if (
    admission.installationId !== binding.installationId ||
    admission.serverId !== binding.serverId ||
    admission.environment !== binding.environment
  )
    throw new InstallationSettingsAdmissionError(
      "Settings authority returned a different installation or environment.",
    );
  const expected = candidatePolicy(
    current,
    projectInstallationSettings(
      admission.settings,
      binding.serverId,
      current,
      admission.installationInstructions,
    ),
  );
  const previous = readInstallationSettings(current);
  const candidate = candidatePolicy(current, patch);
  for (const key of InstallationSettingsFieldSchema.options) {
    if (
      !isDeepStrictEqual(previous[key], candidate[key]) &&
      !isDeepStrictEqual(expected[key], candidate[key])
    )
      throw new InstallationSettingsAdmissionError(
        "Shared settings must be edited through the installation coordinator. Reload its current values before retrying.",
      );
  }
}

const ClientConfigSchema = z.object({
  origin: z.url(),
  token: z.string().min(1),
  kind: z.enum(["host-agent", "container-agent"]),
});

export function createInstallationSettingsReader(
  configFile: string | undefined,
): InstallationSettingsReader {
  const config = configFile
    ? ClientConfigSchema.parse(JSON.parse(readFileSync(configFile, "utf8")))
    : null;
  if (config) {
    const origin = new URL(config.origin);
    const loopback = origin.hostname === "localhost" || origin.hostname === "127.0.0.1";
    if (
      origin.origin !== config.origin ||
      (origin.protocol !== "https:" && !(origin.protocol === "http:" && loopback))
    )
      throw new InstallationSettingsAdmissionError(
        "Installation admission requires a fixed HTTPS or loopback origin.",
      );
  }
  return {
    async read(binding) {
      if (!config)
        throw new InstallationSettingsAdmissionError(
          "The daemon launcher must configure VORTEO_INSTALLATION_CLIENT_CONFIG before projecting shared settings.",
        );
      const environment = config.kind === "host-agent" ? "host" : "container";
      if (binding.environment !== environment)
        throw new InstallationSettingsAdmissionError(
          "Installation settings environment does not match the daemon launcher.",
        );
      const response = await fetch(new URL("/api/installation/settings/admission", config.origin), {
        headers: { Authorization: `Bearer ${config.token}` },
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok)
        throw new InstallationSettingsAdmissionError(
          `Installation settings authority is unavailable (${response.status}).`,
        );
      return InstallationSettingsAdmissionSchema.parse(await response.json());
    },
  };
}

let launchSettingsReader: InstallationSettingsReader | undefined;
export async function readInstallationSettingsForLaunch(
  settings: MutableDaemonConfig,
  reader?: InstallationSettingsReader,
): Promise<InstallationSettingsAdmission | null> {
  const binding = settings.sharedProviderPreferences?.installation;
  if (!binding) {
    if (process.env.VORTEO_INSTALLATION_CLIENT_CONFIG)
      throw new InstallationSettingsAdmissionError(
        "Installation settings migration is incomplete.",
      );
    return null;
  }
  if (!reader) {
    launchSettingsReader ??= createInstallationSettingsReader(
      process.env.VORTEO_INSTALLATION_CLIENT_CONFIG,
    );
    reader = launchSettingsReader;
  }
  const admission = await reader.read(binding);
  if (
    admission.installationId !== binding.installationId ||
    admission.serverId !== binding.serverId ||
    admission.environment !== binding.environment
  )
    throw new InstallationSettingsAdmissionError(
      "Settings authority returned a different installation or environment.",
    );
  if (!admission.settings.skillLibrary)
    throw new InstallationSettingsAdmissionError(
      "Complete shared personal skill migration before starting new tasks.",
    );
  return admission;
}
