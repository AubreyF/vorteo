import { isWeb } from "@/constants/platform";

/** Report only fixed classifications; exception text can contain credentials or task data. */
export function reportBootFailure(
  kind: "installation-origin-mismatch" | "installation-invalid" | "render-failed",
): void {
  if (isWeb && typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("vorteo-boot-failed", { detail: kind }));
  }
}
