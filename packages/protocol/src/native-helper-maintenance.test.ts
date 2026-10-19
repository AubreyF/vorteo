import { expect, test } from "vitest";
import { NativeHelperDecisionSchema, NativeHelperPlanSchema } from "./native-helper-maintenance.js";
import { RestartRequestSchema } from "./execution-installation.js";

const digest = "a".repeat(64);
const file = { path: "/private/fixture/tool", sha256: digest };
const release = {
  sourceCommit: "b".repeat(40),
  directory: "/private/fixture/candidate.app",
  artifactSha256: digest,
  signingMode: "developer-id",
  helperRequirement: "identifier com.vorteo.macos-helper and anchor apple generic",
  clientRequirement: "identifier com.vorteo.macos-helper.client and anchor apple generic",
};
const plan = {
  version: 1,
  operation: "native-helper-install",
  installationId: "00000000-0000-4000-8000-000000000001",
  candidate: release,
  previous: null,
  retainedRollback: null,
  tooling: {
    sourceCommit: "b".repeat(40),
    directory: "/private/fixture/tooling",
    artifactSha256: digest,
    node: file,
    installer: file,
    dispatcher: file,
    invocationClient: file,
  },
  destination: { application: "/private/fixture/Helper.app", runtime: "/private/fixture/runtime" },
  expectedState: {
    configurationSha256: null,
    policySha256: null,
    installationReceiptSha256: null,
  },
};

test("helper plans distinguish initial installation from a preserved signed replacement", () => {
  expect(NativeHelperPlanSchema.parse(plan).previous).toBeNull();
  expect(NativeHelperPlanSchema.parse({ ...plan, previous: release }).previous).toEqual(release);
});

test("helper plans require exact source, artifact and installer identity", () => {
  for (const candidate of [
    { ...release, sourceCommit: "main" },
    { ...release, artifactSha256: "latest" },
    { ...release, signingMode: "preview" },
    { ...release, clientRequirement: "" },
  ]) {
    expect(NativeHelperPlanSchema.safeParse({ ...plan, candidate }).success).toBe(false);
  }
  expect(NativeHelperPlanSchema.safeParse({ ...plan, tooling: {} }).success).toBe(false);
});

test("helper plans reject credential payloads and unsigned policy changes", () => {
  expect(NativeHelperPlanSchema.safeParse({ ...plan, token: "secret" }).success).toBe(false);
  expect(
    NativeHelperPlanSchema.safeParse({
      ...plan,
      expectedState: { ...plan.expectedState, browserPolicy: { actions: ["click"] } },
    }).success,
  ).toBe(false);
});

test("helper decisions require a distinct operation and exact request revision and digest", () => {
  const decision = {
    operation: "native-helper-install",
    id: plan.installationId,
    revision: "00000000-0000-4000-8000-000000000002",
    planSha256: digest,
    decision: "approve",
  };
  expect(NativeHelperDecisionSchema.parse(decision)).toEqual(decision);
  for (const key of ["operation", "id", "revision", "planSha256"]) {
    const incomplete: Record<string, unknown> = { ...decision };
    delete incomplete[key];
    expect(NativeHelperDecisionSchema.safeParse(incomplete).success).toBe(false);
  }
  expect(NativeHelperDecisionSchema.safeParse({ ...decision, whenIdle: true }).success).toBe(false);
});

test("helper preparation cannot be submitted as an ordinary daemon restart", () => {
  expect(
    RestartRequestSchema.safeParse({ target: "native-helper", reason: "Install helper" }).success,
  ).toBe(false);
  expect(
    RestartRequestSchema.safeParse({ target: "host", reason: "Install helper", plan }).success,
  ).toBe(false);
});
