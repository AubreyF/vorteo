import { readParameters } from "./protocol.mjs";
import { invokeHelper } from "./host.mjs";
const [operation, flag] = process.argv.slice(2);
if (flag && flag !== "--preview") throw new Error("Unsupported flag");
const parameters = await readParameters(process.stdin);
const reply = await invokeHelper(operation, { preview: flag === "--preview", parameters });
process.stdout.write(JSON.stringify(reply) + "\n");
if (!reply.ok) process.exitCode = 1;
