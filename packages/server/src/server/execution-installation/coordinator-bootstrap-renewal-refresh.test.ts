import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type {
  CoordinatorBootstrapPreparation,
  CoordinatorBootstrapRequest,
} from "@getpaseo/protocol/coordinator-bootstrap";
import { BootstrapRenewalContextChanged } from "./coordinator-bootstrap-errors.js";
import {
  refreshBootstrapReviewOnRenewalChange,
  renewalContextFingerprint,
} from "./coordinator-bootstrap-launch.js";
import type { BootstrapReviewService } from "./coordinator-bootstrap-session.js";

type HistoryRecord = Pick<CoordinatorBootstrapRequest, "id" | "status" | "execution">;

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function configurationFixture(): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "renewal-refresh-")));
  roots.push(root);
  const file = path.join(root, "coordinator.json");
  await writeFile(file, JSON.stringify({ selected: "release-a" }), { mode: 0o600 });
  return file;
}

function record(stage: NonNullable<HistoryRecord["execution"]>["stage"] | null): HistoryRecord {
  return {
    id: randomUUID(),
    status: stage ? "approved" : "pending",
    execution: stage
      ? { generation: randomUUID(), stage, updatedAt: new Date().toISOString() }
      : undefined,
  };
}

// Inputs and results are opaque to the refresh wrapper; it only routes them.
const preparation = {} as unknown as CoordinatorBootstrapPreparation;
const decision = {} as unknown as Parameters<BootstrapReviewService["decide"]>[0];
const requestB = { id: "request-b" } as unknown as CoordinatorBootstrapRequest;

/** A review derived once, the way the Host initializes it: its context is
 * stale once history or the selected configuration differs from derivation. */
function derivedReview(history: HistoryRecord[], configurationFile: string) {
  const derived = renewalContextFingerprint(history, configurationFile);
  const stale = () => renewalContextFingerprint(history, configurationFile) !== derived;
  const refuseStale = async () => {
    if (stale())
      throw new BootstrapRenewalContextChanged(
        "Host renewal context changed; prepare a fresh review",
      );
    return requestB;
  };
  return {
    list: vi.fn(() => []),
    prepare: vi.fn(refuseStale),
    decide: vi.fn(refuseStale),
    automatic: { reconcile: vi.fn(refuseStale) },
    renewalContextChanged: stale,
  } satisfies BootstrapReviewService;
}

test("after request A completes, request B is prepared and approved without a Host restart", async () => {
  const configuration = await configurationFixture();
  const requestA = record("started");
  const history = [requestA];
  const first = derivedReview(history, configuration);
  const initialize = vi.fn(async () => derivedReview(history, configuration));
  const review = refreshBootstrapReviewOnRenewalChange(first, initialize);
  await expect(review.prepare(preparation)).resolves.toBe(requestB);
  // Request A's executor completes; the selected coordinator changes with it.
  requestA.execution = { ...requestA.execution!, stage: "succeeded" };
  await writeFile(configuration, JSON.stringify({ selected: "release-b" }));
  await expect(review.prepare(preparation)).resolves.toBe(requestB);
  await expect(review.decide(decision, "owner password")).resolves.toBe(requestB);
  expect(initialize).toHaveBeenCalledTimes(1);
  expect(first.prepare).toHaveBeenCalledTimes(1);
  expect(first.decide).not.toHaveBeenCalled();
});

test("new pending or in-flight requests do not re-derive the context", async () => {
  const configuration = await configurationFixture();
  const history = [record("succeeded")];
  const before = renewalContextFingerprint(history, configuration);
  history.push(record(null), record("started"), record("recovery_required"));
  expect(renewalContextFingerprint(history, configuration)).toBe(before);
  history.push(record("rolled_back"));
  expect(renewalContextFingerprint(history, configuration)).not.toBe(before);
});

test("a context change during an operation is refused and the next operation re-derives", async () => {
  const configuration = await configurationFixture();
  const history = [record("succeeded")];
  const first = derivedReview(history, configuration);
  // The change lands after the operation began: no refresh beforehand.
  first.prepare.mockImplementationOnce(async () => {
    throw new BootstrapRenewalContextChanged(
      "Host renewal context changed; prepare a fresh review",
    );
  });
  const second = derivedReview(history, configuration);
  const initialize = vi.fn(async () => second);
  const review = refreshBootstrapReviewOnRenewalChange(first, initialize);
  await expect(review.prepare(preparation)).rejects.toThrow("Host renewal context changed");
  expect(initialize).not.toHaveBeenCalled();
  await expect(review.prepare(preparation)).resolves.toBe(requestB);
  expect(initialize).toHaveBeenCalledTimes(1);
  expect(second.prepare).toHaveBeenCalledTimes(1);
});

test("concurrent operations wait for one re-derivation", async () => {
  const configuration = await configurationFixture();
  const requestA = record("verifying");
  const history = [requestA];
  const derivation = Promise.withResolvers<BootstrapReviewService>();
  const initialize = vi.fn(() => derivation.promise);
  const review = refreshBootstrapReviewOnRenewalChange(
    derivedReview(history, configuration),
    initialize,
  );
  // Automatic maintenance is hidden while re-deriving; a caller already holding
  // it waits for the derivation like any other operation.
  const automatic = review.automatic!;
  requestA.execution = { ...requestA.execution!, stage: "succeeded" };
  const operations = Promise.all([
    review.prepare(preparation),
    review.decide(decision, "owner password"),
    automatic.reconcile("request-b"),
  ]);
  await vi.waitFor(() => expect(initialize).toHaveBeenCalledTimes(1));
  expect(review.available).toBe(false);
  expect(review.unavailableReason).toContain("Refreshing coordinator maintenance");
  expect(review.automatic).toBeUndefined();
  derivation.resolve(derivedReview(history, configuration));
  await expect(operations).resolves.toEqual([requestB, requestB, requestB]);
  expect(initialize).toHaveBeenCalledTimes(1);
  expect(review.available).toBeUndefined();
});

test("an unavailable re-derivation is reported and attempted again by the next operation", async () => {
  const configuration = await configurationFixture();
  const requestA = record("started");
  const history = [requestA];
  const unavailable = {
    unavailableReason:
      "Coordinator renewal is unavailable until its bootstrap recovery is terminal",
    list: () => [],
    prepare: async () => {
      throw new Error("Coordinator renewal is unavailable");
    },
    decide: async () => {
      throw new Error("Coordinator renewal is unavailable");
    },
  };
  const initialize = vi
    .fn<() => Promise<BootstrapReviewService>>()
    .mockResolvedValueOnce(unavailable)
    .mockImplementation(async () => derivedReview(history, configuration));
  const review = refreshBootstrapReviewOnRenewalChange(
    derivedReview(history, configuration),
    initialize,
  );
  requestA.execution = { ...requestA.execution!, stage: "succeeded" };
  await expect(review.prepare(preparation)).rejects.toThrow("Coordinator renewal is unavailable");
  expect(review.unavailableReason).toContain("until its bootstrap recovery is terminal");
  await expect(review.prepare(preparation)).resolves.toBe(requestB);
  expect(initialize).toHaveBeenCalledTimes(2);
});

test("a status read starts re-derivation and notifies availability listeners", async () => {
  const configuration = await configurationFixture();
  const requestA = record("started");
  const history = [requestA];
  const derivation = Promise.withResolvers<BootstrapReviewService>();
  const initialize = vi.fn(() => derivation.promise);
  const review = refreshBootstrapReviewOnRenewalChange(
    derivedReview(history, configuration),
    initialize,
  );
  const notify = vi.fn();
  review.subscribeAvailability!(notify);
  review.list();
  expect(initialize).not.toHaveBeenCalled();
  requestA.execution = { ...requestA.execution!, stage: "succeeded" };
  review.list();
  review.list();
  await vi.waitFor(() => expect(initialize).toHaveBeenCalledTimes(1));
  derivation.resolve(derivedReview(history, configuration));
  await vi.waitFor(() => expect(review.available).toBeUndefined());
  expect(notify).toHaveBeenCalledTimes(2);
});
