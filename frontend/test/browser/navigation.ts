// The ONE in-app navigation helper for browser specs.
//
// Six specs used to carry a byte-identical private copy of this function that
// pushed state, dispatched `popstate`, and returned immediately. The router's
// render() awaits a view fetch before it swaps the DOM and applies route meta
// (frontend/public/assets/js/app/router.js), so those copies returned while the
// navigation was still in flight. Assertions after them passed only when the
// next line happened to be a retrying locator matcher that waited the fetch
// out; a one-shot read (`expect(await locator.getAttribute(...))`) sampled the
// PREVIOUS route and went red as soon as CI moved to ephemeral runners with
// cold asset caches.
//
// This version resolves on the router's own `rm:view-changed` event, so
// `await navigate(...)` means the new view is in the DOM, the nav is synced,
// and the route's meta is applied. Callers no longer have to know that a
// retrying matcher is load-bearing.
//
// NOT used by spa.spec.ts: that spec fires interleaved navigations on purpose
// to exercise the router's abort path, where an in-flight render is superseded
// and never completes. Waiting for completion there would defeat the test.
import type { Page } from "@playwright/test";

// Bounded so a navigation that never completes fails with a useful message
// here rather than as an opaque 30s Playwright test timeout further down.
const NAVIGATION_TIMEOUT_MS = 10_000;

export async function navigate(page: Page, path: string) {
  await page.evaluate(
    ([p, timeoutMs]) =>
      new Promise<void>((resolve, reject) => {
        const expectedPathname = new URL(p as string, location.href).pathname;
        const done = (event: Event) => {
          if ((event as CustomEvent<{ pathname?: string }>).detail?.pathname !== expectedPathname) return;
          clearTimeout(timer);
          window.removeEventListener("rm:view-changed", done);
          resolve();
        };
        const timer = setTimeout(() => {
          window.removeEventListener("rm:view-changed", done);
          reject(new Error(`navigate(${p}): router never dispatched rm:view-changed within ${timeoutMs}ms`));
        }, timeoutMs as number);
        // Listener first: render() can resolve before this evaluate returns.
        window.addEventListener("rm:view-changed", done);
        history.pushState({}, "", p as string);
        window.dispatchEvent(new PopStateEvent("popstate"));
      }),
    [path, NAVIGATION_TIMEOUT_MS] as const,
  );
}
