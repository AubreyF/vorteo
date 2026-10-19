import type { Theme } from "./theme";

/** Shared tab silhouette: rounded top corners meet a square content edge. */
export function tabShape(theme: Theme) {
  return {
    borderTopLeftRadius: theme.borderRadius.lg,
    borderTopRightRadius: theme.borderRadius.lg,
    borderBottomLeftRadius: 0,
    borderBottomRightRadius: 0,
  };
}
