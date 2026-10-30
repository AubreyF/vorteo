import { describe, expect, it } from "vitest";
import type { CoordinatorBootstrapPlan } from "@getpaseo/protocol/coordinator-bootstrap";
import { describeConfigurationChanges } from "./configuration-change-descriptions";

describe("describeConfigurationChanges", () => {
  it("distinguishes the updater executable from a running supervisor replacement", () => {
    expect(
      describeConfigurationChanges({
        configurationChanges: [
          { setting: "containerSourceUpdateNode", value: "/durable/bin/node" },
        ],
      } as CoordinatorBootstrapPlan),
    ).toEqual([
      "Use /durable/bin/node for subsequent Dev source updates. This does not replace the running supervisor or restart Dev.",
    ]);
  });
  it("describes a listed change exactly like its legacy field", () => {
    const launcher = { candidate: "/fixture/candidate.plist", sha256: "c".repeat(64) };
    const legacy = describeConfigurationChanges({
      hostLauncherUpdateConfiguration: launcher,
    } as CoordinatorBootstrapPlan);
    const listed = describeConfigurationChanges({
      configurationChanges: [{ setting: "hostLauncherUpdate", value: launcher }],
    } as CoordinatorBootstrapPlan);
    expect(listed).toEqual(legacy);
    expect(listed[0]).toContain("Candidate launcher cccccccccccc");
  });

  it("describes removal and states why an invalid plan cannot be approved", () => {
    expect(
      describeConfigurationChanges({
        configurationChanges: [{ setting: "factoryGate", value: null }],
      } as CoordinatorBootstrapPlan),
    ).toEqual(["Stop running Factory's checks around Dev restarts."]);
    expect(
      describeConfigurationChanges({
        configurationChanges: [{ setting: "unknown", value: 1 }],
      } as CoordinatorBootstrapPlan),
    ).toEqual(["This plan cannot be approved: Unknown configuration setting: unknown."]);
  });
  it("describes telemetry enablement and removal without claiming retained logs are deleted", () => {
    expect(
      describeConfigurationChanges({
        configurationChanges: [{ setting: "operationalTelemetryEnabled", value: true }],
      } as CoordinatorBootstrapPlan),
    ).toEqual([
      "Turn on private minute-by-minute coordinator performance logging, up to 12 MiB. Records process CPU and memory, cached queue and connection health, and fixed operation status labels; no prompts or account content.",
    ]);
    expect(
      describeConfigurationChanges({
        configurationChanges: [{ setting: "operationalTelemetryEnabled", value: null }],
      } as CoordinatorBootstrapPlan),
    ).toEqual(["Turn off future coordinator performance samples. Keep retained private logs."]);
  });
});
