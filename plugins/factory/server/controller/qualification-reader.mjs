import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { githubRequest } from "./github-transport.mjs";
import { qualificationSnapshot } from "./qualification.mjs";

const execute = promisify(execFile);
const digest = (value) => createHash("sha256").update(value).digest("hex");
const check = (ok, message) => {
  if (!ok) throw new Error(message);
};
const sha = (value) => /^[a-f0-9]{40}$/.test(value ?? "");
const sourcePath = (value) =>
  typeof value === "string" &&
  value.length <= 1000 &&
  !value.startsWith("/") &&
  !value.includes("\\") &&
  !value.includes("\0") &&
  !value.includes("\r") &&
  !value.includes("\n") &&
  value.split("/").every((part) => part && part !== "." && part !== "..");

/** Capture the qualifier's evidence in the controller. Installation chooses the
 * inspected paths and standing scope; issue prose cannot grant either. Missing
 * source is explicit evidence, while symlinks/submodules refuse inspection.
 * The returned documents must be retained with the governed intake operation.
 */
export function createFactoryQualificationReader({
  authority,
  repositoryRoot,
  policy,
  sourcePaths = [],
  resolveSourcePaths,
  selectorPolicySha256,
  standingScope,
  authorizeScope,
  readyLabel = "factory:ready",
  request = githubRequest,
  executeGit = execute,
}) {
  const repository = policy.config.repository;
  check(
    /^[\w.-]+\/[\w.-]+$/.test(repository) &&
      policy.config.baseBranch === "dev" &&
      Array.isArray(sourcePaths) &&
      sourcePaths.length <= 64 &&
      sourcePaths.every(sourcePath) &&
      (resolveSourcePaths === undefined ||
        (typeof resolveSourcePaths === "function" &&
          /^[a-f0-9]{64}$/.test(selectorPolicySha256 ?? ""))) &&
      (standingScope === undefined ||
        (typeof standingScope === "string" &&
          standingScope.length > 0 &&
          standingScope.length <= 4000)) &&
      typeof authorizeScope === "function",
    "Qualification reader installation is incomplete",
  );
  const expandPaths = (selected) => {
    const paths = new Set(["AGENTS.md", "vorton.factory.json", ...selected]);
    check(selected.length <= 64, "Qualification selected source exceeds its bound");
    for (const name of selected) {
      const parts = name.split("/");
      for (let i = 1; i < parts.length; i++) paths.add(parts.slice(0, i).join("/") + "/AGENTS.md");
    }
    check(paths.size <= 128, "Qualification source inventory exceeds its bound");
    return [...paths].sort();
  };
  const staticPaths = expandPaths(sourcePaths);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  env.GIT_NO_REPLACE_OBJECTS = "1";
  const guard = () => authority.assertCurrent();
  const git = async (signal, ...args) => {
    guard();
    const result = await executeGit("git", ["-C", repositoryRoot, ...args], {
      env,
      encoding: "buffer",
      timeout: 30000,
      maxBuffer: 1024 * 1024,
      signal,
    });
    guard();
    return result.stdout;
  };
  const api = async (endpoint, signal) => {
    guard();
    if (signal?.aborted) throw new Error("Qualification capture stopped");
    const result = await request("GET", endpoint);
    guard();
    if (signal?.aborted) throw new Error("Qualification capture stopped");
    return result;
  };
  const list = async (endpoint, signal) => {
    const items = [];
    for (let page = 1; page <= 10; page++) {
      const next = await api(
        `${endpoint}${endpoint.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
        signal,
      );
      check(Array.isArray(next) && next.length <= 100, "Qualification evidence page is invalid");
      items.push(...next);
      if (next.length < 100) return items;
    }
    throw new Error("Qualification evidence exceeds its inspection bound");
  };
  const issueView = (issue) => ({
    number: issue.number,
    title: issue.title,
    body: issue.body ?? "",
    state: issue.state,
    assignees: issue.assignees.map((item) => item.id).sort((a, b) => a - b),
    labels: issue.labels
      .map((item) => item.name)
      .filter((name) => name !== readyLabel)
      .sort(),
  });
  const captureSelectedInspection = async ({ commit, issue, signal, active }) => {
    // The installed selector sees a bounded immutable tree, never filesystem
    // paths from the worker. Its suggestions grant no execution authority.
    const tree = new TextDecoder("utf-8", { fatal: true }).decode(
      await git(signal, "ls-tree", "-r", "-z", commit),
    );
    check(tree.endsWith("\0"), "Qualification tree inventory is malformed");
    const entries = tree.slice(0, -1).split("\0");
    check(entries.length <= 10000, "Qualification tree inventory exceeds its bound");
    const inventory = [];
    for (const entry of entries) {
      const match = /^(100644|100755|120000|160000) (blob|commit) ([a-f0-9]{40})\t(.+)$/.exec(
        entry,
      );
      check(match && sourcePath(match[4]), "Qualification tree inventory is malformed");
      if (match[1] === "100644" || match[1] === "100755") {
        check(match[2] === "blob", "Qualification tree inventory is malformed");
        inventory.push({ path: match[4], blob: match[3], mode: match[1] });
      }
    }
    const selected = await resolveSourcePaths({
      repository,
      commit,
      issue: structuredClone(issue),
      inventory,
      signal,
    });
    active();
    check(
      Array.isArray(selected) &&
        selected.length <= 64 &&
        selected.every(
          (item) =>
            item &&
            Object.keys(item).sort().join(",") === "path,reason" &&
            sourcePath(item.path) &&
            typeof item.reason === "string" &&
            item.reason.length > 0 &&
            item.reason.length <= 300,
        ) &&
        new Set(selected.map((item) => item.path)).size === selected.length,
      "Qualification source selection is invalid",
    );
    const resolved = [...new Set([...sourcePaths, ...selected.map((item) => item.path)])].sort();
    const inspectedPaths = expandPaths(resolved);
    const selection = {
      policySha256: selectorPolicySha256,
      selected: structuredClone(selected).sort((a, b) => a.path.localeCompare(b.path)),
      coverage: "Selected evidence only; uncaptured files cannot establish readiness.",
    };
    return { inspectedPaths, selection };
  };
  const captureRelatedPulls = async ({ base, number, signal, active }) => {
    const timeline = await list(`${base}/issues/${number}/timeline`, signal);
    const related = new Set();
    for (const event of timeline) {
      if (event.event !== "cross-referenced" || !event.source?.issue?.pull_request) continue;
      const item = event.source.issue;
      // Cross-repository work needs explicit qualification instead of silently
      // dropping a competing implementation from this repository's packet.
      check(
        item.repository_url === `https://api.github.com/repos/${repository}` &&
          Number.isSafeInteger(item.number) &&
          item.number > 0,
        "Qualification has an external or unidentified related pull request",
      );
      related.add(item.number);
    }
    check(related.size <= 100, "Qualification related pull requests exceed their bound");
    const relatedPulls = [];
    for (const pullNumber of [...related].sort((a, b) => a - b)) {
      active();
      const pull = await api(`${base}/pulls/${pullNumber}`, signal);
      check(
        pull.number === pullNumber &&
          pull.base?.repo?.full_name === repository &&
          sha(pull.head?.sha),
        "Qualification pull identity differs",
      );
      relatedPulls.push({
        number: pullNumber,
        state: pull.state,
        head: pull.head.sha,
      });
    }
    return relatedPulls;
  };
  const capture = async (number, signal) => {
    const active = () => {
      guard();
      if (signal?.aborted) throw new Error("Qualification capture stopped");
    };
    active();
    check(Number.isSafeInteger(number) && number > 0, "Invalid qualification issue number");
    const base = `repos/${repository}`;
    const issue = await api(`${base}/issues/${number}`, signal);
    active();
    check(
      issue.number === number &&
        !issue.pull_request &&
        Array.isArray(issue.labels) &&
        issue.labels.every((item) => typeof item.name === "string"),
      "Qualification issue identity differs",
    );
    const origin = (await git(signal, "remote", "get-url", "origin")).toString("utf8").trim();
    check(
      [
        `https://github.com/${repository}.git`,
        `https://github.com/${repository}`,
        `git@github.com:${repository}.git`,
      ].includes(origin),
      "Qualification repository origin differs",
    );
    const remote = await api(`${base}/git/ref/heads/dev`, signal);
    check(
      remote.object?.type === "commit" && sha(remote.object.sha),
      "Qualification dev identity is unavailable",
    );
    const commit = remote.object.sha;
    // Fetch only the configured lane. Source reads use the immutable API commit,
    // never the working directory or a moving remote-tracking ref.
    await git(signal, "fetch", "--no-tags", "origin", "refs/heads/dev");
    active();
    check(
      (await git(signal, "cat-file", "-t", commit)).toString("utf8").trim() === "commit",
      "Qualification source is not a commit",
    );
    let inspectedPaths = staticPaths;
    let selection = null;
    if (resolveSourcePaths) {
      ({ inspectedPaths, selection } = await captureSelectedInspection({
        commit,
        issue,
        signal,
        active,
      }));
      active();
    }
    const documents = [];
    let bytes = 0;
    const add = (id, content) => {
      const text = typeof content === "string" ? content : JSON.stringify(content);
      bytes += Buffer.byteLength(text);
      check(
        bytes <= 512 * 1024 && documents.length < 128,
        "Qualification packet exceeds its bound",
      );
      documents.push({ id, sha256: digest(text), text });
    };
    add("issue", issueView(issue));
    if (selection) add("source-selection", selection);
    const dependencies = (await list(`${base}/issues/${number}/dependencies/blocked_by`, signal))
      .map((item) => {
        const match = /^https:\/\/api\.github\.com\/repos\/([\w.-]+\/[\w.-]+)$/.exec(
          item.repository_url ?? "",
        );
        check(
          match && Number.isSafeInteger(item.number),
          "Qualification dependency identity is incomplete",
        );
        return { repository: match[1], number: item.number, state: item.state };
      })
      .sort((a, b) => a.repository.localeCompare(b.repository) || a.number - b.number);
    add("dependencies", dependencies);
    const relatedPulls = await captureRelatedPulls({ base, number, signal, active });
    active();
    add("related-pulls", relatedPulls);
    const sourceInputs = [];
    for (const name of inspectedPaths) {
      active();
      const entry = (
        await git(signal, "--literal-pathspecs", "ls-tree", "-z", commit, "--", name)
      ).toString("utf8");
      if (!entry) {
        sourceInputs.push({ path: name, blob: null });
        add(`source:${name}`, { missing: true });
        continue;
      }
      const entryBody = entry.slice(0, -1);
      check(
        entry.endsWith("\0") && !entryBody.includes("\0"),
        "Qualification source must be a regular committed file",
      );
      const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/.exec(entryBody);
      check(match && match[3] === name, "Qualification source must be a regular committed file");
      const content = await git(signal, "cat-file", "blob", match[2]);
      check(content.length <= 64 * 1024, "Qualification source file exceeds its bound");
      add(`source:${name}`, new TextDecoder("utf-8", { fatal: true }).decode(content));
      sourceInputs.push({ path: name, blob: match[2] });
    }
    const configuration = documents.find((item) => item.id === "source:vorton.factory.json");
    check(configuration?.sha256 === policy.configSha256, "Qualification repository policy changed");
    const permitted = await authorizeScope({
      repository,
      issue: structuredClone(issue),
      sourceInputs: structuredClone(sourceInputs),
    });
    guard();
    // Scope is an installation decision, not text returned by the qualifier.
    check(typeof permitted === "boolean", "Qualification standing scope is unavailable");
    add("standing-scope", {
      policySha256: policy.configSha256,
      permitted,
      ...(standingScope === undefined ? {} : { limits: standingScope }),
    });
    const input = {
      repository,
      policySha256: policy.configSha256,
      issue,
      dependencies,
      relatedPulls,
      sourceInputs,
      permitted,
      evidence: documents.map(({ id, sha256 }) => ({ id, sha256 })),
    };
    const snapshot = qualificationSnapshot(input);
    const finalIssue = await api(`${base}/issues/${number}`, signal);
    check(
      JSON.stringify(issueView(finalIssue)) === JSON.stringify(issueView(issue)),
      "Qualification issue changed during capture",
    );
    const finalHead = await api(`${base}/git/ref/heads/dev`, signal);
    active();
    check(finalHead.object?.sha === commit, "Qualification dev changed during capture");
    return {
      input,
      snapshot,
      documents,
      sourceCommit: commit,
      inputSha256: digest(JSON.stringify(snapshot)),
    };
  };
  return {
    capture,
    async readInputs(snapshot) {
      check(
        snapshot.repository === repository &&
          snapshot.policySha256 === policy.configSha256 &&
          (resolveSourcePaths ||
            JSON.stringify(snapshot.sourceInputs.map((item) => item.path).sort()) ===
              JSON.stringify(staticPaths)),
        "Qualification inspection scope changed",
      );
      const fresh = (await capture(snapshot.issue.number)).input;
      if (resolveSourcePaths)
        check(
          JSON.stringify(snapshot.sourceInputs.map((item) => item.path).sort()) ===
            JSON.stringify(fresh.sourceInputs.map((item) => item.path).sort()) &&
            snapshot.evidence.find((item) => item.id === "source-selection")?.sha256 ===
              fresh.evidence.find((item) => item.id === "source-selection")?.sha256,
          "Qualification inspection scope or selector policy changed",
        );
      return fresh;
    },
  };
}
