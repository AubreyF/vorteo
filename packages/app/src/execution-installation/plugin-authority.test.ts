import { expect, test } from "vitest";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { PluginRegistry } from "@/plugins/registry";

test("a denied daemon catalog cannot construct a client runtime or evaluate its bundle", () => {
  const client = new DaemonClient({
    url: "ws://127.0.0.1:1/ws",
    clientId: "installation-authority-test",
  });
  let constructions = 0;
  const registry = new PluginRegistry({
    version: "0.8.0",
    allowHost: (serverId) => serverId === "trusted-host",
    createRuntime: () => {
      constructions++;
      throw new Error("Unexpected client runtime construction");
    },
  });
  const installed = registry.installCatalog(
    "container",
    [
      {
        id: "untrusted",
        requirements: { paseo: ">=0.8.0" },
        clientBundle: "(() => { throw new Error('Untrusted bundle executed'); })",
      },
    ],
    {
      client,
      audio: {
        play: async () => {
          throw new Error("Untrusted audio must not play");
        },
      },
    },
  );
  expect(installed).toBe(false);
  expect(constructions).toBe(0);
  expect(registry.getSnapshot()).toEqual([]);
  expect(registry.getEvaluationError("container", "untrusted")).toBeUndefined();
});
