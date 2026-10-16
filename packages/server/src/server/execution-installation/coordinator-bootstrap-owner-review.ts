import express, { type ErrorRequestHandler } from "express";
import { z } from "zod";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { CoordinatorBootstrapRequestView } from "@getpaseo/protocol/coordinator-bootstrap";

const BindingSchema = z.strictObject({
  id: z.string().uuid(),
  revision: z.string().uuid(),
  planSha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export interface OwnerReviewInput {
  binding: z.infer<typeof BindingSchema>;
  origin(): string;
  scope?: "coordinator-migration" | "preclaim-recovery";
  client: {
    // The actual client validates and retains the complete request/plan. Only
    // these identity fields participate in this presentation's admission.
    listCoordinatorBootstrapRequests(): Promise<
      Pick<
        CoordinatorBootstrapRequestView,
        "id" | "revision" | "planSha256" | "status" | "reason"
      >[]
    >;
    decideCoordinatorBootstrap: DaemonClient["decideCoordinatorBootstrap"];
  };
}

/** An independent presentation of an existing Host review. It cannot prepare a
 * request, choose a plan, supply owner credentials or dispatch outside that service. */
export function createBootstrapOwnerReviewApp(input: OwnerReviewInput) {
  const binding = BindingSchema.parse(input.binding);
  let attempted = false;
  const app = express();
  app.disable("x-powered-by");
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
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'",
    );
    next();
  });
  async function read() {
    const requests = await input.client.listCoordinatorBootstrapRequests();
    const request = requests.find((item) => item.id === binding.id);
    if (!request || request.planSha256 !== binding.planSha256)
      throw new Error("Exact retained review unavailable");
    return request;
  }
  app.get("/", (_request, response) =>
    response.type("html").send(ownerReviewDocument(input.scope)),
  );
  app.get("/review", (_request, response, next) => {
    void read().then((request) => response.json({ request, attempted, binding }), next);
  });
  app.post("/decision", express.json({ limit: "16kb" }), (request, response, next) => {
    void (async () => {
      try {
        if (request.header("origin") !== input.origin()) {
          response.sendStatus(403);
          return;
        }
        const decision = z
          .strictObject({
            decision: z.enum(["approve", "cancel"]),
            ownerPassword: z.string().min(1).max(4096),
          })
          .parse(request.body);
        const retained = await read();
        if (attempted || retained.revision !== binding.revision || retained.status !== "pending") {
          response.status(409).json({
            error:
              "This review changed or a decision was already sent. Observe its retained status; do not repeat the operation.",
          });
          return;
        }
        attempted = true;
        try {
          await input.client.decideCoordinatorBootstrap(
            { ...binding, decision: decision.decision },
            decision.ownerPassword,
          );
          response.json({ request: await read() });
        } catch {
          response.status(503).json({
            error:
              "Decision response unavailable. Observe the retained status before any further action. No decision was retried.",
          });
        }
      } catch (error) {
        next(error);
      }
    })();
  });
  const failure: ErrorRequestHandler = (_error, _request, response, _next) => {
    response
      .status(503)
      .json({ error: "Exact Host review unavailable. No operation was retried." });
  };
  app.use(failure);
  return app;
}

function ownerReviewDocument(scope: OwnerReviewInput["scope"]) {
  if (scope !== "preclaim-recovery") return ownerReviewHtml;
  return ownerReviewHtml
    .replace(
      "This independent page uses the existing Host review service while the normal coordinator is unavailable.",
      "This independent page uses the admitted native recovery service while the normal coordinator is unavailable.",
    )
    .replace(
      "The exact plan replaces the coordinator. Host and Dev agents are not restarted by this decision. Compatible recovery and the configured delivery tools are included in the plan below. This does not grant standing maintenance authority.",
      "This exact plan cancels the retained unclaimed migration and retires only its reviewed stalled executor. It preserves the selected coordinator, Host and Dev, installation data and approval history. It does not install a replacement or grant standing maintenance authority.",
    )
    .replace(
      "Approve this exact coordinator migration",
      "Retire only the reviewed stalled executor",
    )
    .replace(
      "Approve this exact coordinator replacement and compatible recovery plan?",
      "Approve cancellation of the retained migration and retirement of only its reviewed stalled executor?",
    );
}

const ownerReviewHtml = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Vorteo installation recovery</title>
<style>body{font:17px system-ui;max-width:900px;margin:32px auto;padding:0 20px;background:#161819;color:#eee}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#242729;padding:16px}button,input{font:inherit;padding:12px;margin:6px 8px 6px 0}button{cursor:pointer}input{max-width:90%}#error{color:#ffbf91}summary{padding:12px;cursor:pointer}</style>
<h1>Review coordinator recovery</h1><p>This independent page uses the existing Host review service while the normal coordinator is unavailable. Opening it approves nothing.</p>
<p>The exact plan replaces the coordinator. Host and Dev agents are not restarted by this decision. Compatible recovery and the configured delivery tools are included in the plan below. This does not grant standing maintenance authority.</p>
<p id="status" role="status">Loading retained request…</p><p id="error" role="alert"></p><pre id="identity"></pre><details><summary>Full exact plan and retained request</summary><pre id="plan"></pre></details>
<p>Review the plan, then enter the existing installation owner password. It is never saved by this page. Use the owner-password file in this installation if needed.</p>
<input id="password" type="password" autocomplete="off" aria-label="Installation owner password"><br>
<button id="approve" disabled>Approve this exact coordinator migration</button><button id="cancel" disabled>Cancel this exact request</button>
<p>After a decision is sent, this page only observes. A lost reply never triggers another approval or restart.</p>
<script>
let sending=false;
const el=id=>document.getElementById(id);
async function refresh(){try{const response=await fetch('/review',{cache:'no-store',redirect:'error'});const value=await response.json();if(!response.ok)throw Error(value.error);const r=value.request;el('status').textContent='Status: '+r.status+(r.execution?' / '+r.execution.stage:'');el('identity').textContent=JSON.stringify({id:r.id,revision:r.revision,planSha256:r.planSha256,reason:r.reason},null,2);el('plan').textContent=JSON.stringify(r,null,2);const enabled=!sending&&!value.attempted&&r.status==='pending'&&r.revision===value.binding.revision;el('approve').disabled=!enabled;el('cancel').disabled=!enabled;}catch{el('error').textContent='Cannot read the retained Host review. No approval was sent or retried.';el('approve').disabled=true;el('cancel').disabled=true;}}
async function decide(decision){const ownerPassword=el('password').value;if(!ownerPassword){el('error').textContent='Enter the installation owner password.';return;}if(!confirm(decision==='approve'?'Approve this exact coordinator replacement and compatible recovery plan?':'Cancel this exact pending coordinator request?'))return;sending=true;el('password').value='';el('approve').disabled=true;el('cancel').disabled=true;el('error').textContent='Decision sent once. Native validation can take several minutes; the retained status below remains authoritative.';try{const response=await fetch('/decision',{method:'POST',redirect:'error',headers:{'Content-Type':'application/json'},body:JSON.stringify({decision,ownerPassword})});const result=await response.json();el('error').textContent=response.ok?'Decision recorded. Observe the retained execution status.':result.error;}catch{el('error').textContent='Decision response unavailable. Observe status. Do not repeat the operation.';}await refresh();}
el('approve').onclick=()=>decide('approve');el('cancel').onclick=()=>decide('cancel');refresh();setInterval(refresh,5000);
</script></html>`;
