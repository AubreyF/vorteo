import type { ErrorRequestHandler, Express } from "express";
import { z } from "zod";
import type { ClaudeSetupRuntime } from "./claude-setup-runtime.js";

const Definition = z.strictObject({ definitionId: z.string().min(1).max(512) });
const Attempt = Definition.extend({ attemptId: z.string().uuid() });
const Submission = Attempt.extend({ code: z.string().min(1).max(4096) });

/** Must be mounted after the installation owner Origin/session gate. */
export function mountClaudeSetupRoutes(app: Express, runtime: ClaudeSetupRuntime): void {
  const root = "/api/installation/owner/claude/setup-token";
  const parseFailure: ErrorRequestHandler = (_error, _req, res, _next) => {
    res.sendStatus(400);
  };
  app.use(root, parseFailure);
  for (const operation of ["read", "start", "submit", "cancel", "sign-out"] as const) {
    app.post(`${root}/${operation}`, (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      void (async () => {
        try {
          if (operation === "submit") {
            const input = Submission.parse(req.body);
            res.json(await runtime.submit(input.definitionId, input.attemptId, input.code));
          } else if (operation === "cancel") {
            const input = Attempt.parse(req.body);
            res.json(await runtime.cancel(input.definitionId, input.attemptId));
          } else {
            const input = Definition.parse(req.body);
            if (operation === "read") res.json(runtime.read(input.definitionId));
            else if (operation === "start") res.json(await runtime.start(input.definitionId));
            else {
              await runtime.signOut(input.definitionId);
              res.json(runtime.read(input.definitionId));
            }
          }
        } catch {
          // Neither authorization codes nor credential-bearing exceptions enter HTTP logs.
          res
            .status(409)
            .json({ error: "Claude connection could not complete. Refresh and try again." });
        }
      })();
    });
  }
}
