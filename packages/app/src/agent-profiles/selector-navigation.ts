export type SelectorSection = "environment" | "account" | "profile";
export interface SelectorNavigation {
  section: SelectorSection;
}
export type SelectorNavigationAction =
  | { type: "section"; section: SelectorSection }
  | { type: "environment" }
  | { type: "account" };
export function selectorNavigation(
  state: SelectorNavigation,
  action: SelectorNavigationAction,
): SelectorNavigation {
  if (action.type === "section") return { ...state, section: action.section };
  if (action.type === "environment") return { ...state, section: "account" };
  return { ...state, section: "profile" };
}
