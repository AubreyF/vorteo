import { readFileSync } from "node:fs";
import { z } from "zod";
import { InstallationProfilesAdmissionSchema } from "@getpaseo/protocol/execution-installation";
import type { MutableDaemonConfig, SharedProviderPreferences } from "@getpaseo/protocol/messages";

const ClientConfigSchema = z.object({
  origin: z.url(),
  token: z.string().min(1),
  kind: z.enum(["host-agent", "container-agent"]),
});
type InstallationBinding = NonNullable<SharedProviderPreferences["installation"]>;

export interface InstallationProfileReader {
  read(binding: InstallationBinding): Promise<SharedProviderPreferences>;
}

export class InstallationProfileAdmissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstallationProfileAdmissionError";
  }
}

export function createInstallationProfileReader(
  configFile: string | undefined,
): InstallationProfileReader {
  // This path is supplied by the daemon launcher, never by an RPC or profile definition.
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
      throw new InstallationProfileAdmissionError(
        "Installation admission requires a fixed HTTPS or loopback origin.",
      );
  }
  return {
    async read(binding) {
      if (!config)
        throw new InstallationProfileAdmissionError(
          "The daemon launcher must configure VORTEO_INSTALLATION_CLIENT_CONFIG before launching installation profiles.",
        );
      const environment = config.kind === "host-agent" ? "host" : "container";
      if (binding.environment !== environment)
        throw new InstallationProfileAdmissionError(
          "Installation profile environment does not match the daemon launcher.",
        );
      const response = await fetch(new URL("/api/installation/profiles/admission", config.origin), {
        headers: { Authorization: `Bearer ${config.token}` },
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok)
        throw new InstallationProfileAdmissionError(
          `Installation profile admission is unavailable (${response.status}).`,
        );
      const admission = InstallationProfilesAdmissionSchema.parse(await response.json());
      if (
        admission.installationId !== binding.installationId ||
        admission.serverId !== binding.serverId ||
        admission.environment !== binding.environment
      )
        throw new InstallationProfileAdmissionError(
          "Installation profile admission returned a different installation or environment.",
        );
      if (admission.preferences.revision < binding.revision)
        throw new InstallationProfileAdmissionError(
          "Installation profile admission returned a stale revision.",
        );
      return {
        ...admission.preferences,
        installation: { ...binding, revision: admission.preferences.revision },
      };
    },
  };
}

let defaultReader: InstallationProfileReader | undefined;

export async function readInstallationProfileConfig(
  settings: MutableDaemonConfig,
  reader?: InstallationProfileReader,
): Promise<MutableDaemonConfig> {
  const binding = settings.sharedProviderPreferences?.installation;
  if (!binding) {
    if (process.env.VORTEO_INSTALLATION_CLIENT_CONFIG)
      throw new InstallationProfileAdmissionError("Installation profile migration is incomplete.");
    return settings;
  }
  if (!reader) {
    defaultReader ??= createInstallationProfileReader(
      process.env.VORTEO_INSTALLATION_CLIENT_CONFIG,
    );
    reader = defaultReader;
  }
  const preferences = await reader.read(binding);
  return { ...settings, sharedProviderPreferences: preferences };
}
