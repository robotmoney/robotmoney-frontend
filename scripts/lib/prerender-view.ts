// What a route's view fragment becomes when it is published into the prerendered
// shell, as opposed to when it is fetched by the client router at runtime.
//
// Split out of scripts/prerender.ts so the guard in
// scripts/tests/unit/prerender-content.test.ts can pin this contract by
// importing it, rather than restating it and drifting. prerender.ts runs its
// work at import time, so a test cannot import that file without running a
// prerender.
//
// Two things come off, and both are the difference between publishing a page and
// publishing a template.

/**
 * Elements that are, by this codebase's own convention, not content until Alpine
 * has evaluated them.
 *
 * `x-cloak` means exactly that: components.css sets `[x-cloak]{display:none}` so
 * the element is invisible until Alpine strips the attribute. A reader that never
 * runs Alpine is precisely the reader for whom that condition never resolves, so
 * serving it the element contradicts the attribute. Concretely, it is how
 * "Regime data may be stale." became page text on /regime for every crawler, on a
 * day when the data was not stale.
 *
 * The bare `loading` and `error` guards go for the same reason with less
 * ambiguity: an element shown only while loading, or only on failure, is never
 * the page's content.
 *
 * Measured over all 38 prerendered routes before switching this on: x-cloak
 * covered 1.0% of the text and bare loading/error guards 0.04%, and the largest
 * single instance was 493 characters. It never wraps a page's substance, which is
 * the only reason this is safe to apply wholesale rather than view by view.
 */
export const HYDRATION_ONLY = "[x-cloak],[x-show=loading],[x-show=error],[x-if=loading],[x-if=error]";

/**
 * The fragment as it should appear in a published page.
 *
 * HTMLRewriter, not a regex, because these fragments are full of Alpine
 * expressions containing ">" inside quoted attributes, which a `<[^>]+>` splitter
 * slices in the wrong place. Not hypothetical: it is why an early measurement of
 * /regime reported `= 3 ? 'rv--cols4' : 'rv--cols3'">` as readable prose.
 *
 * Comments come off first and never reach the built copy (the source keeps
 * them): the house-style banners in these files ("NO <script>, NO custom Alpine
 * factories, NO gradients") are internal engineering notes with no business in a
 * published page, they are 4.4% of the fragment bytes shipped on every route, and
 * several of them QUOTE tags, which a naive text extractor pairs with the real
 * closing tag further down and swallows the whole page between.
 */
export async function publishableFragment(raw: string): Promise<string> {
  const withoutComments = raw.replace(/<!--[\s\S]*?-->/g, "");
  const stripped = new HTMLRewriter()
    .on(HYDRATION_ONLY, { element(el) { el.remove(); } })
    .transform(new Response(withoutComments));
  return (await stripped.text()).trim();
}
