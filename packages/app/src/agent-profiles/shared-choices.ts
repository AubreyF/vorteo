import type { AgentProfile, ProviderPreferences } from "@getpaseo/protocol/messages";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";

export interface LaunchChoices {
  provider?: string;
  model?: string;
  thinkingOptionId?: string;
}

interface ChoiceOption {
  id: string;
  value: string;
  label: string;
  available: boolean;
}

function rankedOptions(options: Map<string, ChoiceOption>, preferred: readonly string[]) {
  const ranks = new Map(preferred.map((id, index) => [id, index]));
  return [...options.values()].sort(
    (left, right) =>
      (ranks.get(left.id) ?? preferred.length) - (ranks.get(right.id) ?? preferred.length),
  );
}

function catalogChoices(input: {
  model: string;
  entry: Pick<ProviderSnapshotEntry, "models"> | undefined;
  family: readonly Pick<ProviderSnapshotEntry, "models">[];
  preferences: ProviderPreferences | undefined;
}) {
  const models = input.entry?.models ?? [];
  const current = models.find(
    (candidate) => candidate.id === input.model && candidate.isSelectable !== false,
  );
  const familyModels = input.family.flatMap((entry) => entry.models ?? []);
  const modelOptions = new Map<string, ChoiceOption>();
  const thinkingOptions = new Map<string, ChoiceOption>();
  for (const model of familyModels) {
    if (model.isSelectable === false) continue;
    modelOptions.set(model.id, {
      id: model.id,
      value: model.id,
      label: model.label,
      available: models.some(
        (candidate) => candidate.id === model.id && candidate.isSelectable !== false,
      ),
    });
    if (model.id !== input.model) continue;
    for (const option of model.thinkingOptions ?? []) {
      thinkingOptions.set(option.id, {
        id: option.id,
        value: option.id,
        label: option.label,
        available: Boolean(
          current?.thinkingOptions?.some((candidate) => candidate.id === option.id),
        ),
      });
    }
  }
  return {
    modelOptions: rankedOptions(modelOptions, input.preferences?.preferredModels ?? []),
    thinkingOptions: [
      { id: "provider-default", value: "", label: "Provider default", available: true },
      ...rankedOptions(thinkingOptions, input.preferences?.preferredThinkingOptions ?? []),
    ],
  };
}

export function profileCatalogState(
  entry: Pick<ProviderSnapshotEntry, "models" | "status"> | undefined,
) {
  if (!entry || entry.status === "loading") return "loading";
  if (entry.status !== "ready" || !entry.models) return "error";
  return "ready";
}

function choiceErrors(input: {
  model: string;
  thinkingOptionId: string;
  entry: Pick<ProviderSnapshotEntry, "models" | "status"> | undefined;
}) {
  if (profileCatalogState(input.entry) !== "ready")
    return { modelError: null, thinkingError: null };
  const models = input.entry?.models ?? [];
  const selectable = models.filter((model) => model.isSelectable !== false);
  const selected = input.model
    ? selectable.find((model) => model.id === input.model)
    : (selectable.find((model) => model.isDefault) ?? selectable[0]);
  if (input.model && !selected)
    return {
      modelError: `Model ${input.model} is not offered by this account.`,
      thinkingError: null,
    };
  const supported = selected?.thinkingOptions?.some(
    (option) => option.id === input.thinkingOptionId,
  );
  const thinkingError =
    input.thinkingOptionId && !supported
      ? `Reasoning level ${input.thinkingOptionId} is not offered for ${selected?.label ?? "the default model"} on this account.`
      : null;
  return { modelError: null, thinkingError };
}

export function sharedChoiceState(input: {
  profile: AgentProfile;
  choices: LaunchChoices;
  entry: Pick<ProviderSnapshotEntry, "models" | "status"> | undefined;
  family?: readonly Pick<ProviderSnapshotEntry, "models">[];
  preferences?: ProviderPreferences;
}) {
  const model = input.choices.model ?? input.profile.model ?? "";
  const thinkingOptionId = input.choices.thinkingOptionId ?? input.profile.thinkingOptionId ?? "";
  const models = input.entry?.models ?? [];
  const selectedModel = models.find(
    (candidate) => candidate.id === model && candidate.isSelectable !== false,
  );
  const family = input.family ?? [input.entry ?? { models: [] }];
  const { modelOptions, thinkingOptions } = catalogChoices({
    model,
    entry: input.entry,
    family,
    preferences: input.preferences,
  });
  const errors = choiceErrors({ model, thinkingOptionId, entry: input.entry });
  return {
    choices: { model, thinkingOptionId },
    modelOptions,
    thinkingOptions,
    modelDisplay: { label: selectedModel?.label ?? model },
    thinkingDisplay: {
      label:
        thinkingOptions.find((option) => option.value === thinkingOptionId)?.label ??
        thinkingOptionId,
    },
    ...errors,
    unavailable: Boolean(errors.modelError || errors.thinkingError),
  };
}
