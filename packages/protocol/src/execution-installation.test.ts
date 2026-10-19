import { expect, test } from "vitest";
import {
  RestartRequestSchema,
  SourceContributionSchema,
  validateExecutionInstallation,
} from "./execution-installation.js";

const installation = {
  version: 1,
  installationId: "3386c661-7e90-4e01-abf7-e7ca3b9fca00",
  origin: "https://installation.example.test",
  environments: [
    {
      kind: "container",
      serverId: "container-id",
      endpoint: "container.example.test",
      useTls: true,
    },
    { kind: "host", serverId: "host-id", endpoint: "host.example.test", useTls: true },
  ],
};

test("installation descriptors require distinct encrypted destinations and never contain passwords", () => {
  expect(validateExecutionInstallation(installation).environments).toHaveLength(2);
  expect(() =>
    validateExecutionInstallation({
      ...installation,
      environments: [installation.environments[0], installation.environments[0]],
    }),
  ).toThrow("distinct");
  expect(() =>
    validateExecutionInstallation({
      ...installation,
      environments: [
        { ...installation.environments[0], password: "secret" },
        installation.environments[1],
      ],
    }),
  ).toThrow();
  expect(() =>
    validateExecutionInstallation({
      ...installation,
      environments: [
        { ...installation.environments[0], endpoint: "container.example.test/path" },
        installation.environments[1],
      ],
    }),
  ).toThrow("endpoint");
  expect(() =>
    validateExecutionInstallation({
      ...installation,
      environments: [
        { ...installation.environments[0], useTls: false },
        installation.environments[1],
      ],
    }),
  ).toThrow("TLS");
});

test("owner approval requirements are optional durable request and contribution metadata", () => {
  const request = { target: "host", reason: "Review explicitly" };
  expect(RestartRequestSchema.parse(request)).not.toHaveProperty("requireOwnerApproval");
  expect(RestartRequestSchema.parse({ ...request, requireOwnerApproval: true })).toMatchObject({
    requireOwnerApproval: true,
  });
  expect(() => RestartRequestSchema.parse({ ...request, requireOwnerApproval: "true" })).toThrow();
  const contribution = {
    id: "3386c661-7e90-4e01-abf7-e7ca3b9fca00",
    update: {
      sourceCommit: "a".repeat(40),
      baseCommit: "b".repeat(40),
      sha256: "c".repeat(64),
      bytes: 1,
    },
    reason: "Review source",
    requestedBy: "host-agent",
    createdAt: new Date(0).toISOString(),
    status: "queued",
    detail: "Awaiting integration",
    requireOwnerApproval: true,
  };
  expect(SourceContributionSchema.parse(contribution)).toMatchObject({
    requestedBy: "host-agent",
    requireOwnerApproval: true,
  });
});
