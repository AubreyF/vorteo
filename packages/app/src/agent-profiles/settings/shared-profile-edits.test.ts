import { openAgentProfileForm } from "../internal/profile-form-model";
import { expect, it } from "vitest";
import type { ProviderPreferences } from "@getpaseo/protocol/messages";
import { replaceProviderDefaults, editSharedProfile } from "./shared-profile-edits";

it("moves inherited worker settings to existing profiles without changing explicit overrides", () => {
  const group: ProviderPreferences = {
    defaults: { modeId: "auto", workerProfileId: "codex-worker", maxWorkers: 4 },
    workflows: [
      { id: "team", name: "Team", provider: "claude" },
      { id: "solo", name: "Solo", provider: "claude", workerProfileId: "" },
      {
        id: "other",
        name: "Other",
        provider: "claude",
        workerProfileId: "claude-worker",
        maxWorkers: 2,
      },
    ],
    preferredModels: [],
    preferredThinkingOptions: [],
    defaultWorkflowId: "team",
  };
  const next = replaceProviderDefaults(group, { ...group.defaults, modeId: "default" });
  expect(next.defaults).toEqual({ modeId: "default" });
  expect(next.workflows).toEqual([
    { ...group.workflows[0], workerProfileId: "codex-worker", maxWorkers: 4 },
    { ...group.workflows[1], maxWorkers: 4 },
    group.workflows[2],
  ]);
  expect(group.defaults).toEqual({
    modeId: "auto",
    workerProfileId: "codex-worker",
    maxWorkers: 4,
  });
  expect(replaceProviderDefaults(next, next.defaults)).toEqual(next);
});

it("clears a profile skill override without pinning inherited settings or losing an explicit worker account", () => {
  const group: ProviderPreferences = {
    defaults: { modeId: "auto", skillPolicy: { mode: "none" } },
    workflows: [
      {
        id: "review",
        name: "Review",
        provider: "claude",
        skillPolicy: { mode: "selected", skills: ["old"] },
      },
    ],
    preferredModels: [],
    preferredThinkingOptions: [],
    defaultWorkflowId: "review",
  };
  const model = openAgentProfileForm({
    mode: "edit",
    profile: { ...group.defaults, ...group.workflows[0] },
  });
  model.setSkillPolicy(undefined);
  model.setWorkerProfileId("shared-workflow/codex-two/worker");
  const saved = editSharedProfile(group, "review", "claude", model.getState().submitValue!);
  expect(saved.skillPolicy).toBeUndefined();
  expect(saved.modeId).toBeUndefined();
  expect(saved.workerProfileId).toBe("shared-workflow/codex-two/worker");
  expect(group.workflows[0].skillPolicy).toEqual({ mode: "selected", skills: ["old"] });
});

it("saves the exact installation account separately from the shared worker identity", () => {
  const group: ProviderPreferences = {
    defaults: {},
    preferredModels: [],
    preferredThinkingOptions: [],
    defaultWorkflowId: "team",
    workflows: [{ id: "team", name: "Team", provider: "claude" }],
  };
  const model = openAgentProfileForm({ mode: "edit", profile: group.workflows[0] });
  model.setWorkerAccount("codex-two");
  model.setWorkerProfileId("shared-workflow/codex-two/worker");
  const saved = editSharedProfile(
    group,
    "team",
    "claude",
    model.getState().submitValue!,
    { "codex-two": { extends: "codex", installationAccountId: "account-two" } },
    true,
  );
  expect(saved.workerProfileId).toBe("shared-profile/codex/worker");
  expect(saved.workerAccount).toBe("installation-account/account-two");
  const reopened = openAgentProfileForm({ mode: "edit", profile: saved });
  const next = editSharedProfile(
    { ...group, workflows: [saved] },
    "team",
    "claude",
    reopened.getState().submitValue!,
  );
  expect(next.workerAccount).toBe(saved.workerAccount);
  reopened.setWorkerAccount("");
  const cleared = editSharedProfile(
    { ...group, workflows: [saved] },
    "team",
    "claude",
    reopened.getState().submitValue!,
  );
  expect(cleared.workerAccount).toBeUndefined();
  expect(cleared.workerProfileId).toBe("");
});
