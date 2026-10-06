import {
  SkillSourceSchema,
  InstallationSkillSchema,
  SkillPackageSchema,
} from "@getpaseo/protocol/skill-library";
import { InstallationSkillPackages } from "./settings/skill-packages.js";
import {
  PluginSourceResolutionInputSchema,
  ResolvedPluginSourceSchema,
} from "@getpaseo/protocol/plugin-installation";
import { OwnerSessions, OWNER_SESSION_MAX_AGE } from "./owner-sessions.js";
import { createInstallationProfiles } from "./profiles/runtime.js";
import { ProfileSharingConflict } from "./profiles/merge.js";
import { ProviderPreferencesValidationError } from "../agent/provider-preferences/validation.js";
import type { InstallationProfiles } from "./profiles/service.js";
import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, mkdirSync, openSync, fsyncSync, closeSync } from "node:fs";
import path from "node:path";
import express, { type Request, type Response, type NextFunction } from "express";
import type { Logger } from "pino";
import { z } from "zod";
import {
  RestartJobSchema,
  type RestartJob,
  RestartRequestSchema,
  RestartDecisionSchema,
  InstallationProfilesPatchSchema,
} from "@getpaseo/protocol/execution-installation";
import { extractHttpBearerToken, isBearerTokenValidAsync } from "../auth.js";
import { writePrivateFileAtomicSync } from "../private-files.js";
import { createWebUiMiddleware } from "../web-ui.js";
import { InstallationRestarts, RestartRequestError, type RestartExecutor } from "./restarts.js";
import type { InstallationConfig } from "./config.js";
import { connectInstallationDaemon } from "./daemon.js";
import { delegateToContainer, DelegationRequestSchema } from "./delegation.js";
import { InstallationSettingsUpdateSchema } from "@getpaseo/protocol/installation-settings";
import { AgentSkillSelectionSchema } from "@getpaseo/protocol/messages";
import {
  createInstallationSettings,
  installationHostInstructions,
  resolveInstallationPluginSource,
  type InstallationPluginSourceResolver,
} from "./settings/runtime.js";
import {
  InstallationSettingsConflict,
  InstallationSettingsInvalidUpdate,
  InstallationSettingsNotInitialized,
  type InstallationSettingsService,
} from "./settings/service.js";

function matchesToken(token: string | null, hash: string): boolean {
  if (!token) return false;
  const actual = createHash("sha256").update(token).digest();
  return timingSafeEqual(actual, Buffer.from(hash, "hex"));
}

// COMPAT(idleRestart): added in v0.11.0-beta.3.vorteo.131; keep old open tabs' strict restart decoders working until they reload.
function restartReply(job: RestartJob, details: boolean) {
  if (details) return job;
  const {
    whenIdle: _whenIdle,
    approvedAt: _approvedAt,
    impact: _impact,
    requester: _requester,
    ...legacy
  } = job;
  return { ...legacy, expiresAt: "9999-12-31T23:59:59.999Z" };
}

export function createInstallationServer(
  config: InstallationConfig,
  executor: RestartExecutor,
  logger: Logger,
  profiles: InstallationProfiles = createInstallationProfiles(config),
  settings: InstallationSettingsService = createInstallationSettings(config),
  resolvePluginSource: InstallationPluginSourceResolver = (input) =>
    resolveInstallationPluginSource(config, input),
) {
  mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  const journal = path.join(config.stateDir, "restart-jobs.json");
  const restarts = new InstallationRestarts(
    {
      read: () =>
        existsSync(journal)
          ? z.array(RestartJobSchema).parse(JSON.parse(readFileSync(journal, "utf8")))
          : [],
      write: (jobs) => {
        writePrivateFileAtomicSync(journal, JSON.stringify(jobs));
        // Finish the receipt and directory rename before dispatching a disruption.
        for (const target of [journal, config.stateDir]) {
          const fd = openSync(target, "r");
          try {
            fsyncSync(fd);
          } finally {
            closeSync(fd);
          }
        }
      },
    },
    executor,
  );
  const drainRestarts = () =>
    restarts
      .drain()
      .catch((error) => logger.error({ err: error }, "Installation restart journal failed"));
  const sessions = new OwnerSessions(path.join(config.stateDir, "owner-sessions.json"));
  const secureCookies = new URL(config.public.origin).protocol === "https:";
  const cookieName = secureCookies ? "__Host-vorteo-owner" : "vorteo-owner";
  const cookieOptions = {
    httpOnly: true,
    secure: secureCookies,
    sameSite: "strict" as const,
    path: "/",
  };
  const sessionToken = (req: Request): string | undefined =>
    req.headers.cookie
      ?.split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${cookieName}=`))
      ?.slice(cookieName.length + 1);
  const configuredPasswordFile =
    config.ownerPasswordFile ?? path.resolve(config.stateDir, "../..", "owner-password");
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", "loopback");
  const canonicalHost = new URL(config.public.origin).host;
  const redirectHosts = new Set(
    (config.redirectOrigins ?? []).map((origin) => new URL(origin).host),
  );
  app.use((req, res, next) => {
    const host = req.headers.host ?? "";
    const legacyHost = host !== canonicalHost && redirectHosts.has(host);
    if (legacyHost) {
      res.setHeader("Cache-Control", "no-store");
      const navigation = req.method === "GET" || req.method === "HEAD";
      if (!navigation || req.path.startsWith("/api/")) {
        res.sendStatus(403);
        return;
      }
      res.redirect(302, `${config.public.origin}${req.originalUrl}`);
      return;
    }
    const allowedHosts = new Set([
      canonicalHost,
      `127.0.0.1:${config.listenPort}`,
      `localhost:${config.listenPort}`,
    ]);
    if (!allowedHosts.has(req.headers.host ?? "")) {
      res.sendStatus(403);
      return;
    }
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  app.use(express.json({ limit: "1mb" }));
  app.get("/api/installation/health", (_req, res) =>
    res.json({ installationId: config.public.installationId }),
  );

  // Only counts are public. Reasons and task identities require owner access.
  app.get("/api/installation/restart-summary", (_req, res) => {
    const jobs = restarts.list();
    res.json({
      requested: jobs.filter((job) => job.status === "pending").length,
      queued: jobs.filter((job) => job.status === "approved").length,
      running: jobs.filter((job) => job.status === "running").length,
    });
  });

  app.get("/api/installation/profiles/admission", (req, res) => {
    const token = extractHttpBearerToken(req.header("authorization"));
    let kind: "host" | "container";
    if (matchesToken(token, config.hostAgentTokenHash)) kind = "host";
    else if (matchesToken(token, config.containerAgentTokenHash)) kind = "container";
    else {
      res.sendStatus(401);
      return;
    }
    const environment = config.public.environments.find((item) => item.kind === kind);
    if (!environment || !profiles.snapshot()) {
      res.sendStatus(503);
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.json({
      installationId: config.public.installationId,
      environment: kind,
      serverId: environment.serverId,
      preferences: profiles.admission(environment.serverId),
    });
  });

  app.get("/api/installation/settings/admission", (req, res) => {
    const token = extractHttpBearerToken(req.header("authorization"));
    let kind: "host" | "container";
    if (matchesToken(token, config.hostAgentTokenHash)) kind = "host";
    else if (matchesToken(token, config.containerAgentTokenHash)) kind = "container";
    else {
      res.sendStatus(401);
      return;
    }
    const environment = config.public.environments.find((item) => item.kind === kind);
    const snapshot = settings.snapshot();
    if (!environment || !snapshot.settings) {
      res.sendStatus(503);
      return;
    }
    res.json({
      installationId: config.public.installationId,
      serverId: environment.serverId,
      environment: kind,
      revision: snapshot.revision,
      settings: snapshot.settings,
      installationInstructions: kind === "host" ? installationHostInstructions(config) : "",
    });
  });

  // Request-only credentials never authorize login, approval, delegation, or another daemon.
  app.post("/api/installation/restart-requests", (req, res) => {
    const token = extractHttpBearerToken(req.header("authorization"));
    let requestedBy: "host-agent" | "container-agent";
    if (matchesToken(token, config.hostAgentTokenHash)) requestedBy = "host-agent";
    else if (matchesToken(token, config.containerAgentTokenHash)) requestedBy = "container-agent";
    else {
      res.sendStatus(401);
      return;
    }
    const job = restarts.request(RestartRequestSchema.parse(req.body), requestedBy);
    res.status(201).json(job);
  });

  app.get("/api/installation/restart-requests/:id", (req, res) => {
    const token = extractHttpBearerToken(req.header("authorization"));
    const host = matchesToken(token, config.hostAgentTokenHash);
    const container = matchesToken(token, config.containerAgentTokenHash);
    if (!host && !container) {
      res.sendStatus(401);
      return;
    }
    const requestedBy = host ? "host-agent" : "container-agent";
    const job = restarts
      .list()
      .find((candidate) => candidate.id === req.params.id && candidate.requestedBy === requestedBy);
    if (!job) {
      res.sendStatus(404);
      return;
    }
    res.json(job);
  });

  app.post("/api/installation/container-agents", (req, res, next) => {
    void (async () => {
      const token = extractHttpBearerToken(req.header("authorization"));
      if (!matchesToken(token, config.hostAgentTokenHash)) {
        res.sendStatus(403);
        return;
      }
      try {
        const request = DelegationRequestSchema.parse(req.body);
        const client = await connectInstallationDaemon(config, "container");
        try {
          const result = await delegateToContainer(client, request);
          const environment = config.public.environments.find(
            (candidate) => candidate.kind === "container",
          );
          res.json({
            environment: "container",
            serverId: environment?.serverId,
            untrustedTaskData: result,
          });
        } finally {
          await client.close();
        }
      } catch (error) {
        next(error);
      }
    })();
  });

  // Public setup metadata contains a recovery path, never credentials or connection secrets.
  app.get("/api/installation/owner-access", (_req, res) =>
    res.json({
      sessions: true,
      passwordFile: existsSync(configuredPasswordFile) ? configuredPasswordFile : null,
    }),
  );
  app.post("/api/installation/owner/session", (req, res) => {
    if (req.header("origin") !== config.public.origin) {
      res.sendStatus(403);
      return;
    }
    const expiresAt = sessions.expiresAt(sessionToken(req));
    res.json({ authenticated: expiresAt !== null, expiresAt });
  });
  app.use("/api/installation/owner", (req, res, next) => {
    void (async () => {
      try {
        // Origin checking is independent of bearer authentication. Agent request keys
        // are deliberately not accepted, even on loopback.
        if (req.header("origin") !== config.public.origin) {
          res.sendStatus(403);
          return;
        }
        const token = extractHttpBearerToken(req.header("authorization"));
        if (
          !sessions.expiresAt(sessionToken(req)) &&
          !(await isBearerTokenValidAsync({ password: config.ownerPasswordHash, token }))
        ) {
          res.sendStatus(401);
          return;
        }
        next();
      } catch (error) {
        next(error);
      }
    })();
  });
  app.post("/api/installation/owner/lock", (req, res) => {
    sessions.revoke(sessionToken(req));
    res.clearCookie(cookieName, cookieOptions);
    res.json({ locked: true });
  });
  const sendConnections = (_req: Request, res: Response) => {
    const connections = config.public.environments.map((environment) => ({
      ...environment,
      password: config[environment.kind].password,
    }));
    res.json({ installationId: config.public.installationId, connections });
  };
  app.post("/api/installation/owner/connections", sendConnections);
  app.post("/api/installation/owner/unlock", (req, res) => {
    sessions.revoke(sessionToken(req));
    res.cookie(cookieName, sessions.create(), {
      ...cookieOptions,
      maxAge: OWNER_SESSION_MAX_AGE * 1000,
    });
    sendConnections(req, res);
  });
  app.post("/api/installation/owner/profiles/query", (_req, res) => res.json(profiles.status()));
  app.post("/api/installation/owner/settings/read", (_req, res) => {
    res.json(settings.snapshot());
  });
  app.post("/api/installation/owner/settings/plugins/resolve", (req, res, next) => {
    const input = PluginSourceResolutionInputSchema.parse(req.body);
    void resolvePluginSource(input)
      .then((resolved) => ResolvedPluginSourceSchema.parse(resolved))
      .then((resolved) => res.json(resolved), next);
  });
  app.post("/api/installation/owner/settings/skills/package", (req, res) => {
    const input = z.strictObject({ definition: InstallationSkillSchema }).parse(req.body);
    const packages = new InstallationSkillPackages(
      path.join(config.stateDir, "shared-settings/skill-packages"),
    );
    res.json({ package: packages.read(input.definition) });
  });
  app.post("/api/installation/owner/settings/skills/prepare", (req, res, next) => {
    const input = z.strictObject({ source: SkillSourceSchema }).parse(req.body);
    const packages = new InstallationSkillPackages(
      path.join(config.stateDir, "shared-settings/skill-packages"),
    );
    void packages
      .prepare(input.source)
      .then((prepared) =>
        z
          .strictObject({
            definition: InstallationSkillSchema,
            package: SkillPackageSchema,
          })
          .parse(prepared),
      )
      .then((prepared) => res.json(prepared), next);
  });
  app.post("/api/installation/owner/settings/skills/preview", (req, res, next) => {
    const input = z.strictObject({ selection: AgentSkillSelectionSchema }).parse(req.body);
    void settings.previewSkills(input.selection).then((sources) => res.json({ sources }), next);
  });
  app.patch("/api/installation/owner/settings", (req, res, next) => {
    const input = InstallationSettingsUpdateSchema.parse(req.body);
    void settings.update(input).then((snapshot) => res.json(snapshot), next);
  });
  const readProfiles = (_req: Request, res: Response) => {
    const snapshot = profiles.snapshot();
    if (!snapshot) {
      res.sendStatus(503);
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.json(snapshot);
  };
  app.get("/api/installation/owner/profiles", readProfiles);
  app.post("/api/installation/owner/profiles/read", readProfiles);
  app.patch("/api/installation/owner/profiles", (req, res, next) => {
    const input = InstallationProfilesPatchSchema.parse(req.body);
    if (!profiles.snapshot()) {
      res.sendStatus(503);
      return;
    }
    void profiles.patch(input).then((snapshot) => res.json(snapshot), next);
  });
  app.post("/api/installation/owner/profiles/synchronize", (_req, res, next) => {
    void profiles.synchronize().then(() => res.json(profiles.status()), next);
  });
  app.post("/api/installation/owner/profiles/resolve", (req, res, next) => {
    const input = z
      .strictObject({
        serverId: z.string().min(1),
        expectedRevision: z.number().int().positive(),
        choice: z.enum(["shared", "environment"]),
      })
      .parse(req.body);
    void profiles.resolve(input).then(() => res.json(profiles.status()), next);
  });
  app.post("/api/installation/owner/restarts/impact", (_req, res, next) => {
    void restarts.impacts().then((impacts) => res.json(impacts), next);
  });
  app.post("/api/installation/owner/restarts/query", (req, res) => {
    res.json(restarts.list().map((job) => restartReply(job, req.query.idleRestarts === "1")));
    void restarts
      .refreshImpacts()
      .catch((error) => logger.error({ err: error }, "Restart impact refresh failed"));
  });
  app.post("/api/installation/owner/restarts", (req, res) =>
    res
      .status(201)
      .json(
        restartReply(
          restarts.request(RestartRequestSchema.parse(req.body), "owner"),
          req.query.idleRestarts === "1",
        ),
      ),
  );
  app.post("/api/installation/owner/restarts/:id/decision", (req, res) => {
    const decision = RestartDecisionSchema.parse(req.body);
    const job = restarts.decide(req.params.id, decision.revision, decision.decision);
    res.json(restartReply(job, req.query.idleRestarts === "1"));
    void restarts
      .drain()
      .catch((error) => logger.error({ err: error }, "Installation restart journal failed"));
  });
  app.use(
    createWebUiMiddleware({
      enabled: true,
      distDir: config.webDistDir,
      label: "Vorteo",
      logger,
      installation: {
        ...config.public,
        profileSharing: true,
        idleRestarts: Boolean(executor.inspect && executor.restartWhenIdle),
      },
    }),
  );
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Invalid request" });
      return;
    }
    if (error instanceof ProviderPreferencesValidationError) {
      res.status(400).json({ error: error.message, reference: error.reference });
      return;
    }
    if (error instanceof InstallationSettingsInvalidUpdate) {
      res.status(400).json({ error: error.message });
      return;
    }
    if (
      error instanceof InstallationSettingsConflict ||
      error instanceof InstallationSettingsNotInitialized
    ) {
      res.status(409).json({ error: error.message });
      return;
    }
    if (error instanceof ProfileSharingConflict || error instanceof RestartRequestError) {
      res.status(409).json({ error: error.message });
      return;
    }
    logger.error({ err: error }, "Installation request failed");
    res.status(500).json({ error: "Installation request failed" });
  });
  return Object.assign(app, { drainRestarts });
}
