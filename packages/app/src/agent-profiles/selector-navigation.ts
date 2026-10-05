export type SelectorSection = "environment" | "account" | "profile";
export interface SelectorNavigation {
  section: SelectorSection;
  searchOpen: boolean;
}
export type SelectorNavigationAction =
  | { type: "section"; section: SelectorSection }
  | { type: "environment" }
  | { type: "account" }
  | { type: "search" };
export function selectorNavigation(
  state: SelectorNavigation,
  action: SelectorNavigationAction,
): SelectorNavigation {
  if (action.type === "section") return { ...state, section: action.section };
  if (action.type === "environment") return { ...state, section: "account" };
  if (action.type === "account") return { ...state, section: "profile" };
  return { ...state, searchOpen: !state.searchOpen };
}
