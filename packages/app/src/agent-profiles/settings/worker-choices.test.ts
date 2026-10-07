import { expect, it } from "vitest";
import type { AgentProfile } from "@getpaseo/protocol/messages";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import { sharedWorkflowProfileId } from "@getpaseo/protocol/provider-preferences";
import { workerChoices } from "./worker-choices";

const providers = {
  "claude-one": { extends: "claude" },
  "codex-one": { extends: "codex" },
  "codex-two": { extends: "codex" },
};
const entries: ProviderSnapshotEntry[] = Object.keys(providers).map((provider) => ({
  provider,
  label: provider,
  enabled: true,
  status: "ready",
  models: [{ provider, id: "model", label: "Model" }],
}));
const profiles: AgentProfile[] = entries.map(({ provider }) => ({
  id: sharedWorkflowProfileId(provider, "worker"),
  provider,
  name: "Worker",
  model: "model",
}));
const input = {
  profiles,
  entries,
  providers,
  supervisor: { id: "supervisor", provider: "claude-one" },
  selectedWorkerId: "",
  accountId: null,
};

it("keeps account bindings separate and only shows profiles belonging to the selected account", () => {
  const choices = workerChoices({ ...input, accountId: "codex-two" });
  expect(choices.accountOptions.map((option) => option.value)).toEqual([
    "",
    "claude-one",
    "codex-one",
    "codex-two",
  ]);
  expect(choices.profiles).toEqual([
    { id: profiles[2].id, value: profiles[2].id, label: "Worker", description: "Model" },
  ]);
});

it("resolves a saved cross-provider worker without changing its account", () => {
  const choices = workerChoices({ ...input, selectedWorkerId: profiles[1].id });
  expect(choices.accountId).toBe("codex-one");
  expect(choices.profileDisplay.label).toBe("Worker");
  expect(choices.unavailable).toBe(false);
});

it("excludes self references, nested teams, unavailable models and excluded environments", () => {
  const candidates = [
    { ...profiles[0], id: sharedWorkflowProfileId("claude-one", "supervisor") },
    { ...profiles[1], workerProfileId: "nested" },
    { ...profiles[2], model: "missing" },
    { ...profiles[2], id: "excluded", excludedEnvironments: ["host" as const] },
  ];
  expect(
    workerChoices({ ...input, profiles: candidates, environment: "host" }).accountOptions,
  ).toEqual([{ id: "none", value: "", label: "No workers" }]);
});

it("preserves an unavailable saved worker instead of displaying No workers", () => {
  const choices = workerChoices({ ...input, selectedWorkerId: "removed" });
  expect(choices.accountDisplay.label).not.toBe("No workers");
  expect(choices.profileDisplay.description).toBe("removed");
  expect(choices.unavailable).toBe(true);
});

it("does not offer disabled accounts or models that cannot be selected", () => {
  const unavailable = entries.map((entry, index) =>
    index === 0
      ? Object.assign({}, entry, { enabled: false })
      : Object.assign({}, entry, {
          models: entry.models!.map((model) => Object.assign({}, model, { isSelectable: false })),
        }),
  );
  expect(workerChoices({ ...input, entries: unavailable }).profiles).toEqual([]);
  expect(workerChoices({ ...input, entries: unavailable }).accountOptions).toHaveLength(1);
});

it("displays the runtime's local binding for an unchanged installation worker reference", () => {
  const canonical = "shared-workflow/installation-codex/worker";
  const supervisor = {
    id: sharedWorkflowProfileId("claude-one", "supervisor"),
    provider: "claude-one",
    name: "Supervisor",
    workerProfileId: profiles[2].id,
  };
  const choices = workerChoices({
    ...input,
    profiles: [...profiles, supervisor],
    selectedWorkerId: canonical,
    originalWorkerId: canonical,
  });
  expect(choices.accountId).toBe("codex-two");
  expect(choices.selectedWorkerId).toBe(profiles[2].id);
  expect(choices.unavailable).toBe(false);
  const changed = workerChoices({
    ...input,
    profiles: [...profiles, supervisor],
    selectedWorkerId: profiles[1].id,
    originalWorkerId: canonical,
  });
  expect(changed.accountId).toBe("codex-one");
});
