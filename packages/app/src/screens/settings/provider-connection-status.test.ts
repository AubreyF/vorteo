import { describe, expect, it } from "vitest";
import { describeConnectionStatus } from "./provider-connection-status";

const host = { kind: "host", serverId: "host" } as const;
const dev = { kind: "container", serverId: "dev" } as const;

function state(environment: typeof host | typeof dev, kind: string, label = kind) {
  return { environment, kind, label } as Parameters<typeof describeConnectionStatus>[0][number];
}

describe("describeConnectionStatus", () => {
  it("collapses matching environments into one status", () => {
    expect(describeConnectionStatus([state(host, "ready"), state(dev, "ready")])).toBe(
      "Ready everywhere",
    );
    expect(describeConnectionStatus([state(host, "ready")])).toBe("Ready");
  });

  it("names only the environment that differs", () => {
    expect(
      describeConnectionStatus([state(host, "ready"), state(dev, "attention", "Needs sign-in")]),
    ).toBe("Ready in Host · Dev container: Needs sign-in");
  });

  it("reports opt-outs without calling the connection broken", () => {
    expect(describeConnectionStatus([state(host, "ready"), state(dev, "excluded", "Off")])).toBe(
      "Ready in Host · Off in Dev container",
    );
  });

  it("shows where a connection has not been set up", () => {
    expect(describeConnectionStatus([state(host, "ready"), state(dev, "none")])).toBe(
      "Ready in Host · Not set up in Dev container",
    );
    expect(describeConnectionStatus([state(host, "none")])).toBe("Not set up yet");
  });
});
