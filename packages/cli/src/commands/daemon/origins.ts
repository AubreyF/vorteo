import { Command } from "commander";
import { z } from "zod";
import {
  DaemonOriginAdmissionInputSchema,
  type DaemonOriginAdmissionResponse,
  type DaemonOriginAdmissionInspectResponse,
} from "@getpaseo/protocol/messages";
import { connectToDaemon } from "../../utils/client.js";
import { addJsonAndDaemonHostOptions } from "../../utils/command-options.js";
import {
  withOutput,
  type CommandOptions,
  type OutputSchema,
  type SingleResult,
} from "../../output/index.js";

const OriginCommandInputSchema = DaemonOriginAdmissionInputSchema.extend({
  expectedServerId: z.string().min(1),
  requestId: z.string().uuid(),
  origin: z.string().refine((value) => {
    try {
      const url = new URL(value);
      const supported = url.protocol === "http:" || url.protocol === "https:";
      return supported && url.origin === value && !url.username && !url.password;
    } catch {
      return false;
    }
  }, "Supply a canonical HTTP or HTTPS origin without credentials, path or query"),
});
type OriginCommandInput = z.infer<typeof OriginCommandInputSchema>;
type AppliedOrigin = Extract<DaemonOriginAdmissionResponse["payload"], { state: "applied" }>;
type OriginObservation = DaemonOriginAdmissionInspectResponse["payload"];
export type OriginCommandClient = Pick<
  Awaited<ReturnType<typeof connectToDaemon>>,
  "getLastServerInfoMessage" | "inspectOriginAdmission" | "admitOrigin"
>;

const observationSchema: OutputSchema<OriginObservation> = {
  idField: "serverId",
  columns: [
    { header: "SERVER", field: "serverId" },
    { header: "STATE", field: "state" },
    { header: "OBSERVED", field: "observedAt" },
    { header: "REASON", field: "reason" },
  ],
};
const appliedSchema: OutputSchema<AppliedOrigin> = {
  idField: "requestId",
  columns: [
    { header: "SERVER", field: "serverId" },
    { header: "REQUEST", field: "requestId" },
    { header: "ORIGIN", field: "origin" },
    { header: "PERSISTED ADDED", field: "addedToPersisted" },
    { header: "ACTIVE ADDED", field: "addedToActive" },
  ],
};

/** Correlation identifies this invocation; it does not provide durable lookup or idempotency. */
export async function admitOriginWithClient(
  client: OriginCommandClient,
  input: OriginCommandInput,
): Promise<AppliedOrigin> {
  const captured = OriginCommandInputSchema.parse(input);
  const inspect = client.inspectOriginAdmission;
  const admit = client.admitOrigin;
  const getInfo = client.getLastServerInfoMessage;
  const methodsMatch = () =>
    client.inspectOriginAdmission === inspect &&
    client.admitOrigin === admit &&
    client.getLastServerInfoMessage === getInfo;
  const observed = await inspect.call(client, { expectedServerId: captured.expectedServerId });
  const hostMatches =
    observed.serverId === captured.expectedServerId &&
    getInfo.call(client)?.serverId === captured.expectedServerId;
  const persistedMatches =
    JSON.stringify(observed.persistedOrigins) === JSON.stringify(captured.expectedPersistedOrigins);
  const activeMatches =
    JSON.stringify(observed.activeOrigins) === JSON.stringify(captured.expectedActiveOrigins);
  if (
    !methodsMatch() ||
    !hostMatches ||
    observed.state !== "ready" ||
    observed.reason !== null ||
    !persistedMatches ||
    !activeMatches
  )
    throw {
      code: "ORIGIN_PRECONDITION_CHANGED",
      message:
        "Origin setup or serving identity changed. Inspect again before a new authorized attempt.",
      details: observed,
    };
  let result: DaemonOriginAdmissionResponse["payload"];
  try {
    result = await admit.call(client, captured);
    const resultMatches =
      result.serverId === captured.expectedServerId && result.requestId === captured.requestId;
    if (
      !methodsMatch() ||
      !resultMatches ||
      getInfo.call(client)?.serverId !== captured.expectedServerId
    )
      throw new Error("Origin admission identity changed");
  } catch {
    throw {
      code: "ORIGIN_ADMISSION_UNCERTAIN",
      message:
        "Origin response was lost or invalid. Retain this invocation and reconcile the same host, disk and active lists without automatic replay.",
      details: { ...captured, reconciliationRequired: true },
    };
  }
  if (result.state !== "applied")
    throw {
      code:
        result.state === "uncertain" ? "ORIGIN_ADMISSION_UNCERTAIN" : "ORIGIN_ADMISSION_REFUSED",
      message: result.reason,
      details: { invocation: captured, result },
    };
  return result;
}

async function runInspectOriginCommand(
  options: CommandOptions,
  _command: Command,
): Promise<SingleResult<OriginObservation>> {
  const expectedServerId = z.string().min(1).parse(options.expectedServerId);
  const target = structuredClone(options.daemonTarget);
  const client = await connectToDaemon({ target });
  try {
    return {
      type: "single",
      data: await client.inspectOriginAdmission({ expectedServerId }),
      schema: observationSchema,
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function runAdmitOriginCommand(
  origin: string,
  options: CommandOptions,
  _command: Command,
): Promise<SingleResult<AppliedOrigin>> {
  const input = OriginCommandInputSchema.parse({
    origin,
    expectedServerId: options.expectedServerId,
    requestId: options.requestId,
    expectedPersistedOrigins: JSON.parse(z.string().parse(options.expectedPersistedOrigins)),
    expectedActiveOrigins: JSON.parse(z.string().parse(options.expectedActiveOrigins)),
  });
  const target = structuredClone(options.daemonTarget);
  const client = await connectToDaemon({ target });
  try {
    return {
      type: "single",
      data: await admitOriginWithClient(client, input),
      schema: appliedSchema,
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}

export function createOriginsCommand(): Command {
  const origins = new Command("origins").description(
    "Inspect or conditionally admit a daemon browser origin",
  );
  addJsonAndDaemonHostOptions(
    origins
      .command("inspect")
      .requiredOption("--expected-server-id <id>", "Exact serving daemon identity")
      .allowExcessArguments(false),
  ).action(withOutput(runInspectOriginCommand));
  addJsonAndDaemonHostOptions(
    origins
      .command("admit <origin>")
      .requiredOption("--expected-server-id <id>", "Exact serving daemon identity")
      .requiredOption(
        "--request-id <uuid>",
        "Correlation identity for this invocation, not durable idempotency",
      )
      .requiredOption("--expected-persisted-origins <json>", "Exact approved persisted origin list")
      .requiredOption("--expected-active-origins <json>", "Exact approved active origin list")
      .allowExcessArguments(false),
  ).action(withOutput(runAdmitOriginCommand));
  return origins;
}
