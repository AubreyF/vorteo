import { constants, closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

const PairedClientSchema = z.object({
  kind: z.literal("container-agent"),
  origin: z.url(),
  token: z.string().min(1),
});

interface ManagedClientInput {
  configuredPath?: string;
  managedWorker: boolean;
  environment?: "host" | "container";
  platform: NodeJS.Platform;
  homeDir: string;
  uid: number | undefined;
}

/** Older managed supervisors did not inherit the client installed by pairing. */
export function resolveManagedInstallationClient(input: ManagedClientInput): string | undefined {
  if (input.configuredPath) return input.configuredPath;
  const pairedDev =
    input.managedWorker && input.platform === "linux" && input.environment === "container";
  if (!pairedDev) return undefined;
  const file = path.join(input.homeDir, ".local/share/vorteo-installation-client/client.json");
  let descriptor: number | undefined;
  try {
    descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.uid !== input.uid || (stat.mode & 0o077) !== 0 || stat.size > 65536)
      throw new Error("Invalid paired client file");
    const config = PairedClientSchema.parse(JSON.parse(readFileSync(descriptor, "utf8")));
    const origin = new URL(config.origin);
    const loopback = origin.hostname === "localhost" || origin.hostname === "127.0.0.1";
    const secureTransport =
      origin.protocol === "https:" || (origin.protocol === "http:" && loopback);
    if (origin.origin !== config.origin || !secureTransport)
      throw new Error("Invalid paired client origin");
    return file;
  } catch {
    throw new Error(
      "The paired Dev installation client is missing or invalid. Repair its managed installation client before starting the daemon.",
    );
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
