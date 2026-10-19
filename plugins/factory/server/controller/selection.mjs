import { isDeepStrictEqual } from "node:util";
import { readApprovedFactoryQueue } from "./github-queue.mjs";
import { githubRequest } from "./github-transport.mjs";

function captureSelection(input) {
  const { authority, claims, delivery, qualified } = input;
  const methods = {
    assertCurrent: authority.assertCurrent,
    current: claims.current,
    reconcile: claims.reconcile,
    claimSelected: claims.claimSelected,
    claimQualified: claims.claimQualified,
    writeProgress: delivery.writeProgress,
    readQueue: qualified?.readQueue,
    admit: qualified?.admit,
  };
  const required = [
    methods.assertCurrent,
    methods.current,
    methods.reconcile,
    methods.claimSelected,
    methods.claimQualified,
    methods.writeProgress,
  ];
  if (qualified) required.push(methods.readQueue, methods.admit);
  if (required.some((value) => typeof value !== "function"))
    throw new Error("Factory selection ports are unavailable");
  const policy = structuredClone(input.policy);
  const exclusions = [...input.excludedIssues];
  const ownerId = input.ownerId;
  const request = input.request ?? githubRequest;
  if (
    !Number.isSafeInteger(ownerId) ||
    ownerId < 1 ||
    exclusions.some((value) => !Number.isSafeInteger(value) || value < 1) ||
    typeof request !== "function"
  )
    throw new Error("Invalid Factory selection configuration");
  const references = () => [
    input.authority,
    input.claims,
    input.delivery,
    input.qualified,
    input.ownerId,
    input.request ?? githubRequest,
    authority.assertCurrent,
    claims.current,
    claims.reconcile,
    claims.claimSelected,
    claims.claimQualified,
    delivery.writeProgress,
    qualified?.readQueue,
    qualified?.admit,
  ];
  const capturedReferences = references();
  const assertCurrent = () => {
    methods.assertCurrent.call(authority);
    if (
      references().some((value, index) => value !== capturedReferences[index]) ||
      !isDeepStrictEqual(input.policy, policy) ||
      !isDeepStrictEqual(input.excludedIssues, exclusions)
    )
      throw new Error("Factory selection installation changed");
  };
  return {
    authority,
    claims,
    delivery,
    qualified,
    methods,
    policy,
    exclusions,
    ownerId,
    request,
    assertCurrent,
  };
}

function assertOccurrence(scheduleId, scheduledFor) {
  const parsed = typeof scheduledFor === "string" ? Date.parse(scheduledFor) : NaN;
  if (
    typeof scheduleId !== "string" ||
    !scheduleId ||
    scheduleId.length > 200 ||
    typeof scheduledFor !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(scheduledFor) ||
    !Number.isFinite(parsed)
  )
    throw new Error("Factory selection requires its scheduler occurrence");
  const canonical = new Date(parsed).toISOString();
  if (canonical !== scheduledFor && canonical.replace(".000Z", "Z") !== scheduledFor)
    throw new Error("Invalid Factory scheduler occurrence timestamp");
}

/** Native scheduler callback. Admission repeats qualification before retaining
 * the claim. Progress failure keeps that claim for reconciliation, never rollback.
 * Production supplies the real publisher and retained all-writer exclusive owner.
 */
export function createFactorySelection(input) {
  const c = captureSelection(input);
  const api = (endpoint) => c.request("GET", endpoint, undefined, true);
  const readIssue = (endpoint) => c.request("GET", endpoint);
  let pending = Promise.resolve();
  return (schedule, scheduledFor) => {
    const scheduleId = schedule?.id;
    const guard = () => {
      c.assertCurrent();
      assertOccurrence(scheduleId, scheduledFor);
      if (schedule.id !== scheduleId) throw new Error("Factory scheduler occurrence changed");
    };
    const select = async () => {
      guard();
      await c.methods.reconcile.call(c.claims);
      guard();
      if (c.methods.current.call(c.claims).active)
        throw new Error("Factory selection has an unfinished claim");
      const observed = c.qualified
        ? await c.methods.readQueue.call(c.qualified)
        : await readApprovedFactoryQueue({
            policy: c.policy,
            ownerId: c.ownerId,
            excludedIssues: c.exclusions,
            api,
          });
      guard();
      const queue = structuredClone(observed);
      if (!Array.isArray(queue.eligible) || queue.eligible.length > 1000)
        throw new Error("Factory selection queue coverage is invalid");
      if (!queue.eligible.length) return null;
      const selected = queue.eligible[0];
      if (
        c.qualified &&
        selected.qualification?.receipt?.snapshot?.issue?.number !== selected.issueNumber
      )
        throw new Error("Factory qualified selection identity differs");
      if (c.exclusions.includes(selected.issueNumber))
        throw new Error("Factory qualified selection includes an excluded issue");
      const verifyQualification = async (binding) => {
        guard();
        if (!isDeepStrictEqual(binding, selected.qualification))
          throw new Error("Factory selected qualification changed");
        const result = await c.methods.admit.call(c.qualified, structuredClone(binding));
        guard();
        return result;
      };
      const attempt = c.qualified
        ? await c.methods.claimQualified.call(c.claims, {
            qualification: selected.qualification,
            verifyQualification,
            scheduleId,
            occurrenceId: `${scheduleId}:${scheduledFor}`,
          })
        : await c.methods.claimSelected.call(c.claims, {
            policy: c.policy,
            ownerId: c.ownerId,
            selected,
            excludedIssues: c.exclusions,
            api,
            readIssue,
            scheduleId,
            occurrenceId: `${scheduleId}:${scheduledFor}`,
          });
      guard();
      await c.methods.writeProgress.call(c.delivery, structuredClone(attempt), {
        stage: "working",
        message: "Issue claimed; preparing isolated execution.",
      });
      guard();
      if (!isDeepStrictEqual(c.methods.current.call(c.claims).active, attempt))
        throw new Error("Factory selected claim changed during progress publication");
      return structuredClone(attempt);
    };
    const work = pending.catch(() => {}).then(select);
    pending = work;
    return work;
  };
}
