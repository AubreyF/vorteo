import type { PluginServerContext } from "@getpaseo/plugin/server";
import { activityReceipts, factorySnapshot } from "./shared/contracts.js";
import { factorySetup } from "./shared/operations.js";
import { readSnapshot, readReceipts, readSetup } from "./server/observation.js";

export default function contribute(server: PluginServerContext) {
  server.handle(factorySnapshot, readSnapshot);
  server.handle(factorySetup, readSetup);
  server.handle(activityReceipts, readReceipts);
  return () => {};
}
