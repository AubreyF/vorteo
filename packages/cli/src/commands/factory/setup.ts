import type { Command } from "commander";
import { factorySetup, type FactorySetup } from "@getpaseo/server/factory-operations";
import type { CommandOptions, OutputSchema, SingleResult } from "../../output/index.js";
import { connectToDaemon } from "../../utils/client.js";

const schema: OutputSchema<FactorySetup> = {
  idField: "projectId",
  columns: [
    { header: "PROJECT", field: "projectId" },
    { header: "SERVER", field: "serverId" },
    { header: "STATE", field: "state" },
    { header: "INSTALLATION", field: (value) => value.installationId ?? "Unavailable" },
    { header: "REVISION", field: (value) => value.revision ?? "Unavailable" },
    { header: "INSTALL", field: (value) => value.operations.install },
    { header: "REASON", field: (value) => value.reason ?? "None observed" },
  ],
};

export async function readFactorySetup(
  client: Awaited<ReturnType<typeof connectToDaemon>>,
  projectId: string,
  serverId: string,
): Promise<FactorySetup> {
  if (client.getLastServerInfoMessage()?.features?.plugins !== true)
    throw { code: "DAEMON_UPDATE_REQUIRED", message: "The selected daemon lacks plugin RPC." };
  const data = factorySetup.output.parse(
    await client.invokePluginRpc("factory", factorySetup.name, { projectId }),
  );
  if (
    data.serverId !== serverId ||
    data.projectId !== projectId ||
    client.getLastServerInfoMessage()?.serverId !== serverId
  )
    throw {
      code: "FACTORY_IDENTITY_MISMATCH",
      message: "Factory setup does not match the selected daemon and project.",
    };
  return data;
}

export async function runSetupCommand(
  projectId: string,
  options: CommandOptions,
  _command: Command,
): Promise<SingleResult<FactorySetup>> {
  factorySetup.input.parse({ projectId });
  const client = await connectToDaemon({ target: options.daemonTarget });
  try {
    const serverId = client.getLastServerInfoMessage()?.serverId;
    if (!serverId)
      throw {
        code: "FACTORY_IDENTITY_MISMATCH",
        message: "Serving daemon identity is unavailable.",
      };
    return { type: "single", data: await readFactorySetup(client, projectId, serverId), schema };
  } finally {
    await client.close().catch(() => undefined);
  }
}
