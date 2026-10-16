import type { MaintenanceRuntimeIdentity } from "./coordinator-bootstrap-maintenance-service-status.js";
import path from "node:path";
import type { InstallationEnrollmentManifest } from "@getpaseo/protocol/installation-enrollment";
import express, { type ErrorRequestHandler } from "express";
import { z } from "zod";
import {
  CoordinatorMaintenanceProvisionRequestSchema,
  CoordinatorMaintenanceEnrollmentRequestSchema,
  CoordinatorMaintenanceObserveRequestSchema,
  CoordinatorMaintenanceStatusSchema,
  CoordinatorBootstrapListRequestSchema,
  CoordinatorBootstrapDecideRequestSchema,
} from "@getpaseo/protocol/coordinator-bootstrap";
import { extractHttpBearerToken, isBearerTokenValidAsync } from "../auth.js";
import { OwnerSessions } from "./owner-sessions.js";
import {
  maintenanceRecoveryDocument,
  maintenanceRecoveryScript,
} from "./coordinator-bootstrap-maintenance-recovery-page.js";
import type { BootstrapReviewService } from "./coordinator-bootstrap-session.js";

const MessageSchema = z.discriminatedUnion("type", [
  CoordinatorBootstrapListRequestSchema,
  CoordinatorBootstrapDecideRequestSchema,
]);
import { MaintenanceOwnerConfigurationSchema } from "./coordinator-bootstrap-maintenance-setup.js";
export { MaintenanceOwnerConfigurationSchema } from "./coordinator-bootstrap-maintenance-setup.js";

interface MaintenanceControlInput {
  installationId: string;
  /** Protected provisioned origin, separate from the primary app and its cookies. */
  recoveryOrigin?: string;
  enrollment?: {
    decision: { id: string; revision: string; manifestSha256: string };
    review?: { id: string; revision: string; manifest: InstallationEnrollmentManifest };
    observe?(): Promise<void>;
    enroll(value: z.infer<typeof CoordinatorMaintenanceEnrollmentRequestSchema>): Promise<void>;
  };
  status(): z.infer<typeof CoordinatorMaintenanceStatusSchema>;
  /** Supplied only after selected persistent startup and native identity checks. */
  runtimeStatus?(): Promise<MaintenanceRuntimeIdentity & { ready: boolean }>;
  service(): BootstrapReviewService | undefined | Promise<BootstrapReviewService | undefined>;
  readOwnerConfiguration(): Promise<z.infer<typeof MaintenanceOwnerConfigurationSchema>>;
  provision(value: z.infer<typeof CoordinatorMaintenanceProvisionRequestSchema>): Promise<void>;
}

/** Transport for a fixed independently admitted operation. HTTP callers cannot
 * select source, runtime, plan, request ID or automatic authority. */
export function createMaintenanceControlApp(input: MaintenanceControlInput) {
  const recoveryOrigin =
    input.recoveryOrigin === undefined
      ? undefined
      : z
          .url()
          .refine((value) => {
            const url = new URL(value);
            return url.protocol === "https:" && url.origin === value;
          })
          .parse(input.recoveryOrigin);
  const app = express();
  let provisioning = false;
  app.disable("x-powered-by");
  app.use((request, response, next) => {
    if (recoveryOrigin && request.headers.host !== new URL(recoveryOrigin).host) {
      response.sendStatus(403);
      return;
    }
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    if (recoveryOrigin) {
      response.setHeader(
        "Content-Security-Policy",
        "default-src 'none'; script-src 'self'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
      );
    }
    next();
  });
  if (recoveryOrigin) {
    // Rendering does not read configuration, service status or maintenance journals.
    app.get("/", (_request, response) => response.type("html").send(maintenanceRecoveryDocument));
    app.get("/recovery.js", (_request, response) =>
      response.type("js").send(maintenanceRecoveryScript),
    );
  }
  app.get("/api/installation/maintenance/runtime-status", (request, response, next) => {
    const nonce = z.string().uuid().safeParse(request.query.nonce);
    if (!input.runtimeStatus) {
      response.sendStatus(404);
      return;
    }
    if (!nonce.success) {
      response.sendStatus(400);
      return;
    }
    void (async () => {
      try {
        const status = await input.runtimeStatus!();
        const { MaintenanceRuntimeStatusSchema } =
          await import("./coordinator-bootstrap-maintenance-service-status.js");
        response.json(
          MaintenanceRuntimeStatusSchema.parse({ ...status, version: 1, nonce: nonce.data }),
        );
      } catch (error) {
        next(error);
      }
    })();
  });
  app.get("/api/installation/maintenance/status", (_request, response) => {
    response.json(CoordinatorMaintenanceStatusSchema.parse(input.status()));
  });
  app.get("/api/installation/maintenance/enrollment", (_request, response) => {
    if (!input.enrollment?.review) {
      response.sendStatus(404);
      return;
    }
    response.json({
      ...input.enrollment.review,
      manifestSha256: input.enrollment.decision.manifestSha256,
    });
  });
  app.use("/api/installation/maintenance/owner", (request, response, next) => {
    void (async () => {
      try {
        const config = MaintenanceOwnerConfigurationSchema.parse(
          await input.readOwnerConfiguration(),
        );
        const expectedOrigin = recoveryOrigin ?? config.public.origin;
        const isolatedRecovery =
          recoveryOrigin === undefined || recoveryOrigin !== config.public.origin;
        if (
          config.public.installationId !== input.installationId ||
          request.header("origin") !== expectedOrigin ||
          !isolatedRecovery
        ) {
          response.sendStatus(403);
          return;
        }
        const cookieName =
          new URL(config.public.origin).protocol === "https:"
            ? "__Host-vorteo-owner"
            : "vorteo-owner";
        const cookie = request.headers.cookie
          ?.split(";")
          .map((part) => part.trim())
          .find((part) => part.startsWith(`${cookieName}=`))
          ?.slice(cookieName.length + 1);
        const sessions = new OwnerSessions(path.join(config.stateDir, "owner-sessions.json"));
        const authenticated =
          (recoveryOrigin === undefined && sessions.expiresAt(cookie) !== null) ||
          (await isBearerTokenValidAsync({
            password: config.ownerPasswordHash,
            token: extractHttpBearerToken(request.header("authorization")),
          }));
        if (!authenticated) {
          response.sendStatus(401);
          return;
        }
        next();
      } catch (error) {
        next(error);
      }
    })();
  });
  app.post(
    "/api/installation/maintenance/owner",
    express.json({ limit: "1mb" }),
    (request, response, next) => {
      void (async () => {
        try {
          if (request.body?.type === "installation.maintenance.observe.request") {
            if (!(await observeEnrollment(input.enrollment, request.body))) {
              response.status(400).json({ error: "Exact enrollment observation changed" });
              return;
            }
            response.json({ observed: true });
            return;
          }
          if (request.body?.type === "installation.maintenance.enroll.request") {
            const parsed = CoordinatorMaintenanceEnrollmentRequestSchema.safeParse(request.body);
            const enrollment = input.enrollment;
            if (
              !parsed.success ||
              !enrollment ||
              !sameEnrollmentDecision(parsed.data, enrollment.decision)
            ) {
              response.status(400).json({ error: "Exact enrollment review changed" });
              return;
            }
            if (provisioning) {
              response.status(409).json({ error: "Maintenance validation is already running" });
              return;
            }
            provisioning = true;
            try {
              await enrollment.enroll(parsed.data);
              response.json({ enrolled: true });
            } finally {
              provisioning = false;
            }
            return;
          }
          if (
            input.enrollment &&
            request.body?.type !== "installation.bootstrap.list_requests.request"
          ) {
            response.status(400).json({ error: "Use the exact installation enrollment review" });
            return;
          }
          if (request.body?.type === "installation.maintenance.provision.request") {
            const proposal = CoordinatorMaintenanceProvisionRequestSchema.safeParse(request.body);
            if (
              !proposal.success ||
              proposal.data.admissionSha256 !== input.status().provisioning.admissionSha256
            ) {
              response.status(400).json({ error: "Maintenance proposal changed" });
              return;
            }
            // A lost response must not start concurrent validation or preparation.
            // Durable admission and request checks remain the controller's responsibility.
            if (provisioning) {
              response.status(409).json({ error: "Maintenance validation is already running" });
              return;
            }
            provisioning = true;
            try {
              await input.provision(proposal.data);
              response.json({ provisioned: true });
            } finally {
              provisioning = false;
            }
            return;
          }
          const parsed = MessageSchema.safeParse(request.body);
          if (!parsed.success) {
            response.status(400).json({ error: "Invalid maintenance review request" });
            return;
          }
          const { handleBootstrapReview } = await import("./coordinator-bootstrap-session.js");
          response.json(await handleBootstrapReview(parsed.data, await input.service()));
        } catch (error) {
          next(error);
        }
      })();
    },
  );
  const failure: ErrorRequestHandler = (_error, _request, response, _next) => {
    response
      .status(503)
      .json({ error: "Maintenance controls are unavailable. Inspect retained status." });
  };
  app.use(failure);
  return app;
}

async function observeEnrollment(
  enrollment: MaintenanceControlInput["enrollment"],
  value: unknown,
) {
  const parsed = CoordinatorMaintenanceObserveRequestSchema.safeParse(value);
  if (
    !parsed.success ||
    !enrollment?.observe ||
    parsed.data.id !== enrollment.decision.id ||
    parsed.data.revision !== enrollment.decision.revision ||
    parsed.data.manifestSha256 !== enrollment.decision.manifestSha256
  )
    return false;
  await enrollment.observe();
  return true;
}

function sameEnrollmentDecision(
  value: { id: string; revision: string; manifestSha256: string },
  expected: { id: string; revision: string; manifestSha256: string },
) {
  return (
    value.id === expected.id &&
    value.revision === expected.revision &&
    value.manifestSha256 === expected.manifestSha256
  );
}
