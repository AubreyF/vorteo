// Built-in names are reserved in the picker; existing names retain their spelling.
export function workspaceLabelDisplayName(name: string): string {
  return name;
}

export function isBuiltInWorkspaceLabel(name: string): boolean {
  return ["standing", "protected", "scheduled"].includes(name.trim().toLowerCase());
}
