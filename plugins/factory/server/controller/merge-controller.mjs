import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { githubRequest } from "./github-transport.mjs";

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const sha = (value) => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const check = (ok, message) => {
  if (!ok) throw new Error(message);
};
// Terminal CI outcomes are not pending work. Preserve the exact check identity
// for repair admission; cancellations and approval gates require reconciliation.
const checkFailure = (item, required) => ({
  kind: ["failure", "timed_out"].includes(item.conclusion) ? "repair_required" : "held",
  reason: `${required ? "required" : "selected"}_check:${item.name}:${item.conclusion}`,
  evidence: {
    head: item.head_sha,
    checkId: item.id,
    name: item.name,
    appId: item.app?.id ?? null,
    conclusion: item.conclusion,
  },
});
const pullIdentity = (pull) => ({
  number: pull.number,
  head: pull.head.sha,
  branch: pull.head.ref,
  repository: pull.head.repo.full_name,
  base: pull.base.ref,
  title: pull.title,
  body: pull.body,
});

function isGitHubTimestamp(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    return false;
  return new Date(value).toISOString().slice(0, 19) === value.slice(0, 19);
}

function assertMergedTree({ merged, source, head, captured }) {
  check(
    merged.sha === captured.mergeCommit &&
      merged.parents?.length === 1 &&
      sha(merged.tree?.sha) &&
      source.sha === captured.head &&
      merged.tree.sha === source.tree?.sha &&
      head.object?.type === "commit" &&
      sha(head.object.sha),
    "Factory merged delivery tree or dev identity differs",
  );
}

function assertMergeCandidate(candidate) {
  check(
    candidate &&
      Number.isSafeInteger(candidate.number) &&
      candidate.number > 0 &&
      sha(candidate.commit) &&
      typeof candidate.branch === "string" &&
      candidate.branch.length > 0 &&
      /^[a-f0-9-]{36}$/.test(candidate.operationId) &&
      /^[a-f0-9-]{36}$/.test(candidate.publicationOperationId),
    "Invalid Factory merge candidate",
  );
}

function assertVerifiedSquash({ commit, source, saved, candidate, value }) {
  check(
    commit.sha === value.merge_commit_sha &&
      commit.parents?.length === 1 &&
      saved?.intent &&
      commit.parents[0].sha === saved.intent.baseCommit &&
      source.sha === candidate.commit &&
      sha(commit.tree?.sha) &&
      commit.tree.sha === source.tree?.sha &&
      commit.message?.startsWith(saved.intent.pull.title + "\n\n" + saved.intent.pull.body),
    "Factory merge is not the expected squash integration",
  );
}

function reviewedPublicationText(value, candidate) {
  return (
    typeof value.title === "string" &&
    /^(?:feat|fix|chore|docs|refactor|perf|style)(?:\([^\n]+\))?!?: .+/.test(value.title) &&
    !/codex|claude|chatgpt|copilot/i.test(value.title) &&
    value.body?.startsWith("(AI Generated).\n\n") &&
    value.body.includes(
      `<!-- vorton-factory:publication:v1:${candidate.publicationOperationId} -->`,
    )
  );
}

function assertRequiredProtection(statusRules, prRules) {
  check(
    statusRules.length > 0 &&
      statusRules.every((rule) => rule.parameters?.strict_required_status_checks_policy === true) &&
      prRules.length > 0 &&
      prRules.every((rule) => rule.parameters?.allowed_merge_methods?.includes("squash")),
    "Factory merge requires strict protected PR integration",
  );
}

async function readBranchRulesets(api, base, rules) {
  const rulesets = new Map();
  for (const id of new Set(rules.map((rule) => rule.ruleset_id))) {
    check(Number.isSafeInteger(id) && id > 0, "Factory ruleset identity is incomplete");
    const source = await api("GET", `${base}/rulesets/${id}`);
    check(
      source.enforcement === "active" &&
        Array.isArray(source.bypass_actors) &&
        source.bypass_actors.length === 0,
      "Factory merge cannot use a bypassable ruleset",
    );
    rulesets.set(id, hash(source));
  }
  return rulesets;
}

function requiredStatusChecks(statusRules, required) {
  const expectedChecks = [...required];
  for (const rule of statusRules) {
    check(
      Array.isArray(rule.parameters.required_status_checks),
      "Factory required checks are incomplete",
    );
    for (const item of rule.parameters.required_status_checks) {
      check(
        typeof item.context === "string" &&
          Number.isSafeInteger(item.integration_id) &&
          item.integration_id > 0,
        "Factory required check lacks an authenticated application",
      );
      expectedChecks.push({ name: item.context, appId: item.integration_id });
    }
  }
  return expectedChecks;
}

async function readLatestChecks({ api, base, candidate }) {
  const checks = [];
  let total;
  for (let page = 1; ; page++) {
    check(page <= 20, "Factory check listing exceeds its inspection bound");
    const response = await api(
      "GET",
      `${base}/commits/${candidate.commit}/check-runs?filter=latest&per_page=100&page=${page}`,
    );
    check(
      Number.isSafeInteger(response.total_count) &&
        response.total_count >= 0 &&
        Array.isArray(response.check_runs) &&
        (total === undefined || total === response.total_count),
      "Factory check listing changed or is incomplete",
    );
    total = response.total_count;
    checks.push(...response.check_runs);
    if (checks.length >= total) break;
    check(response.check_runs.length === 100, "Factory check page is incomplete");
  }
  check(
    checks.length === total &&
      new Set(checks.map((item) => item.id)).size === total &&
      checks.every(
        (item) =>
          Number.isSafeInteger(item.id) && item.id > 0 && item.head_sha === candidate.commit,
      ),
    "Factory check identities are incomplete",
  );
  return checks;
}

function requiredCheckOutcome(expectedChecks, checks) {
  for (const requiredCheck of expectedChecks) {
    const matches = checks.filter(
      (item) => item.name === requiredCheck.name && item.app?.id === requiredCheck.appId,
    );
    if (matches.length > 1)
      return {
        kind: "held",
        reason: `ambiguous_required_check:${requiredCheck.name}`,
      };
    if (
      matches.length === 1 &&
      matches[0].status === "completed" &&
      matches[0].conclusion !== "success"
    )
      return checkFailure(matches[0], true);
    if (matches.length === 0 || matches[0].status !== "completed")
      return {
        kind: "waiting",
        reason: `required_check:${requiredCheck.name}`,
      };
  }
  return null;
}

function selectedCheckOutcome(checks) {
  const failed = checks.find(
    (item) =>
      item.status === "completed" && !["success", "skipped", "neutral"].includes(item.conclusion),
  );
  if (failed) return checkFailure(failed, false);
  if (checks.some((item) => item.status !== "completed"))
    return {
      kind: "waiting",
      reason: "selected_checks_pending",
    };
  return null;
}

function assertMatchingIntent(saved, expected) {
  if (saved)
    check(
      isDeepStrictEqual(saved.candidate, expected),
      "Another Factory merge intent requires reconciliation",
    );
}

function assertDevHead(head) {
  check(head.object?.type === "commit" && sha(head.object.sha), "Factory dev head is unavailable");
}

function mergeRequirementsPending(latest) {
  return latest.draft || latest.mergeable !== true || latest.mergeable_state !== "clean";
}

export function assertFactoryMergeReceipt(value) {
  check(
    value &&
      isDeepStrictEqual(Object.keys(value).sort(), [
        "head",
        "mergeCommit",
        "mergedAt",
        "number",
        "repository",
        "url",
      ]) &&
      typeof value.repository === "string" &&
      /^[\w.-]+\/[\w.-]+$/.test(value.repository) &&
      Number.isSafeInteger(value.number) &&
      value.number > 0 &&
      sha(value.head) &&
      sha(value.mergeCommit) &&
      isGitHubTimestamp(value.mergedAt) &&
      value.url === `https://github.com/${value.repository}/pull/${value.number}`,
    "Invalid Factory merge receipt",
  );
}

export async function verifyFactoryMergedReceipt({
  receipt,
  assertCurrent,
  request = githubRequest,
}) {
  const captured = structuredClone(receipt);
  assertFactoryMergeReceipt(captured);
  const base = `repos/${captured.repository}`;
  const get = async (endpoint) => {
    assertCurrent();
    const value = await request("GET", endpoint);
    assertCurrent();
    return value;
  };
  const pull = await get(`${base}/pulls/${captured.number}`);
  check(
    pull.merged === true &&
      pull.state === "closed" &&
      pull.head?.sha === captured.head &&
      pull.base?.ref === "dev" &&
      pull.base.repo?.full_name === captured.repository &&
      pull.merge_commit_sha === captured.mergeCommit &&
      pull.merged_at === captured.mergedAt,
    "Factory merged delivery differs from its receipt",
  );
  const [merged, source, head] = await Promise.all([
    get(`${base}/git/commits/${captured.mergeCommit}`),
    get(`${base}/git/commits/${captured.head}`),
    get(`${base}/git/ref/heads/dev`),
  ]);
  assertMergedTree({ merged, source, head, captured });
  const comparison = await get(`${base}/compare/${captured.mergeCommit}...${head.object.sha}`);
  check(
    ["ahead", "identical"].includes(comparison.status) &&
      comparison.merge_base_commit?.sha === captured.mergeCommit,
    "Factory merged delivery is absent from dev",
  );
  check(isDeepStrictEqual(receipt, captured), "Factory merge receipt changed during verification");
  return true;
}

/** Reuse the active workflow's durable operation record instead of creating a
 * second owner or merge queue. Every write compares the complete current claim.
 */
export function createClaimMergeJournal({ claims, attemptId, operationId }) {
  const current = () => {
    const state = claims.current();
    check(
      state.active?.attemptId === attemptId &&
        state.active.workflow?.phase === "release" &&
        state.active.workflow.operation?.kind === "merge" &&
        state.active.workflow.operation.id === operationId,
      "Factory merge journal operation changed",
    );
    return state;
  };
  return {
    async read() {
      return structuredClone(current().active.workflow.operation.mergeState ?? null);
    },
    async write(value) {
      const before = current();
      const previous = before.active.workflow.operation.mergeState;
      if (previous)
        check(
          isDeepStrictEqual(previous.candidate, value.candidate) &&
            isDeepStrictEqual(previous.intent, value.intent),
          "Factory merge intent cannot be replaced",
        );
      if (value.receipt) assertFactoryMergeReceipt(value.receipt);
      check(
        Buffer.byteLength(JSON.stringify(value)) <= 64000,
        "Factory merge journal exceeds its bound",
      );
      claims.replace(before, {
        ...before.active,
        workflow: {
          ...before.active.workflow,
          operation: {
            ...before.active.workflow.operation,
            mergeState: structuredClone(value),
          },
        },
      });
    },
  };
}

/** Deterministic controller step. The workflow retains intent before PUT, and a
 * lost response can only reconcile the same PR/head. Promotion is delegated to
 * the repository's trusted publication path, including its provider audit.
 * No worker, schedule field or model result supplies these callbacks/policies.
 */
export function createFactoryMergeController({
  authority,
  repository,
  ownerId,
  requiredChecks,
  authorize,
  verifyCandidate,
  promote,
  journal,
  signal,
  request = githubRequest,
}) {
  check(
    /^[\w.-]+\/[\w.-]+$/.test(repository) &&
      Number.isSafeInteger(ownerId) &&
      ownerId > 0 &&
      Array.isArray(requiredChecks) &&
      requiredChecks.length > 0 &&
      requiredChecks.length <= 100 &&
      requiredChecks.every(
        (item) =>
          typeof item.name === "string" &&
          item.name.length > 0 &&
          Number.isSafeInteger(item.appId) &&
          item.appId > 0,
      ) &&
      typeof authorize === "function" &&
      typeof verifyCandidate === "function" &&
      typeof promote === "function" &&
      typeof journal?.read === "function" &&
      typeof journal?.write === "function",
    "Factory merge installation is incomplete",
  );
  const required = structuredClone(requiredChecks);
  const base = `repos/${repository}`;
  let flight = Promise.resolve();
  const inspect = async (candidate) => {
    assertMergeCandidate(candidate);
    const guard = async () => {
      authority.assertCurrent();
      check(!signal?.aborted, "Factory merge stopped; reconcile retained intent");
      check(
        (await authorize(structuredClone(candidate))) === true,
        "Factory merge authority is unavailable",
      );
      authority.assertCurrent();
      check(!signal?.aborted, "Factory merge stopped; reconcile retained intent");
    };
    const api = async (method, path, body) => {
      await guard();
      const value = await request(method, path, body);
      await guard();
      return value;
    };
    await guard();
    const expected = { repository, ...candidate };
    let saved = await journal.read();
    assertMatchingIntent(saved, expected);
    check(
      (await verifyCandidate(structuredClone(candidate))) === true,
      "Factory merge lacks exact independent review and publication evidence",
    );
    await guard();
    const pullPath = `${base}/pulls/${candidate.number}`;
    let pull = await api("GET", pullPath);
    const assertPull = (value) =>
      check(
        value.number === candidate.number &&
          value.user?.id === ownerId &&
          value.head?.sha === candidate.commit &&
          value.head?.ref === candidate.branch &&
          value.head?.repo?.full_name === repository &&
          value.base?.repo?.full_name === repository &&
          value.base?.ref === "dev" &&
          reviewedPublicationText(value, candidate),
        "Factory PR differs from reviewed publication",
      );
    assertPull(pull);
    const merged = async (value) => {
      assertPull(value);
      check(
        value.merged === true &&
          value.state === "closed" &&
          sha(value.merge_commit_sha) &&
          isGitHubTimestamp(value.merged_at),
        "Factory merge is unconfirmed",
      );
      const live = await api("GET", `${base}/git/ref/heads/dev`);
      check(
        live.object?.type === "commit" && sha(live.object.sha),
        "Factory dev identity is unavailable",
      );
      const comparison = await api(
        "GET",
        `${base}/compare/${value.merge_commit_sha}...${live.object.sha}`,
      );
      check(
        ["ahead", "identical"].includes(comparison.status) &&
          comparison.merge_base_commit?.sha === value.merge_commit_sha,
        "Factory merged commit is absent from dev",
      );
      const commit = await api("GET", `${base}/git/commits/${value.merge_commit_sha}`);
      const source = await api("GET", `${base}/git/commits/${candidate.commit}`);
      assertVerifiedSquash({ commit, source, saved, candidate, value });
      const receipt = {
        repository,
        number: value.number,
        head: candidate.commit,
        mergeCommit: value.merge_commit_sha,
        mergedAt: value.merged_at,
        url: `https://github.com/${repository}/pull/${value.number}`,
      };
      await guard();
      await journal.write({
        candidate: expected,
        intent: saved?.intent ?? null,
        receipt,
      });
      await guard();
      return { kind: "merged", receipt };
    };
    if (pull.merged === true)
      return saved?.intent
        ? merged(pull)
        : { kind: "held", reason: "merged_without_factory_intent" };
    check(pull.state === "open", "Factory PR closed without a verified merge");
    if (saved?.intent) return { kind: "held", reason: "merge_response_unconfirmed" };
    if (saved?.receipt) throw new Error("Factory merged receipt conflicts with the live PR");
    if (pull.draft) {
      await promote(structuredClone(candidate));
      await guard();
      pull = await api("GET", pullPath);
      assertPull(pull);
      check(
        pull.state === "open" && pull.draft === false,
        "Factory ready promotion is unconfirmed",
      );
    }
    const rules = await api("GET", `${base}/rules/branches/dev`);
    check(Array.isArray(rules), "Factory branch rules are unavailable");
    const statusRules = rules.filter((rule) => rule.type === "required_status_checks");
    const prRules = rules.filter((rule) => rule.type === "pull_request");
    assertRequiredProtection(statusRules, prRules);
    // Read each contributing ruleset, because the effective branch-rule endpoint
    // does not report bypass actors or enforcement mode.
    const rulesets = await readBranchRulesets(api, base, rules);
    const expectedChecks = requiredStatusChecks(statusRules, required);
    const checks = await readLatestChecks({ api, base, candidate });
    const requiredOutcome = requiredCheckOutcome(expectedChecks, checks);
    if (requiredOutcome) return requiredOutcome;
    const selectedOutcome = selectedCheckOutcome(checks);
    if (selectedOutcome) return selectedOutcome;
    const head = await api("GET", `${base}/git/ref/heads/dev`);
    assertDevHead(head);
    const comparison = await api("GET", `${base}/compare/${head.object.sha}...${candidate.commit}`);
    if (
      !["ahead", "identical"].includes(comparison.status) ||
      comparison.merge_base_commit?.sha !== head.object.sha
    )
      return {
        kind: "repair_required",
        reason: "reviewed_base_integration_required",
        evidence: { head: candidate.commit, base: head.object.sha },
      };
    const latest = await api("GET", pullPath);
    assertPull(latest);
    if (latest.merged) return { kind: "held", reason: "merged_without_factory_intent" };
    check(
      isDeepStrictEqual(pullIdentity(latest), pullIdentity(pull)),
      "Factory PR content changed during merge admission",
    );
    if (mergeRequirementsPending(latest))
      return { kind: "waiting", reason: "repository_merge_requirements" };
    check(
      hash(await api("GET", `${base}/rules/branches/dev`)) === hash(rules),
      "Factory branch rules changed during admission",
    );
    for (const [id, fingerprint] of rulesets)
      check(
        hash(await api("GET", `${base}/rulesets/${id}`)) === fingerprint,
        "Factory ruleset authority changed during admission",
      );
    const finalHead = await api("GET", `${base}/git/ref/heads/dev`);
    if (finalHead.object?.sha !== head.object.sha)
      return { kind: "waiting", reason: "dev_advanced" };
    check(
      (await verifyCandidate(structuredClone(candidate))) === true,
      "Factory merge evidence changed before request",
    );
    const intent = {
      baseCommit: head.object.sha,
      pull: pullIdentity(latest),
      checksSha256: hash(checks),
      rulesSha256: hash(rules),
    };
    await guard();
    saved = { candidate: expected, intent, receipt: null };
    await journal.write(saved);
    // SHA is a server-side head guard. Strict branch rules remain the final
    // authority for concurrent base movement, reviews and check changes.
    await api("PUT", `${pullPath}/merge`, {
      sha: candidate.commit,
      merge_method: "squash",
      commit_title: latest.title,
      commit_message: latest.body,
    });
    return merged(await api("GET", pullPath));
  };
  return (candidate) => {
    const captured = structuredClone(candidate);
    const operation = flight.catch(() => {}).then(() => inspect(captured));
    flight = operation;
    return operation;
  };
}
