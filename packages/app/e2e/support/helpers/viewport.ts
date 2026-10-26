import type { Page } from "@playwright/test";

/**
 * Resizes the viewport and waits until the page paints twice, so the next assertion's timeout
 * starts only once the page responds. Crossing the phone/desktop breakpoint blocks the main thread
 * while Unistyles rebuilds its web stylesheet: 3 to 14 seconds locally (2026-10-26), longer on
 * loaded CI runners, where it outlasted 10 second assertions in run 40250589484. That freeze is a
 * known performance regression, marked in chat-outline.spec.ts.
 */
export async function resizeAndSettle(
  page: Page,
  size: { width: number; height: number },
): Promise<void> {
  await page.setViewportSize(size);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}
