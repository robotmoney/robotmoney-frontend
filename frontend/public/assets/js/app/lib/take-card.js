// One member take, read the same way wherever it appears (RM-121): a session
// page lists the room's takes on one subject, a member's page lists one
// member's takes across subjects. The card differs only in its heading (who
// filed it, or what it was about); the body, the stance, confidence and
// signature state, the proposed weights and the way it opens are this module.
//
// A nested Alpine component: `x-data="takeCard()"` on each card. The markup
// lives in the two views; the behaviour lives here, once.
import { weightEntries, bucketLabel, bucketHue, bucketRank } from "./session-summary.js";
import { fmtPctTrim } from "./weight-change.js";

// A structured take's CALL: the section about the subject under review. v0
// takes open with REGIME (the market notes every member repeats), then
// ALLOCATION (the framework), then SUBJECT or YOUR PORTFOLIO (the book in
// front of them). A portfolio take's call is its section on that portfolio;
// an allocation take has none, so its call is ALLOCATION. A heading may join
// two parts ("REGIME + ALLOCATION"). Null when the take has no such
// structure, and the card falls back to the opening of the body.
/** @param {string} body @param {string} [subjectName] */
export function takeCall(body, subjectName) {
  const text = String(body || "");
  const heads = [...text.matchAll(/^\*\*([A-Z][A-Z \-/&+]+)\*\*\s*$/gm)];
  if (heads.length < 2) return null;
  const sections = heads.map((m, i) => ({
    head: m[1].trim(),
    text: text.slice(/** @type {number} */ (m.index) + m[0].length, i + 1 < heads.length ? heads[i + 1].index : text.length).trim(),
  })).filter((x) => x.text);
  const parts = (/** @type {string} */ h) => h.split(/\s*\+\s*/);
  for (const want of ["SUBJECT", "YOUR PORTFOLIO", "ALLOCATION"]) {
    const hit = sections.find((x) => parts(x.head).includes(want));
    if (!hit) continue;
    const label = want === "ALLOCATION" ? "Allocation" : `On ${subjectName || "this portfolio"}`;
    // The first three points. A line clamp would drop the list markers; the
    // full take opens the rest.
    const lines = hit.text.split("\n").filter((l) => l.trim());
    return { label, text: lines.slice(0, 3).join("\n") };
  }
  return null;
}

// A member's proposed sleeve weights (#963), as rows in the published order.
/** @param {any} take */
export function takeWeightRows(take) {
  const entries = weightEntries(take?.weights || take?.payload?.weights);
  if (entries.length < 2) return [];
  const nums = entries.map(([k, v]) => /** @type {[string, number]} */ ([k, Number(v)])).filter(([, v]) => Number.isFinite(v) && v >= 0);
  const total = nums.reduce((a, [, v]) => a + v, 0);
  if (!total) return [];
  return nums
    .map(([k, v]) => ({ key: k, label: bucketLabel(k), pct: (v / total) * 100, colour: bucketHue(k), rank: bucketRank(k) }))
    .sort((a, b) => a.rank - b.rank);
}

// A take's memo link, only when it is a web address. The URL is member
// supplied, so anything else (a javascript: or data: URL) is not linked.
/** @param {unknown} url */
export function memoHref(url) {
  const s = String(url || "").trim();
  return /^https?:\/\/[^\s]+$/i.test(s) ? s : "";
}

const EASE = "cubic-bezier(0.16, 1, 0.3, 1)";

export function takeCard() {
  return {
    open: false,
    call: takeCall,
    weightRows: takeWeightRows,
    memoHref,
    pct: fmtPctTrim,
    /** @param {string} body */
    long(body) { return String(body || "").length > 420; },
    // Open and close by HEIGHT, from what is on screen to what will be:
    // measured before the swap and after it, then eased between the two.
    // A line clamp or a swapped block cannot transition on its own; this is
    // what makes the change read as the same card growing rather than a jump.
    // Closing a take taller than the screen brings its top back into view.
    toggle() {
      const el = /** @type {HTMLElement | undefined} */ (/** @type {any} */ (this).$refs.text);
      const reduce = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
      const closing = this.open;
      if (!el || reduce) { this.open = !this.open; return; }
      const from = el.getBoundingClientRect().height;
      el.style.height = `${from}px`;
      el.style.overflow = "hidden";
      this.open = !this.open;
      /** @type {any} */ (this).$nextTick(() => {
        el.style.height = "auto";
        const to = el.getBoundingClientRect().height;
        el.style.height = `${from}px`;
        void el.offsetHeight;
        el.style.transition = `height ${closing ? 225 : 300}ms ${EASE}`;
        el.style.height = `${to}px`;
        const done = () => {
          el.style.height = "";
          el.style.overflow = "";
          el.style.transition = "";
          el.removeEventListener("transitionend", done);
        };
        el.addEventListener("transitionend", done);
        if (closing) {
          const card = /** @type {HTMLElement} */ (/** @type {any} */ (this).$root);
          if (card && card.getBoundingClientRect().top < 0) card.scrollIntoView({ block: "start", behavior: "smooth" });
        }
      });
    },
  };
}
