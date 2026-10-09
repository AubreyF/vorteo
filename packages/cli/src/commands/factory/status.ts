import type { Command } from "commander";
import { factorySnapshot, type FactorySnapshot } from "@getpaseo/server/factory-contracts";
import type { CommandOptions, OutputSchema, SingleResult } from "../../output/index.js";
import { connectToDaemon } from "../../utils/client.js";

const schema: OutputSchema<FactorySnapshot> = {
  idField: "projectId",
  columns: [
    { header: "PROJECT", field: "projectId" },
    { header: "INSTALLATION", field: (value) => value.installationId ?? "Unavailable" },
    { header: "FRESHNESS", field: (value) => value.freshness.state },
    { header: "ADMISSION", field: (value) => value.admission.state },
    { header: "REASON", field: (value) => value.admission.reason ?? "None observed" },
    { header: "USAGE", field: (value) => value.account.usagePoints ?? "Unknown" },
    { header: "UNIT", field: (value) => value.account.unit },
  ],
};

export async function runStatusCommand(
  projectId: string,
  options: CommandOptions,
  _command: Command,
): Promise<SingleResult<FactorySnapshot>> {
  const input = factorySnapshot.input.parse({ projectId });
  const client = await connectToDaemon({ target: options.daemonTarget });
  try {
    const info = client.getLastServerInfoMessage();
    // COMPAT(factoryStatus): introduced for v0.11.0-beta.3.vorteo.180; remove after 2027-04-08 once the daemon floor supports plugin RPC.
    if (info?.features?.plugins !== true) {
      throw {
        code: "DAEMON_UPDATE_REQUIRED",
        message: "Update the host to observe Factory status.",
      };
    }
    const data = factorySnapshot.output.parse(
      await client.invokePluginRpc("factory", factorySnapshot.name, input),
    );
    if (
      data.serverId !== info.serverId ||
      client.getLastServerInfoMessage()?.serverId !== info.serverId ||
      data.projectId !== input.projectId
    ) {
      throw {
        code: "FACTORY_IDENTITY_MISMATCH",
        message: "Factory observation does not match the selected daemon and project.",
      };
    }
    return { type: "single", data, schema };
  } finally {
    await client.close().catch(() => undefined);
  }
}
