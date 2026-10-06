import { readFileSync } from "node:fs";
import { z } from "zod";
import {
  ExecutionInstallationSchema,
  validateExecutionInstallation,
} from "@getpaseo/protocol/execution-installation";

const DaemonConnectionSchema = z.strictObject({
  endpoint: z.string().min(1),
  password: z.string().min(1),
});

export const InstallationConfigSchema = z.strictObject({
  public: ExecutionInstallationSchema,
  redirectOrigins: z
    .array(
      z.url().refine((value) => {
        const url = new URL(value);
        return url.protocol === "https:" && url.origin === value;
      }, "Redirect origins must be exact HTTPS origins"),
    )
    .optional(),
  listenPort: z.number().int().min(1024).max(65535),
  webDistDir: z.string().min(1),
  stateDir: z.string().min(1),
  ownerPasswordFile: z.string().min(1).optional(),
  ownerPasswordHash: z.string().startsWith("$2"),
  hostAgentTokenHash: z.string().regex(/^[a-f0-9]{64}$/),
  containerAgentTokenHash: z.string().regex(/^[a-f0-9]{64}$/),
  host: DaemonConnectionSchema.extend({
    launchdService: z.string().regex(/^gui\/\d+\/local\.vorteo\.[a-zA-Z0-9.-]+$/),
    startupValidation: z
      .strictObject({
        node: z.string().startsWith("/"),
        entrypoint: z.string().startsWith("/"),
        home: z.string().startsWith("/"),
      })
      .optional(),
  }),
  container: DaemonConnectionSchema,
});
export type InstallationConfig = z.infer<typeof InstallationConfigSchema>;

export function readInstallationConfig(file: string): InstallationConfig {
  const config = InstallationConfigSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  validateExecutionInstallation(config.public);
  for (const target of [config.host, config.container]) {
    if (!/^127\.0\.0\.1:\d+$/.test(target.endpoint)) {
      throw new Error("Installation management connects only to explicit host loopback endpoints");
    }
  }
  if (config.host.password === config.container.password) {
    throw new Error("Host and container daemon credentials must be distinct");
  }
  return config;
}
