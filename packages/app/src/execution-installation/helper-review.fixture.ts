import type { NativeHelperJob } from "@getpaseo/protocol/native-helper-maintenance";
const id = "00000000-0000-4000-8000-000000000001";
const date = "2026-10-09T00:00:00.000Z";
const digest = "a".repeat(64);
const file = { path: "/private/fixture/tool", sha256: digest };
export const helperReviewFixture: NativeHelperJob = {
  id: "00000000-0000-4000-8000-000000000002",
  revision: id,
  target: "native-helper",
  operation: "native-helper-install",
  requestedBy: "host-agent",
  reason: "Install helper",
  createdAt: date,
  status: "pending",
  detail: "Review",
  stage: "prepared",
  planSha256: digest,
  plan: {
    version: 1,
    operation: "native-helper-install",
    installationId: id,
    candidate: {
      sourceCommit: "b".repeat(40),
      directory: "/private/fixture/candidate.app",
      artifactSha256: digest,
      signingMode: "local",
      helperRequirement: "helper",
      clientRequirement: "client",
    },
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
    destination: {
      application: "/private/fixture/Helper.app",
      runtime: "/private/fixture/runtime",
    },
    expectedState: {
      configurationSha256: null,
      policySha256: null,
      installationReceiptSha256: null,
    },
  },
};
