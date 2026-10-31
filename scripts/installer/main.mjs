#!/usr/bin/env node
// Installer engine command line. The installer UX (install.sh) calls it; see
// docs/execution-installation.md#one-command-installation-contract.
//
//   detect --json                    What exists here and which prerequisites are met.
//   plan --answers <file> --json     {plan, summary} from the answers; changes nothing.
//   plan --adopt [--source <dir>]    {plan, summary} upgrading the Host installation made
//                                    before this installer at --root in place.
//   apply --plan <file>              One JSON object per line: {step, status, message, fix?},
//                                    then {result: {origin, localOrigin, passwordFile, name}}.
//   status --json                    The installation's services, readiness and steps.
//   uninstall [--keep-data]          Stops and unregisters everything this installation added.
//   repair                           Re-registers services and reruns the idempotent steps.
//   adopt [--source <dir>] [--outcome <file>]
//                                    Plans and applies that in-place upgrade, resuming a
//                                    started one; the coordinator runs it detached.
//
// Every command takes --root <folder> in place of ~/vorteo.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { applyPlan, hostRelease, installationStatus, repair, uninstall } from "./apply.mjs";
import { createContext } from "./context.mjs";
import { detect } from "./detect.mjs";
import { adoptHost, createHostAdoptionPlan } from "./host-adoption.mjs";
import { createPlan } from "./plan.mjs";
import { isMainModule } from "../is-main-module.mjs";
import { stopRunning } from "./primitives.mjs";

const USAGE =
  "Usage: main.mjs detect|plan --answers <file>|plan --adopt [--source <dir>]|apply --plan <file>|status|uninstall [--keep-data]|repair|adopt [--source <dir>] [--outcome <file>]|host-release --revision <commit> --outcome <file> [--json] [--root <folder>]";

function readJsonFile(file, label) {
  if (!file) throw Object.assign(new Error(`Pass --${label} <file>.`), { usage: true });
  return JSON.parse(readFileSync(file, "utf8"));
}

const exit = (ok) => (ok ? 0 : 1);

/** Each command returns its exit status. */
const COMMANDS = {
  async detect({ context, pretty, values }) {
    pretty(await detect(context, { docker: !values["no-docker"] }));
    return 0;
  },
  async plan({ context, values, write, pretty }) {
    const result = values.adopt
      ? await createHostAdoptionPlan(context, { source: values.source, revision: values.revision })
      : await createPlan(readJsonFile(values.answers, "answers"), context);
    if (values.json) pretty(result);
    else write(result.summary.join("\n") + "\n");
    return 0;
  },
  apply: async ({ context, values, line }) =>
    exit(await applyPlan(readJsonFile(values.plan, "plan"), context, line)),
  async status({ context, pretty }) {
    pretty(await installationStatus(context));
    return 0;
  },
  uninstall: async ({ context, values, line }) =>
    exit(await uninstall(context, { keepData: values["keep-data"] === true }, line)),
  repair: async ({ context, line }) => exit(await repair(context, line)),
  adopt: async ({ context, values, line }) =>
    exit(
      await adoptHost(
        context,
        { source: values.source, revision: values.revision, outcome: values.outcome },
        line,
      ),
    ),
  "host-release": async ({ context, values }) =>
    exit(await hostRelease(context, { revision: values.revision, outcome: values.outcome })),
};

/**
 * @param {string[]} argv
 * @param {{ context?: object, write?: (text: string) => void }} [options]
 * @returns {Promise<number>} the exit status
 */
export async function main(
  argv,
  { context: provided, write = (text) => process.stdout.write(text) } = {},
) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      root: { type: "string" },
      answers: { type: "string" },
      plan: { type: "string" },
      "keep-data": { type: "boolean" },
      "no-docker": { type: "boolean" },
      revision: { type: "string" },
      outcome: { type: "string" },
      adopt: { type: "boolean" },
      source: { type: "string" },
    },
  });
  if (values.help) {
    write(USAGE + "\n");
    return 0;
  }
  const context = provided ?? createContext({ root: values.root });
  const line = (value) => write(JSON.stringify(value) + "\n");
  const pretty = (value) => write(JSON.stringify(value, null, 2) + "\n");
  const command = positionals[0];
  try {
    const run = COMMANDS[command];
    if (!run) {
      write(USAGE + "\n");
      return 2;
    }
    return await run({ context, values, write, line, pretty });
  } catch (error) {
    const failure = { error: { message: error.message, ...(error.fix ? { fix: error.fix } : {}) } };
    if (values.json || ["apply", "uninstall", "repair", "adopt"].includes(command)) line(failure);
    else write(`${error.message}${error.fix ? `\n${error.fix}` : ""}\n`);
    return error.usage ? 2 : 1;
  }
}

if (isMainModule(import.meta.url)) {
  // Stopping the installer stops its builds and Docker steps too, then exits.
  const codes = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };
  for (const [signal, code] of Object.entries(codes))
    process.on(signal, () => {
      stopRunning(signal);
      process.exit(code);
    });
  process.exitCode = await main(process.argv.slice(2));
}
