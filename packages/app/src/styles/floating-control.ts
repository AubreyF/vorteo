import type { Theme } from "./theme";

/** Floating navigation controls share the same surface, outline and soft elevation. */
export function floatingControlSurface(theme: Theme) {
  return {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface2,
    ...theme.shadow.sm,
  };
}
