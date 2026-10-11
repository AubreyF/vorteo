import { workspaceLabelKey } from "@getpaseo/protocol/workspace-labels";

export function isFactoryLabel(name: string): boolean {
  return workspaceLabelKey(name) === "factory";
}

/** Presentation only. A label never grants native Factory membership or lifecycle authority. */
export function hasFactoryTag(labels: readonly string[] | undefined): boolean {
  return labels?.some(isFactoryLabel) ?? false;
}
