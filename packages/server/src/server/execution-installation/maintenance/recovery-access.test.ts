import { expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createRecoveryAccessStatusReader,
  type RecoveryAccessObservation,
} from "./recovery-access.js";

test("recovery discovery needs no reader or fabricated address", async () => {
  const read = createRecoveryAccessStatusReader({ installationId: randomUUID(), read: undefined });
  expect(await read()).toMatchObject({ status: "unverified", url: null });
});

test.each(["foreign", "stale", "future", "credentials", "path", "public", "insecure"])(
  "recovery discovery withholds %s proof",
  async (change) => {
    const installationId = randomUUID();
    const observation = {
      installationId,
      url: "https://machine.tail123.ts.net:8443",
      observedAt: new Date().toISOString(),
    };
    if (change === "foreign") observation.installationId = randomUUID();
    if (change === "stale") observation.observedAt = new Date(Date.now() - 31_000).toISOString();
    if (change === "future") observation.observedAt = new Date(Date.now() + 31_000).toISOString();
    if (change === "credentials")
      observation.url = "https://owner:secret@machine.tail123.ts.net:8443";
    if (change === "path") observation.url += "/?token=secret";
    if (change === "public") observation.url = "https://example.test";
    if (change === "insecure") observation.url = "http://machine.tail123.ts.net";
    const read = createRecoveryAccessStatusReader({
      installationId,
      read: async () => observation,
    });
    expect(await read()).toMatchObject({ status: "unverified", url: null });
  },
);

test("verified discovery exposes only the non-secret origin with an observation deadline", async () => {
  const installationId = randomUUID();
  const observedAt = new Date().toISOString();
  const read = createRecoveryAccessStatusReader({
    installationId,
    read: async () => ({ installationId, url: "https://machine.tail123.ts.net:8443", observedAt }),
  });
  expect(await read()).toMatchObject({
    status: "verified",
    url: "https://machine.tail123.ts.net:8443",
    validUntil: new Date(Date.parse(observedAt) + 30_000).toISOString(),
  });
});

test("concurrent recovery refresh shares one inspection and hides native errors", async () => {
  let calls = 0;
  const read = createRecoveryAccessStatusReader({
    installationId: randomUUID(),
    read: async () => {
      calls++;
      throw new Error("private path and credential details");
    },
  });
  const first = read();
  expect(read()).toBe(first);
  expect(await first).toMatchObject({ status: "unverified", url: null });
  expect(calls).toBe(1);
  expect(JSON.stringify(await first)).not.toContain("private path");
});

test("a timed-out native reader cannot multiply or publish a late bookmark", async () => {
  const installationId = randomUUID();
  let calls = 0;
  let signal: AbortSignal | undefined;
  let release: (observation: RecoveryAccessObservation) => void = () => {
    throw new Error("Reader not started");
  };
  const pending = new Promise<RecoveryAccessObservation>((resolve) => {
    release = resolve;
  });
  const read = createRecoveryAccessStatusReader({
    installationId,
    read: async (input) => {
      calls++;
      signal = input;
      return pending;
    },
  });
  const first = read();
  expect(await first).toMatchObject({ status: "unverified", url: null });
  expect(signal?.aborted).toBe(true);
  expect(read()).toBe(first);
  release({
    installationId,
    url: "https://machine.tail123.ts.net:8443",
    observedAt: new Date().toISOString(),
  });
  expect(await first).toMatchObject({ status: "unverified", url: null });
  expect(calls).toBe(1);
}, 15_000);
