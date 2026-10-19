import { spawn } from "node:child_process";
import { TextDecoder } from "node:util";

/** Older supported gh versions emit consecutive JSON arrays for --paginate.
 * Decode those arrays without --slurp, shell interpolation, or partial results.
 * Brackets inside JSON strings are data, including escaped quotes/backslashes.
 */
export function decodeGitHubResponse(bytes, paginate = false) {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (!paginate) return JSON.parse(text);
  return decodePaginatedGitHubResponse(text);
}

function decodePaginatedGitHubResponse(text) {
  const result = [];
  let start = -1;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  let pages = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (start === -1) {
      if (/\s/.test(char)) continue;
      if (char !== "[") throw new Error("Factory GitHub pagination requires arrays");
      start = index;
    }
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === "[" || char === "{") depth++;
    else if (char === "]" || char === "}") {
      depth--;
      if (depth === 0) {
        const page = JSON.parse(text.slice(start, index + 1));
        if (!Array.isArray(page)) throw new Error("Factory GitHub pagination requires arrays");
        for (const entry of page) result.push(entry);
        pages++;
        start = -1;
      }
    }
  }
  if (start !== -1 || !pages) throw new Error("Factory GitHub pagination is incomplete");
  return result;
}

/** Trusted controller transport. gh follows GitHub Link headers. The aggregate
 * response and entire subprocess are bounded, including paginated reads.
 * Failed writes are never retried here: callers reconcile their durable intent.
 */
export function githubRequest(method, endpoint, body, paginate = false) {
  return githubTransport(method, endpoint, body, paginate, false);
}

export function githubJobLog(repository, jobId) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !Number.isSafeInteger(jobId) || jobId < 1)
    throw new Error("Invalid Factory job log identity");
  return githubTransport(
    "GET",
    `repos/${repository}/actions/jobs/${jobId}/logs`,
    undefined,
    false,
    true,
  );
}

/** Authenticated artifact bytes, bounded before any archive decoding. */
export function githubArtifactArchive(repository, artifactId) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !Number.isSafeInteger(artifactId) || artifactId < 1)
    throw new Error("Invalid Factory artifact identity");
  return githubTransport(
    "GET",
    `repos/${repository}/actions/artifacts/${artifactId}/zip`,
    undefined,
    false,
    true,
    65536,
  );
}

function githubTransport(method, endpoint, body, paginate, raw, limit = 8 * 1024 * 1024) {
  if (paginate && (method !== "GET" || body !== undefined))
    throw new Error("Only GitHub reads may be paginated");
  return new Promise((resolve, reject) => {
    const args = ["api", "--method", method, endpoint];
    if (paginate) args.push("--paginate");
    if (body !== undefined) args.push("--input", "-");
    const child = spawn("gh", args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, GH_HOST: "github.com", GH_PROMPT_DISABLED: "1" },
      shell: false,
    });
    const chunks = [];
    let length = 0;
    let failure;
    const timer = setTimeout(() => {
      failure = new Error("Factory GitHub request timed out; reconcile before retry");
      child.kill("SIGKILL");
    }, 30000);
    child.stdout.on("data", (chunk) => {
      if (failure) return;
      length += chunk.length;
      if (length > limit) {
        failure = new Error("Factory GitHub response exceeds its bound");
        child.kill("SIGKILL");
      } else chunks.push(chunk);
    });
    child.stderr.resume();
    child.stdin.on("error", () => {});
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (failure || code !== 0) {
        reject(
          failure ?? new Error(`Factory GitHub request failed (${code}); reconcile before retry`),
        );
        return;
      }
      let response;
      try {
        const bytes = Buffer.concat(chunks, length);
        response = raw ? bytes : decodeGitHubResponse(bytes, paginate);
      } catch (error) {
        reject(error);
        return;
      }
      resolve(response);
    });
    child.stdin.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
