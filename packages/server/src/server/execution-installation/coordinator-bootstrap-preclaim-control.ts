import { createServer } from "node:http";
import { access } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import express, { type ErrorRequestHandler } from "express";
import { z } from "zod";
import {
  BootstrapAuthenticationRequired,
  BootstrapRequestConflict,
} from "./coordinator-bootstrap.js";
import {
  createBootstrapOwnerReviewApp,
  type OwnerReviewInput,
} from "./coordinator-bootstrap-owner-review.js";
import { readProtectedDocument } from "./coordinator-bootstrap-artifact.js";
import { BootstrapRunnerSetupSchema } from "./coordinator-bootstrap-runner.js";
import {
  BootstrapAdmissionSetupSchema,
  inspectBootstrapWritableMountRoots,
} from "./coordinator-bootstrap-host.js";
import { validatePreclaimRecoveryPlan } from "./coordinator-bootstrap-preclaim-recovery.js";
import { ProcessObservationSchema } from "./coordinator-bootstrap-process.js";
import { createNativeBootstrapServiceReader } from "./coordinator-bootstrap-service.js";
import {
  provisionPreclaimRepair,
  resolvePreclaimRepairFiles,
  verifyPreclaimRepairProposal,
  verifyPreclaimRepairProvisioning,
} from "./coordinator-bootstrap-preclaim-provisioning.js";
import {
  assertPreclaimControlBinding,
  createProvisionedPreclaimRecoveryReview,
} from "./coordinator-bootstrap-preclaim-provisioned-host.js";
import { writeRecoverySnapshot } from "./coordinator-bootstrap-launch.js";

type Review = Pick<OwnerReviewInput, "binding" | "client">;
interface PreclaimControlAppInput {
  origin(): string;
  admissionSha256: string;
  proposal: unknown;
  admitted?: Review;
  provision(ownerPassword: string): Promise<Review>;
}

/** Presentation cannot select paths or plans. Provisioning admits one pinned
 * runtime; the subsequent exact recovery button still supplies separate consent. */
export function createPreclaimRepairControlApp(input: PreclaimControlAppInput) {
  return createIndependentBootstrapControlApp({ ...input, scope: "preclaim-recovery" });
}

/** Both native roles use the same loopback presentation; the fixed service still
 * owns authentication, admission, preparation and exact decision dispatch. */
export function createIndependentBootstrapControlApp(
  input: PreclaimControlAppInput & { scope: OwnerReviewInput["scope"] },
) {
  const app = express();
  app.disable("x-powered-by");
  let reviewApp = input.admitted
    ? createBootstrapOwnerReviewApp({
        ...input.admitted,
        origin: input.origin,
        scope: input.scope,
      })
    : undefined;
  let busy = false;
  app.use((request, response, next) => {
    const origin = input.origin();
    if (
      !/^http:\/\/127\.0\.0\.1:[0-9]+$/.test(origin) ||
      request.headers.host !== new URL(origin).host
    ) {
      response.sendStatus(403);
      return;
    }
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'",
    );
    if (reviewApp) reviewApp(request, response, next);
    else next();
  });
  app.get("/", (_request, response) =>
    response
      .type("html")
      .send(
        input.scope === "preclaim-recovery"
          ? provisionHtml
          : provisionHtml.replaceAll("recovery", "coordinator maintenance"),
      ),
  );
  app.get("/proposal", (_request, response) =>
    response.json({ admissionSha256: input.admissionSha256, proposal: input.proposal, busy }),
  );
  app.post("/provision", express.json({ limit: "8kb" }), (request, response, next) => {
    void (async () => {
      if (request.header("origin") !== input.origin()) {
        response.sendStatus(403);
        return;
      }
      const body = z
        .strictObject({
          admissionSha256: z.string().regex(/^[a-f0-9]{64}$/),
          ownerPassword: z.string().min(1).max(4096),
        })
        .parse(request.body);
      if (busy || reviewApp || body.admissionSha256 !== input.admissionSha256) {
        response.sendStatus(409);
        return;
      }
      busy = true;
      try {
        const review = await input.provision(body.ownerPassword);
        reviewApp = createBootstrapOwnerReviewApp({
          ...review,
          origin: input.origin,
          scope: input.scope,
        });
        response.json({ provisioned: true });
      } finally {
        busy = false;
      }
    })().then(() => undefined, next);
  });
  const failure: ErrorRequestHandler = (error, _request, response, _next) => {
    const status = error instanceof BootstrapAuthenticationRequired ? 401 : 503;
    response.status(status).json({
      error:
        status === 401
          ? "Owner authentication failed. Nothing was approved."
          : "Independent controls could not finish validation. Inspect retained status; no lifecycle decision was retried.",
    });
  };
  app.use(failure);
  return app;
}

/** Opening this admitted native role never repeats a decision or launches a
 * retained recovery. Only an authenticated exact owner button can do that. */
export async function runProvisionedPreclaimRepairControl(input: {
  installationRoot: string;
  admissionSha256: string;
}) {
  const anchor = BootstrapRunnerSetupSchema.parse(
    JSON.parse(
      (
        await readProtectedDocument(
          path.join(input.installationRoot, "coordinator-bootstrap-runner.json"),
        )
      ).toString("utf8"),
    ),
  );
  const admission = BootstrapAdmissionSetupSchema.parse(
    JSON.parse((await readProtectedDocument(anchor.admissionSetupFile)).toString("utf8")),
  );
  const roots = await inspectBootstrapWritableMountRoots(admission);
  const files = await resolvePreclaimRepairFiles({ ...input, writableMountRoots: roots });
  const plan = validatePreclaimRecoveryPlan(
    JSON.parse((await readProtectedDocument(files.plan)).toString("utf8")),
  );
  const reader = await createNativeBootstrapServiceReader({
    ...admission,
    writableMountRoots: roots,
  });
  const controlProcess = ProcessObservationSchema.parse(await reader.inspectProcess(process.pid));
  const admitted = await access(files.admission).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );
  const binding = { ...input, plan, writableMountRoots: roots };
  const { receipt } = admitted
    ? await verifyPreclaimRepairProvisioning(binding)
    : await verifyPreclaimRepairProposal(binding);
  const args = [
    anchor.node.path,
    receipt.runtime.entrypoint.path,
    input.installationRoot,
    "preclaim-repair-control",
    input.admissionSha256,
  ];
  if (!isDeepStrictEqual(process.argv, args))
    throw new BootstrapRequestConflict("Preclaim controller argv changed");
  assertPreclaimControlBinding({
    setup: { node: anchor.node, entrypoint: receipt.runtime.entrypoint },
    provision: { ...input, controlProcess },
    plan,
  });
  const readReview = async (): Promise<Review> => {
    const service = await createProvisionedPreclaimRecoveryReview(input);
    const matches = service.list().filter((request) => isDeepStrictEqual(request.plan, plan));
    if (matches.length > 1)
      throw new BootstrapRequestConflict("Preclaim repair reviews are ambiguous");
    const request =
      matches[0] ??
      (await service.prepare({
        id: randomUUID(),
        plan,
        reason:
          "Retire only the exact stalled unclaimed coordinator executor; preserve Host, Dev, selected coordinator, installation data and approval history.",
      }));
    return {
      binding: { id: request.id, revision: request.revision, planSha256: request.planSha256 },
      client: {
        listCoordinatorBootstrapRequests: async () => service.list(),
        decideCoordinatorBootstrap: async (decision, password) => {
          await service.decide(decision, password, true);
          return [];
        },
      },
    };
  };
  const initial = admitted ? await readReview() : undefined;
  let origin = "";
  const app = createPreclaimRepairControlApp({
    origin: () => origin,
    admissionSha256: input.admissionSha256,
    proposal: { receipt, plan },
    admitted: initial,
    provision: async (ownerPassword) => {
      await provisionPreclaimRepair({
        ...binding,
        writableMountRoots: await inspectBootstrapWritableMountRoots(admission),
        ownerPassword,
      });
      return readReview();
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
      throw new BootstrapRequestConflict("Preclaim control listener is unavailable");
    origin = "http://127.0.0.1:" + address.port;
    const descriptor = {
      version: 1,
      admissionSha256: input.admissionSha256,
      originalId: plan.original.id,
      process: controlProcess,
      address: "127.0.0.1",
      port: address.port,
    };
    await writeRecoverySnapshot(
      path.join(input.installationRoot, `preclaim-repair-control-${process.pid}.json`),
      descriptor,
    );
    return { server, descriptor, url: origin };
  } catch (error) {
    server.close();
    throw error;
  }
}

const provisionHtml = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Vorteo recovery admission</title><style>body{font:17px system-ui;max-width:900px;margin:32px auto;padding:0 20px;background:#161819;color:#eee}pre{white-space:pre-wrap;overflow-wrap:anywhere}input,button{font:inherit;padding:12px;margin:8px 0}#error{color:#ffbf91}</style><h1>Authorize this exact recovery runtime</h1><p>This admits the pinned independent review machinery. It does not approve recovery, stop any process or change the selected coordinator, Host or Dev. A separate exact recovery button follows.</p><p id="status" role="status">Loading the fixed proposal...</p><p id="error" role="alert"></p><details><summary>Full exact proposal and retained original approval</summary><pre id="proposal"></pre></details><input type="password" id="password" autocomplete="off" aria-label="Installation owner password"><br><button id="admit" disabled>Authorize this exact review runtime</button><script>const el=id=>document.getElementById(id);let digest;fetch('/proposal',{cache:'no-store',redirect:'error'}).then(async r=>{if(!r.ok)throw Error();const p=await r.json();digest=p.admissionSha256;el('proposal').textContent=JSON.stringify(p,null,2);el('status').textContent=p.busy?'Provisioning is already in progress.':'Review the exact proposal and enter the existing installation owner password.';el('admit').disabled=p.busy;}).catch(()=>{el('error').textContent='Cannot read the proposal. No admission or recovery was sent.';});el('admit').onclick=async()=>{const ownerPassword=el('password').value;if(!ownerPassword){el('error').textContent='Enter the installation owner password.';return;}el('password').value='';el('error').textContent='';el('admit').disabled=true;el('status').textContent='Validating the exact runtime and preparing its separate recovery review. No process is being stopped.';try{const r=await fetch('/provision',{method:'POST',redirect:'error',headers:{'Content-Type':'application/json'},body:JSON.stringify({admissionSha256:digest,ownerPassword})});const p=await r.json();if(!r.ok){el('status').textContent='Admission not completed. No recovery decision was sent.';el('error').textContent=p.error;el('admit').disabled=false;return;}location.reload();}catch{el('error').textContent='Admission response unavailable. Reload to inspect retained status. No recovery decision was sent.';}};</script></html>`;
