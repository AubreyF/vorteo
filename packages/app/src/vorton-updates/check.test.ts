import { afterEach, describe, expect, it, vi } from "vitest";
import { buildUpdatePrompt, checkVortonUpdate } from "./check";

const current = "a".repeat(40);
const latest = "b".repeat(40);
const release = "release-942";
const signal = () => new AbortController().signal;
const latestRelease = () => Response.json({ tag_name: release });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function githubResponses(...responses: Response[]) {
  const fetch = vi.fn();
  for (const response of responses) fetch.mockResolvedValueOnce(response);
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

function stalledResponse(_url: string, options: RequestInit) {
  return Promise.resolve({
    status: 200,
    ok: true,
    json: () =>
      new Promise((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(new Error("Request aborted")), {
          once: true,
        });
      }),
  });
}

describe("Vorton release update check", () => {
  it("does not offer an update when the build is the latest release", async () => {
    const fetch = githubResponses(latestRelease(), Response.json({ sha: current }));
    expect(await checkVortonUpdate(current, signal())).toEqual({
      status: "current",
      latestCommit: current,
      incomingCommits: 0,
      latestRelease: release,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0][0]).toMatch(/\/releases\/latest$/);
    // The release tag, not main, names the commit to compare against.
    expect(fetch.mock.calls[1][0]).toMatch(/\/commits\/release-942$/);
  });

  it.each([
    ["ahead", 4, "available"],
    ["behind", 0, "ahead"],
    ["diverged", 2, "diverged"],
    ["identical", 0, "current"],
  ] as const)("handles GitHub's %s relationship", async (status, count, expected) => {
    const fetch = githubResponses(
      latestRelease(),
      Response.json({ sha: latest }),
      Response.json({ status, ahead_by: count }),
    );
    expect(await checkVortonUpdate(current, signal())).toEqual({
      status: expected,
      latestCommit: latest,
      incomingCommits: count,
      latestRelease: release,
    });
    // Pin the comparison to the observed commit even if the tag moves during the check.
    expect(fetch.mock.calls[2][0]).toContain(`/compare/${current}...${latest}?per_page=1`);
  });

  it("reports a local unpublished commit as unknown, not an available update", async () => {
    githubResponses(
      latestRelease(),
      Response.json({ sha: latest }),
      new Response(null, { status: 404 }),
    );
    expect(await checkVortonUpdate(current, signal())).toEqual({
      status: "unpublished",
      latestCommit: latest,
      incomingCommits: 0,
      latestRelease: release,
    });
  });

  it("follows main until the first stable release exists", async () => {
    const fetch = githubResponses(
      new Response(null, { status: 404 }),
      Response.json({ sha: current }),
    );
    expect(await checkVortonUpdate(current, signal())).toEqual({
      status: "current",
      latestCommit: current,
      incomingCommits: 0,
      latestRelease: undefined,
    });
    expect(String(fetch.mock.calls[1][0])).toMatch(/\/commits\/main$/);
  });

  it("rejects release tags that are not versions", async () => {
    const fetch = githubResponses(Response.json({ tag_name: "main" }));
    await expect(checkVortonUpdate(current, signal())).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("reports rate limiting without claiming the app is current", async () => {
    githubResponses(new Response(null, { status: 403 }));
    await expect(checkVortonUpdate(current, signal())).rejects.toThrow(
      "GitHub limited update checks",
    );
  });

  it("reports a missing release commit as a failure", async () => {
    githubResponses(latestRelease(), new Response(null, { status: 404 }));
    await expect(checkVortonUpdate(current, signal())).rejects.toThrow("failed (404)");
  });

  it("rejects malformed commit responses", async () => {
    githubResponses(latestRelease(), Response.json({ sha: "main; arbitrary command" }));
    await expect(checkVortonUpdate(current, signal())).rejects.toThrow();
  });

  it("propagates network failure so the user can retry", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network unavailable")));
    await expect(checkVortonUpdate(current, signal())).rejects.toThrow("Network unavailable");
  });

  it("does not send an invalid build identity to GitHub", async () => {
    const fetch = githubResponses();
    await expect(checkVortonUpdate("main", signal())).rejects.toThrow("no source commit");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("times out a stalled response body instead of leaving the check pending", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn().mockImplementation(stalledResponse));
    const result = expect(checkVortonUpdate(current, signal())).rejects.toThrow("Request aborted");
    await vi.advanceTimersByTimeAsync(15_000);
    await result;
  });

  it("prepares an update task with checkout verification and restart approval", () => {
    const prompt = buildUpdatePrompt(current, latest, release);
    expect(prompt).toContain(current);
    expect(prompt).toContain(latest);
    expect(prompt).toContain(release);
    expect(prompt).toContain("verify its remote and the serving installation");
    expect(prompt).toContain("Preserve all local work");
    expect(prompt).toContain("Ask for explicit approval before stopping or restarting");
    expect(prompt).toContain("A successful Git merge alone does not update the running app");
  });
});
