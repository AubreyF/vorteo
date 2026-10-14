import { createHash, randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { createServer } from "node:http";
import path from "node:path";
import express, { type ErrorRequestHandler } from "express";
import { z } from "zod";
import {
  BootstrapClaimedRepairProvisionRequestSchema,
  BootstrapClaimedRecoveryListRequestSchema,
  BootstrapClaimedRecoveryPrepareRequestSchema,
  BootstrapClaimedRecoveryDecideRequestSchema,
} from "@getpaseo/protocol/coordinator-bootstrap";
import { extractHttpBearerToken, isBearerTokenValidAsync } from "../auth.js";
import { OwnerSessions } from "./owner-sessions.js";
import {
  handleClaimedRecoveryReview,
  type ClaimedRecoveryReviewService,
} from "./coordinator-bootstrap-session.js";
import { BootstrapRequestConflict } from "./coordinator-bootstrap.js";
import {
  readBootstrapPreparedFile,
  readProtectedDocument,
} from "./coordinator-bootstrap-artifact.js";
import { validateClaimedRecoveryPlan } from "./coordinator-bootstrap-claimed-recovery.js";
import { createProvisionedClaimedRecoveryReview } from "./coordinator-bootstrap-claimed-provisioned-host.js";
import { BootstrapRunnerSetupSchema } from "./coordinator-bootstrap-runner.js";
import {
  BootstrapAdmissionSetupSchema,
  inspectBootstrapWritableMountRoots,
} from "./coordinator-bootstrap-host.js";
import { createNativeBootstrapServiceReader } from "./coordinator-bootstrap-service.js";
import { ProcessObservationSchema } from "./coordinator-bootstrap-process.js";
import {
  provisionClaimedRepair,
  verifyClaimedRepairProposal,
} from "./coordinator-bootstrap-claimed-provisioning.js";
import { writeRecoverySnapshot } from "./coordinator-bootstrap-launch.js";

const MessageSchema = z.discriminatedUnion("type", [
  BootstrapClaimedRecoveryListRequestSchema,
  BootstrapClaimedRecoveryPrepareRequestSchema,
  BootstrapClaimedRecoveryDecideRequestSchema,
]);
const OwnerConfigurationSchema = z.object({
  public: z.object({ origin: z.url() }),
  stateDir: z.string().startsWith("/"),
  ownerPasswordHash: z.string().startsWith("$2"),
});
interface RepairControlInput {
  installationId: string;
  service: ClaimedRecoveryReviewService;
  readOwnerConfiguration(): Promise<z.infer<typeof OwnerConfigurationSchema>>;
  provisioning?():
    | { admissionSha256: string; sourceCommit: string; artifactSha256: string; originalId: string }
    | undefined;
  provision?(input: z.infer<typeof BootstrapClaimedRepairProvisionRequestSchema>): Promise<void>;
}

/** A separate transport preserves the old Host's authority. Every mutation still
 * enters the existing exact-plan review service; HTTP cannot select a runtime. */
export function createClaimedRepairControlApp(input: RepairControlInput) {
  const app = express();
  app.disable("x-powered-by");
  app.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  app.get("/api/installation/claimed-repair/status", (_req, res) => {
    const requests = input.service.list();
    res.json({
      version: 1,
      installationId: input.installationId,
      available: input.service.available,
      requests: requests.length,
      ...(input.provisioning?.() ? { provisioning: input.provisioning() } : {}),
    });
  });
  app.use("/api/installation/claimed-repair/owner", (req, res, next) => {
    void (async () => {
      try {
        // Re-read the pinned configuration on each request. Changed credentials or
        // selection must stop this controller, not retain a stale owner session.
        const config = await input.readOwnerConfiguration();
        if (req.header("origin") !== config.public.origin) {
          res.sendStatus(403);
          return;
        }
        const secure = new URL(config.public.origin).protocol === "https:";
        const cookieName = secure ? "__Host-vorteo-owner" : "vorteo-owner";
        const cookie = req.headers.cookie
          ?.split(";")
          .map((part) => part.trim())
          .find((part) => part.startsWith(`${cookieName}=`))
          ?.slice(cookieName.length + 1);
        const sessions = new OwnerSessions(path.join(config.stateDir, "owner-sessions.json"));
        const token = extractHttpBearerToken(req.header("authorization"));
        const authenticated =
          sessions.expiresAt(cookie) !== null ||
          (await isBearerTokenValidAsync({
            password: config.ownerPasswordHash,
            token,
          }));
        if (!authenticated) {
          res.sendStatus(401);
          return;
        }
        next();
      } catch (error) {
        next(error);
      }
    })();
  });
  app.post(
    "/api/installation/claimed-repair/owner",
    express.json({ limit: "1mb" }),
    (req, res, next) => {
      if (req.body?.type === "installation.claimed_repair.provision.request") {
        const proposal = BootstrapClaimedRepairProvisionRequestSchema.safeParse(req.body);
        if (!proposal.success || !input.provision) {
          res.status(400).json({ error: "Invalid repair provisioning request" });
          return;
        }
        void input.provision(proposal.data).then(() => res.json({ provisioned: true }), next);
        return;
      }
      const parsed = MessageSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid claimed repair request" });
        return;
      }
      void (async () => {
        try {
          res.json(await handleClaimedRecoveryReview(parsed.data, input.service));
        } catch (error) {
          next(error);
        }
      })();
    },
  );
  const failure: ErrorRequestHandler = (_error, _req, res, _next) => {
    // Never return filesystem errors, submitted passwords or configuration data.
    res.status(503).json({
      error: "Repair controls are unavailable. Inspect retained status.",
    });
  };
  app.use(failure);
  return app;
}

/** Opening this listener only observes existing work. It does not approve,
 * resume or replay a recovery decision after a controller restart. */
export async function runProvisionedClaimedRepairControl(input: {
  installationRoot: string;
  admissionSha256: string;
}) {
  const plan = validateClaimedRecoveryPlan(
    JSON.parse(
      (
        await readProtectedDocument(path.join(input.installationRoot, "claimed-repair-plan.json"))
      ).toString("utf8"),
    ),
  );
  const anchor = BootstrapRunnerSetupSchema.parse(
    JSON.parse(
      (
        await readProtectedDocument(
          path.join(input.installationRoot, "coordinator-bootstrap-runner.json"),
        )
      ).toString("utf8"),
    ),
  );
  const anchorAdmission = BootstrapAdmissionSetupSchema.parse(
    JSON.parse((await readProtectedDocument(anchor.admissionSetupFile)).toString("utf8")),
  );
  const roots = await inspectBootstrapWritableMountRoots(anchorAdmission);
  const reader = await createNativeBootstrapServiceReader({
    ...anchorAdmission,
    writableMountRoots: roots,
  });
  const controlProcess = ProcessObservationSchema.parse(await reader.inspectProcess(process.pid));
  let service: ClaimedRecoveryReviewService | undefined;
  let proposal: Awaited<ReturnType<typeof verifyClaimedRepairProposal>> | undefined;
  const admitted = await access(
    path.join(input.installationRoot, "claimed-repair-admission.json"),
  ).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return false;
    },
  );
  if (admitted) {
    service = await createProvisionedClaimedRecoveryReview(input);
  } else {
    proposal = await verifyClaimedRepairProposal({ ...input, plan, writableMountRoots: roots });
    const args = [
      anchor.node.path,
      proposal.receipt.runtime.entrypoint.path,
      input.installationRoot,
      "claimed-repair-control",
      input.admissionSha256,
    ];
    if (
      !isDeepStrictEqual(process.argv, args) ||
      controlProcess.executable !== anchor.node.path ||
      controlProcess.argumentsSha256 !==
        createHash("sha256").update(JSON.stringify(args)).digest("hex")
    )
      throw new BootstrapRequestConflict("Repair proposal controller identity changed");
  }
  const unavailable: ClaimedRecoveryReviewService = {
    available: false,
    list: () => [],
    prepare: async () => {
      throw new BootstrapRequestConflict("Owner provisioning required");
    },
    decide: async () => {
      throw new BootstrapRequestConflict("Owner provisioning required");
    },
  };
  let provisioning = false;
  const prepareReview = async () => {
    if (service && service.list().length === 0)
      await service.prepare({
        id: randomUUID(),
        plan,
        reason:
          "Recover the stalled coordinator executor while preserving its original approval, selected coordinator and running Host and Dev work.",
      });
  };
  // Preparing a review has no process effects and cannot replay an approval.
  if (service) await prepareReview();
  const app = createClaimedRepairControlApp({
    installationId: plan.original.plan.installationId,
    get service() {
      return service ?? unavailable;
    },
    provisioning: () =>
      !service && proposal
        ? {
            admissionSha256: input.admissionSha256,
            sourceCommit: proposal.receipt.runtime.sourceCommit,
            artifactSha256: proposal.receipt.runtime.artifactSha256,
            originalId: plan.original.id,
          }
        : undefined,
    provision: async (request) => {
      if (provisioning || service || !proposal || request.admissionSha256 !== input.admissionSha256)
        throw new BootstrapRequestConflict("Repair provisioning changed or is already running");
      provisioning = true;
      try {
        const current = await verifyClaimedRepairProposal({
          ...input,
          plan,
          writableMountRoots: await inspectBootstrapWritableMountRoots(anchorAdmission),
        });
        await provisionClaimedRepair({
          installationRoot: input.installationRoot,
          plan,
          receipt: current.receipt,
          ownerPassword: request.ownerPassword,
          writableMountRoots: roots,
        });
        service = await createProvisionedClaimedRecoveryReview(input);
        await prepareReview();
      } finally {
        provisioning = false;
      }
    },
    readOwnerConfiguration: async () => {
      const bytes = await readBootstrapPreparedFile(plan.selectedConfiguration, []);
      const config = OwnerConfigurationSchema.parse(JSON.parse(bytes.toString("utf8")));
      if (config.stateDir !== plan.original.plan.state.directory)
        throw new BootstrapRequestConflict("Repair owner state changed");
      return config;
    },
  });
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string")
      throw new BootstrapRequestConflict("Repair control listener is unavailable");
    const descriptor = {
      version: 1,
      admissionSha256: input.admissionSha256,
      originalId: plan.original.id,
      process: controlProcess,
      address: "127.0.0.1",
      port: address.port,
    };
    await writeRecoverySnapshot(
      path.join(input.installationRoot, `claimed-repair-control-${process.pid}.json`),
      descriptor,
    );
    return { server, descriptor };
  } catch (error) {
    server.close();
    throw error;
  }
}
