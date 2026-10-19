import { createContext, useContext } from "react";

/** The upper toolbar can borrow tab-row space without changing the card column. */
export const SharedWorkspaceToolbarContext = createContext<{
  menuHost: string;
  paneId: string | null;
  reservedWidth: number;
} | null>(null);

export function useSharedToolbarInset(paneId?: string) {
  const toolbar = useContext(SharedWorkspaceToolbarContext);
  return toolbar?.paneId === paneId ? (toolbar?.reservedWidth ?? 0) : 0;
}
