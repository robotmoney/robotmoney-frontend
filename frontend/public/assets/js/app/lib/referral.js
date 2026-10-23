// The referral link's code (RM-189). A member shares any site URL with
// `?ref=rm_<handle>`; the code is read on whatever page the visitor lands on,
// kept for the browser session, and sent with the early-access form, so credit
// starts at sign-up rather than at the first deposit.
//
// Stored RAW, as the link carried it. Normalising and validating a code
// (docs/technical/referrals-spec.md §3) waits for the public code lookup, which
// is not built; until then the report side judges it. The only filter is a
// length cap, so a pasted paragraph is not taken for a code.
//
// The first code of a session holds: a second link opened in the same tab does
// not replace it, the way the earliest attribution wins on chain.

const KEY = "rm:referral";
const MAX_LENGTH = 64;

/** @param {Storage | undefined} store */
const storage = (store) => {
  try { return store ?? globalThis.sessionStorage; } catch { return undefined; }
};

/** Read `?ref=` from a query string and keep it, unless one is already held. */
export function captureReferral(search = globalThis.location?.search ?? "", store) {
  const raw = new URLSearchParams(search).get("ref")?.trim();
  if (!raw || raw.length > MAX_LENGTH) return;
  const s = storage(store);
  try {
    if (s && !s.getItem(KEY)) s.setItem(KEY, raw);
  } catch { /* storage blocked: the code is lost, the page is not */ }
}

/** The held code, or null. */
export function referralCode(store) {
  try { return storage(store)?.getItem(KEY) || null; } catch { return null; }
}

/** Forget the code once the form that carries it has been sent. */
export function clearReferral(store) {
  try { storage(store)?.removeItem(KEY); } catch { /* nothing held */ }
}
