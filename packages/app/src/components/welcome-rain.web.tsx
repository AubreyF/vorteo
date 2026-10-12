import { useEffect, useRef } from "react";
import type { CSSProperties } from "react";

const GLYPHS = "01アイウエオカキクケコサシスセソナニヌネノ";
const canvasStyle: CSSProperties = {
  position: "absolute",
  inset: 0,
  width: "100%",
  height: "100%",
  pointerEvents: "none",
  maskImage: "radial-gradient(ellipse at center, transparent 12%, rgba(0,0,0,.35) 42%, black 90%)",
};

/** Slow, low-contrast decoration with no React updates during animation. */
export function WelcomeRain() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0;
    let last = 0;
    let elapsed = 0;
    let width = 0;
    let height = 0;
    function draw() {
      if (!context) return;
      context.clearRect(0, 0, width, height);
      context.font = "12px monospace";
      const columns = Math.ceil(width / 42);
      const rows = Math.ceil(height / 19);
      for (let column = 0; column < columns; column++) {
        const speed = 2 * (7 + (column % 5) * 1.4);
        const head = ((column * 173 + elapsed * speed) % (height + 260)) - 80;
        for (let row = 0; row < rows; row++) {
          // Only brightness moves. Every glyph keeps the same grid cell and baseline.
          const y = row * 19 + 14;
          const trail = (head - y) / 19;
          if (trail < 0 || trail >= 12) continue;
          const glyph = GLYPHS[(column * 7 + row * 13) % GLYPHS.length];
          context.fillStyle = `rgba(128,169,146,${0.13 * (1 - trail / 12)})`;
          context.fillText(glyph, column * 42 + 12, y);
        }
      }
    }
    function tick(now: number) {
      if (!canvas || reduced.matches || document.hidden) return;
      if (now - last >= 65) {
        elapsed += Math.min((now - last) / 1000, 0.15);
        last = now;
        draw();
      }
      frame = requestAnimationFrame(tick);
    }
    function resume() {
      cancelAnimationFrame(frame);
      last = performance.now();
      if (canvas) canvas.dataset.motion = reduced.matches ? "still" : "falling";
      draw();
      if (!reduced.matches && !document.hidden) frame = requestAnimationFrame(tick);
    }
    function resize() {
      if (!canvas || !context) return;
      const bounds = canvas.getBoundingClientRect();
      width = bounds.width;
      height = bounds.height;
      const ratio = Math.min(window.devicePixelRatio, 1.5);
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      draw();
    }
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    reduced.addEventListener("change", resume);
    document.addEventListener("visibilitychange", resume);
    resize();
    resume();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      reduced.removeEventListener("change", resume);
      document.removeEventListener("visibilitychange", resume);
    };
  }, []);
  return <canvas ref={ref} style={canvasStyle} aria-hidden="true" data-testid="welcome-rain" />;
}
