import { Command } from "commander";
import { withOutput } from "../../output/index.js";
import { addJsonAndDaemonHostOptions } from "../../utils/command-options.js";
import { runStatusCommand } from "./status.js";
import { runSetupCommand } from "./setup.js";
import { runInstallCommand } from "./install.js";

export function createFactoryCommand(): Command {
  const factory = new Command("factory").description("Observe and install a project's Factory");
  addJsonAndDaemonHostOptions(
    factory
      .command("status")
      .description("Read bounded Factory status from the selected daemon")
      .argument("<project-id>", "Exact native project identity")
      .allowExcessArguments(false),
  ).action(withOutput(runStatusCommand));
  addJsonAndDaemonHostOptions(
    factory
      .command("setup")
      .description("Read native Factory setup and installation preconditions")
      .argument("<project-id>", "Exact native project identity")
      .allowExcessArguments(false),
  ).action(withOutput(runSetupCommand));
  addJsonAndDaemonHostOptions(
    factory
      .command("install")
      .description("Install through the selected daemon's reconciled native adapter")
      .argument("<project-id>", "Exact native project identity")
      .requiredOption("--expected-server-id <id>", "Serving identity returned by setup")
      .requiredOption("--expected-revision <revision>", "Exact ready setup revision")
      .requiredOption("--operation-id <id>", "Stable identity for this installation attempt")
      .allowExcessArguments(false),
  ).action(withOutput(runInstallCommand));
  return factory;
}
