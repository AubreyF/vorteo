import { NativeHelperConfigurationSchema } from "@getpaseo/protocol/native-helper-maintenance";
import path from "node:path";
import { readFileSync } from "node:fs";
import { z } from "zod";
import {
  ExecutionInstallationSchema,
  FactoryRuntimeAdoptionConfigurationSchema,
  validateExecutionInstallation,
} from "@getpaseo/protocol/execution-installation";

const DaemonConnectionSchema = z.strictObject({
  endpoint: z.string().min(1),
  password: z.string().min(1),
});

export const ContainerSourceUpdatesSchema = z.strictObject({
  sourceRepository: z.string().startsWith("/"),
  toolingDirectory: z.string().startsWith("/"),
  integrationRef: z.string().regex(/^refs\/heads\/[a-zA-Z0-9_./-]+$/),
  receiptFile: z.string().startsWith("/"),
  docker: z.string().startsWith("/"),
  containerId: z.string().regex(/^[a-f0-9]{64}$/),
  user: z.string().regex(/^[a-z_][a-z0-9_-]*$/),
  node: z.string().startsWith("/"),
  home: z.string().startsWith("/"),
  releaseRoot: z.string().startsWith("/"),
  currentReleaseLink: z.string().startsWith("/"),
});
export type ContainerSourceUpdates = z.infer<typeof ContainerSourceUpdatesSchema>;

export const InstallationConfigSchema = z.strictObject({
  public: ExecutionInstallationSchema,
  nativeHelper: NativeHelperConfigurationSchema.optional(),
  restartApprovalPolicy: z.strictObject({ hostRequestsAfter: z.string().datetime() }).optional(),
  containerSourceUpdates: ContainerSourceUpdatesSchema.optional(),
  sourceUpdates: z
    .strictObject({
      sourceRepository: z.string().startsWith("/"),
      releaseRoot: z.string().startsWith("/"),
      currentReleaseLink: z.string().startsWith("/"),
      webDirectory: z.string().startsWith("/"),
      toolingDirectory: z.string().startsWith("/"),
      integrationRef: z.string().regex(/^refs\/heads\/[a-zA-Z0-9_./-]+$/),
    })
    .optional(),
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
  container: DaemonConnectionSchema.extend({
    factoryRuntimeAdoption: FactoryRuntimeAdoptionConfigurationSchema.optional(),
    supervisorMaintenance: z
      .strictObject({
        node: z.string().startsWith("/"),
        script: z.string().startsWith("/"),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .optional(),
  }),
});
export type InstallationConfig = z.infer<typeof InstallationConfigSchema>;

export function readInstallationConfig(file: string): InstallationConfig {
  const config = InstallationConfigSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  validateExecutionInstallation(config.public);
  if (config.hostAgentTokenHash === config.containerAgentTokenHash)
    throw new Error("Host and Dev installation request credentials must be distinct");
  if (config.sourceUpdates) {
    const update = config.sourceUpdates;
    const entrypoint = path.join(
      update.currentReleaseLink,
      "packages/server/dist/scripts/supervisor-entrypoint.js",
    );
    if (
      config.host.startupValidation?.entrypoint !== entrypoint ||
      config.webDistDir !== update.webDirectory
    )
      throw new Error(
        "Source updates require the selected release launcher and managed web directory",
      );
  }
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
