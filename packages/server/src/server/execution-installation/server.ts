import { OwnerSessions, OWNER_SESSION_MAX_AGE } from "./owner-sessions.js";
import { createInstallationProfiles } from "./profiles/runtime.js";
import { ProfileSharingConflict } from "./profiles/merge.js";
import type { InstallationProfiles } from "./profiles/service.js";
import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, mkdirSync, openSync, fsyncSync, closeSync } from "node:fs";
import path from "node:path";
import express, { type Request, type Response, type NextFunction } from "express";
import type { Logger } from "pino";
import { z } from "zod";
import {
  RestartJobSchema,
  RestartRequestSchema,
  RestartDecisionSchema,
} from "@getpaseo/protocol/execution-installation";
import { extractHttpBearerToken, isBearerTokenValidAsync } from "../auth.js";
import { writePrivateFileAtomicSync } from "../private-files.js";
import { createWebUiMiddleware } from "../web-ui.js";
import { InstallationRestarts, RestartRequestError, type RestartExecutor } from "./restarts.js";
import type { InstallationConfig } from "./config.js";
import { connectInstallationDaemon } from "./daemon.js";
import { delegateToContainer, DelegationRequestSchema } from "./delegation.js";

function matchesToken(token: string | null, hash: string): boolean {
  if (!token) return false;
  const actual = createHash("sha256").update(token).digest();
  return timingSafeEqual(actual, Buffer.from(hash, "hex"));
}

export function createInstallationServer(
  config: InstallationConfig,
  executor: RestartExecutor,
  logger: Logger,
  profiles: InstallationProfiles = createInstallationProfiles(config),
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
  app.use(express.json({ limit: "16kb" }));
  app.get("/api/installation/health", (_req, res) =>
    res.json({ installationId: config.public.installationId }),
  );

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
  app.post("/api/installation/owner/restarts/query", (_req, res) => res.json(restarts.list()));
  app.post("/api/installation/owner/restarts", (req, res) =>
    res.status(201).json(restarts.request(RestartRequestSchema.parse(req.body), "owner")),
  );
  app.post("/api/installation/owner/restarts/:id/decision", (req, res) => {
    const decision = RestartDecisionSchema.parse(req.body);
    const job = restarts.decide(req.params.id, decision.revision, decision.decision);
    res.json(job);
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
      installation: { ...config.public, profileSharing: true },
    }),
  );
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Invalid request" });
      return;
    }
    if (error instanceof ProfileSharingConflict || error instanceof RestartRequestError) {
      res.status(409).json({ error: error.message });
      return;
    }
    logger.error({ err: error }, "Installation request failed");
    res.status(500).json({ error: "Installation request failed" });
  });
  return app;
}
