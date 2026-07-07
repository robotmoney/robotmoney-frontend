// Shared perf policy for hero canvases: cap the frame rate (heroes are
// decorative, not interactive — 30fps is imperceptible here but roughly
// halves main-thread work) and pause entirely while off-screen or when the
// user has asked for reduced motion. One place to change frame-rate/visibility
// policy for every hero instead of duplicating it per sketch.
export function applyHeroPerf(p5Instance, hostElement, options = {}) {
  const { fpsCap = 30, threshold = 0.1 } = options;
  const reduce =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  if (typeof p5Instance?.frameRate === "function") {
    p5Instance.frameRate(reduce ? 1 : fpsCap);
  }

  if (hostElement && typeof window !== "undefined" && typeof IntersectionObserver !== "undefined") {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            if (!reduce) p5Instance?.loop?.();
          } else {
            p5Instance?.noLoop?.();
          }
        });
      },
      { threshold },
    );
    observer.observe(hostElement);
    return () => observer.disconnect();
  }

  return () => {};
}
