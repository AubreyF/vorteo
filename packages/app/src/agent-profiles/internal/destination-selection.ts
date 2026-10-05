import type {
  WorkspaceDescriptorPayload,
  WorkspaceProjectDescriptorPayload,
} from "@getpaseo/protocol/messages";

export type DestinationSelection =
  | { kind: "existing"; workspace: WorkspaceDescriptorPayload | null }
  | {
      kind: "new";
      project: WorkspaceProjectDescriptorPayload | null;
      checkout: "directory" | "worktree";
      title: string;
    };

export function newDestinationSelection(
  project: WorkspaceProjectDescriptorPayload | null,
): DestinationSelection {
  return { kind: "new", project, checkout: "directory", title: "" };
}

export function destinationSelectionReady(selection: DestinationSelection): boolean {
  return selection.kind === "existing" ? selection.workspace !== null : selection.project !== null;
}

export function selectDestinationProject(
  selection: DestinationSelection,
  project: WorkspaceProjectDescriptorPayload,
): DestinationSelection {
  if (selection.kind === "existing") return newDestinationSelection(project);
  const checkout = project.projectKind === "git" ? selection.checkout : "directory";
  return { ...selection, project, checkout };
}
