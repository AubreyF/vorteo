import { useVortonTouch } from "@/vorton-touch";

const desktop = { width: 24, height: 24, minWidth: 24, minHeight: 24 };
const touchAction = { width: 44, height: 44, minWidth: 44, minHeight: 44 };

export function useSidebarActionSize() {
  const touch = useVortonTouch();

  return touch ? touchAction : desktop;
}
