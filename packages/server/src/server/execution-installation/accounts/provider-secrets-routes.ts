import type { ErrorRequestHandler, Express } from "express";
import {
  ProviderSecretClearRequestSchema,
  ProviderSecretSetRequestSchema,
  ProviderSecretsReadRequestSchema,
} from "@getpaseo/protocol/provider-secrets";
import {
  ProviderSecretsDefinitionMissing,
  type ProviderSecretsRuntime,
} from "./provider-secrets-runtime.js";

export const PROVIDER_SECRETS_OWNER_ROOT = "/api/installation/owner/provider-secrets";

/** Must be mounted after the installation owner Origin/session gate. */
export function mountProviderSecretsRoutes(app: Express, runtime: ProviderSecretsRuntime): void {
  const root = PROVIDER_SECRETS_OWNER_ROOT;
  const parseFailure: ErrorRequestHandler = (_error, _req, res, _next) => {
    res.sendStatus(400);
  };
  app.use(root, parseFailure);
  const handlers = {
    read: (body: unknown) => {
      const input = ProviderSecretsReadRequestSchema.safeParse(body ?? {});
      return input.success
        ? () => Promise.resolve().then(() => runtime.read(input.data.definitionId))
        : null;
    },
    set: (body: unknown) => {
      const input = ProviderSecretSetRequestSchema.safeParse(body);
      return input.success
        ? () => runtime.set(input.data.definitionId, input.data.name, input.data.value)
        : null;
    },
    clear: (body: unknown) => {
      const input = ProviderSecretClearRequestSchema.safeParse(body);
      return input.success ? () => runtime.clear(input.data.definitionId, input.data.name) : null;
    },
  };
  for (const [operation, parse] of Object.entries(handlers)) {
    app.post(`${root}/${operation}`, (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      const run = parse(req.body);
      if (!run) {
        // Validation details could echo a submitted value. Return a fixed message.
        res.status(400).json({
          error:
            "Enter a key name ending in _KEY, _TOKEN, _SECRET or _PASSWORD and a value without surrounding spaces or line breaks.",
        });
        return;
      }
      run().then(
        (definitions) => res.json({ definitions }),
        (error: unknown) => {
          if (error instanceof ProviderSecretsDefinitionMissing) {
            res.status(404).json({ error: "This connection no longer exists. Reload Settings." });
            return;
          }
          // Neither values nor value-bearing exceptions enter HTTP logs.
          res
            .status(409)
            .json({ error: "Shared keys could not be saved. Reload Settings and try again." });
        },
      );
    });
  }
}
