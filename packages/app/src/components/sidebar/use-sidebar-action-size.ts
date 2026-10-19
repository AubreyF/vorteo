import { useVortonTouch } from "@/vorton-touch";

const desktop = { width: 32, height: 32, minWidth: 32, minHeight: 32 };
const touchAction = { width: 44, height: 44, minWidth: 44, minHeight: 44 };

export function useSidebarActionSize() {
  const touch = useVortonTouch();

  return touch ? touchAction : desktop;
}
