import { describe, expect, it } from "vitest";
import type { CoordinatorBootstrapPlan } from "@getpaseo/protocol/coordinator-bootstrap";
import { describeConfigurationChanges } from "./configuration-change-descriptions";

describe("describeConfigurationChanges", () => {
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
});
