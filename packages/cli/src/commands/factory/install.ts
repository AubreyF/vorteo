import type { Command } from "commander";
import {
  factoryInstall,
  FactoryInstallInputSchema,
  type FactoryInstallResult,
} from "@getpaseo/server/factory-operations";
import type { CommandOptions, OutputSchema, SingleResult } from "../../output/index.js";
import { connectToDaemon } from "../../utils/client.js";
import { readFactorySetup } from "./setup.js";

type AppliedInstall = Extract<FactoryInstallResult, { outcome: "applied" }>;

const schema: OutputSchema<AppliedInstall> = {
  idField: "operationId",
  columns: [
    { header: "PROJECT", field: "projectId" },
    { header: "SERVER", field: "serverId" },
    { header: "OPERATION", field: "operationId" },
    { header: "OUTCOME", field: "outcome" },
    {
      header: "INSTALLATION",
      field: (value) => ("installationId" in value ? value.installationId : null),
    },
  ],
};

export async function runInstallCommand(
  projectId: string,
  options: CommandOptions,
  _command: Command,
): Promise<SingleResult<AppliedInstall>> {
  const input = FactoryInstallInputSchema.parse({
    projectId,
    expectedServerId: options.expectedServerId,
    expectedInstallationId: null,
    expectedRevision: options.expectedRevision,
    operationId: options.operationId,
  });
  const client = await connectToDaemon({ target: options.daemonTarget });
  try {
    const serverId = client.getLastServerInfoMessage()?.serverId;
    if (serverId !== input.expectedServerId)
      throw {
        code: "FACTORY_IDENTITY_MISMATCH",
        message: "Selected daemon differs from the install precondition.",
      };
    const setup = await readFactorySetup(client, projectId, serverId);
    if (
      !setup.operations.install ||
      setup.state !== "ready" ||
      setup.installationId !== null ||
      setup.revision !== input.expectedRevision ||
      setup.observedAt === null
    )
      throw {
        code: "FACTORY_INSTALL_PRECONDITION_CHANGED",
        message:
          "Factory setup is held, unavailable or changed. Read setup before another attempt.",
        details: setup,
      };
    let result: FactoryInstallResult;
    try {
      // A dispatch may persist before its response is lost. Never replay this mutation.
      result = factoryInstall.output.parse(
        await client.invokePluginRpc("factory", factoryInstall.name, input),
      );
      if (
        result.serverId !== serverId ||
        result.projectId !== projectId ||
        result.operationId !== input.operationId ||
        client.getLastServerInfoMessage()?.serverId !== serverId
      )
        throw new Error("Factory install response identity changed.");
    } catch {
      throw {
        code: "FACTORY_INSTALL_UNCERTAIN",
        message:
          "Install response was lost or invalid. Reconcile the original operation before retrying.",
        details: {
          serverId,
          projectId,
          operationId: input.operationId,
          reconciliationRequired: true,
        },
      };
    }
    if (result.outcome !== "applied")
      throw {
        code:
          result.outcome === "uncertain" ? "FACTORY_INSTALL_UNCERTAIN" : "FACTORY_INSTALL_REFUSED",
        message: result.reason,
        details: result,
      };
    return { type: "single", data: result, schema };
  } finally {
    await client.close().catch(() => undefined);
  }
}
