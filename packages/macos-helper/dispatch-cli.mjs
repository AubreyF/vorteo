import { invokeHelper } from "./host.mjs";
const [operation, flag] = process.argv.slice(2);
if (flag && flag !== "--preview") throw new Error("Unsupported flag");
let input = "";
for await (const chunk of process.stdin) {
  input += chunk;
  if (input.length > 16384) throw new Error("Request too large");
}
let parameters = {};
try {
  parameters = input.trim() ? JSON.parse(input) : {};
} catch {
  throw new Error("Invalid helper parameters");
}
const reply = await invokeHelper(operation, { preview: flag === "--preview", parameters });
process.stdout.write(JSON.stringify(reply) + "\n");
if (!reply.ok) process.exitCode = 1;
