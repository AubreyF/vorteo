import { Command } from "commander";
import { withOutput } from "../../output/index.js";
import { addJsonAndDaemonHostOptions } from "../../utils/command-options.js";
import { runStatusCommand } from "./status.js";

export function createFactoryCommand(): Command {
  const factory = new Command("factory").description("Observe a project's Factory");
  addJsonAndDaemonHostOptions(
    factory
      .command("status")
      .description("Read bounded Factory status from the selected daemon")
      .argument("<project-id>", "Exact native project identity")
      .allowExcessArguments(false),
  ).action(withOutput(runStatusCommand));
  return factory;
}
