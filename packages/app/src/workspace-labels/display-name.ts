// Existing custom labels never acquire lifecycle behavior because of their name.
export function workspaceLabelDisplayName(name: string): string {
  if (["standing", "protected", "scheduled"].includes(name.trim().toLowerCase())) {
    return `${name} (custom)`;
  }
  return name;
}
