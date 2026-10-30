import { isWeb } from "@/constants/platform";

/**
 * The one approved Vorteo master. Every scene tints this artwork; its luminance
 * carries the shading where the V loops back on itself. On web the boot loader
 * already fetched the same file from `public/`, so the app reuses that URL
 * instead of a second bundled copy. scripts/generate-vorteo-icons.mjs rewrites
 * the hash here and in public/index.html.
 */
export const VORTEO_MASTER_WEB_PATH = "/vorteo-logo-white-fa002b83cde0.png";

export function vorteoMasterSource() {
  return isWeb
    ? { uri: VORTEO_MASTER_WEB_PATH }
    : require("../../../assets/brand/vorteo-white.png");
}
