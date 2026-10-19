// Only the managed demo launcher enables this. Normal clients retain Host access.
export const isIsolatedDemoPreview = process.env.EXPO_PUBLIC_DEMO_PREVIEW === "1";

export function assertRealHostAccess(): void {
  if (isIsolatedDemoPreview) {
    throw new Error("This preview uses simulated data. Choose Demo to explore Vorteo.");
  }
}
