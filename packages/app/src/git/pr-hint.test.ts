import { describe, expect, it } from "vitest";

import { selectPrHintFromStatus } from "./pr-hint";

const githubStatus = {
  url: "https://github.com/acme/repo/pull/42",
  state: "open",
  isMerged: false,
};

const gitlabStatus = {
  url: "https://gitlab.com/group/proj/-/merge_requests/7",
  state: "open",
  isMerged: false,
};

describe("selectPrHintFromStatus", () => {
  it("defaults the forge to github when none is supplied (old daemon)", () => {
    const hint = selectPrHintFromStatus(githubStatus);
    expect(hint).toMatchObject({ number: 42, forge: "github" });
  });

  it("carries the resolved forge onto the hint", () => {
    const hint = selectPrHintFromStatus(githubStatus, "github");
    expect(hint?.forge).toBe("github");
  });

  it("parses a GitLab merge-request URL and carries the gitlab forge", () => {
    const hint = selectPrHintFromStatus(gitlabStatus, "gitlab");
    expect(hint).toMatchObject({ number: 7, forge: "gitlab" });
  });

  it("passes an unknown forge id through untouched", () => {
    const hint = selectPrHintFromStatus(githubStatus, "bitbucket");
    expect(hint?.forge).toBe("bitbucket");
  });

  it("returns null when the url has no parseable change-request number", () => {
    expect(
      selectPrHintFromStatus({ url: "https://example.com/x", state: "open", isMerged: false }),
    ).toBeNull();
  });
});

describe("PR merge activity", () => {
  it.each([
    [{ autoMergeRequest: {} }, "awaiting_merge"],
    [{ isInMergeQueue: true }, "awaiting_merge"],
    [{ isMergeQueueEnabled: true }, undefined],
    [{ mergeStateStatus: "BLOCKED" }, undefined],
    [{ autoMergeRequest: null, isInMergeQueue: false }, undefined],
    [{ isInMergeQueue: "true" }, undefined],
    [null, undefined],
  ])("uses verified auto-merge or queue membership: %j", (github, activity) => {
    expect(selectPrHintFromStatus({ ...githubStatus, github })?.activity).toBe(activity);
  });

  it("shows a pending direct merge ahead of auto-merge, and clears it afterwards", () => {
    const status = { ...githubStatus, github: { autoMergeRequest: {} } };
    expect(selectPrHintFromStatus(status, "github", true)?.activity).toBe("merging");
    expect(selectPrHintFromStatus(status, "github", false)?.activity).toBe("awaiting_merge");
    expect(selectPrHintFromStatus(githubStatus, "github", false)?.activity).toBeUndefined();
  });

  it.each(["merged", "closed"])("never overrides a confirmed %s result", (state) => {
    expect(
      selectPrHintFromStatus(
        { ...githubStatus, state, github: { isInMergeQueue: true } },
        "github",
        true,
      ),
    ).toMatchObject({ state, activity: undefined });
  });

  it("does not treat another forge's payload as GitHub evidence", () => {
    expect(
      selectPrHintFromStatus({ ...gitlabStatus, github: { autoMergeRequest: {} } }, "gitlab")
        ?.activity,
    ).toBeUndefined();
    expect(selectPrHintFromStatus(gitlabStatus, "gitlab", true)?.activity).toBe("merging");
  });
});
