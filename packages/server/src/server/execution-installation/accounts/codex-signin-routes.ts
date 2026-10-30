import type { ErrorRequestHandler, Express } from "express";
import { z } from "zod";
import type { CodexSignInRuntime } from "./codex-signin-runtime.js";

const Definition = z.strictObject({ definitionId: z.string().min(1).max(512) });
const Attempt = Definition.extend({ attemptId: z.string().uuid() });

/**
 * Must be mounted after the installation owner Origin/session gate. Codex signs in with a device
 * code, so there is no code submission route.
 */
export function mountCodexSignInRoutes(app: Express, runtime: CodexSignInRuntime): void {
  const root = "/api/installation/owner/codex/signin";
  const parseFailure: ErrorRequestHandler = (_error, _req, res, _next) => {
    res.sendStatus(400);
  };
  app.use(root, parseFailure);
  for (const operation of ["read", "start", "cancel", "sign-out"] as const) {
    app.post(`${root}/${operation}`, (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      void (async () => {
        try {
          if (operation === "cancel") {
            const input = Attempt.parse(req.body);
            res.json(await runtime.cancel(input.definitionId, input.attemptId));
            return;
          }
          const input = Definition.parse(req.body);
          if (operation === "read") res.json(runtime.read(input.definitionId));
          else if (operation === "start") res.json(await runtime.start(input.definitionId));
          else {
            const warning = await runtime.signOut(input.definitionId);
            res.json({ ...runtime.read(input.definitionId), ...(warning ? { warning } : {}) });
          }
        } catch {
          // Token-bearing exceptions never enter HTTP logs.
          res
            .status(409)
            .json({ error: "Codex sign-in could not complete. Refresh and try again." });
        }
      })();
    });
  }
}
