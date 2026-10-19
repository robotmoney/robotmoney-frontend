// The hero headline's audience word (RM-175): "The model portfolio for ___."
// cycles through the people it is for.
//
// The markup holds every audience as one sentence, so a crawler and a screen
// reader read the whole list and a reader without JavaScript (or with reduced
// motion) sees the first one; the rest of the sentence is visually hidden by
// CSS alone. This adds a second, aria-hidden copy of the word that moves: the
// letters leave upward through a mask, the line's width follows the next word
// (so the full stop glides with it), and the new letters rise in one by one
// once the old word has gone, so the two never share the line.
// Transforms only, through the Web Animations API, so the swap stays on the
// compositor. It pauses while the hero is off screen, the tab is hidden, or a
// pointer rests on the headline. Returns a stop() that undoes all of it.

const HOLD_MS = 2800;
const OUT_MS = 380;
const IN_AT = 340;
const IN_MS = 760;
const WIDTH_AT = 160;
const WIDTH_MS = 720;
const IN_STAGGER = 24;
const EASE_IN = "cubic-bezier(0.7, 0, 0.84, 0)";
const EASE_OUT = "cubic-bezier(0.16, 1, 0.3, 1)";
const EASE_IN_OUT = "cubic-bezier(0.76, 0, 0.24, 1)";

/**
 * One term as letter spans. A trailing lowercase "s" after capitals keeps its
 * case under the headline's uppercase transform, so "DAOs" never reads "DAOS".
 * @param {string} term
 */
function word(term) {
  const w = document.createElement("span");
  w.className = "hm-rot__w";
  const plural = /^[A-Z]{2,}s$/.test(term);
  [...term].forEach((ch, i) => {
    const l = document.createElement("span");
    l.className = "hm-rot__l";
    if (ch === " ") l.classList.add("hm-rot__sp");
    if (plural && i === term.length - 1) l.classList.add("hm-rot__lc");
    l.dataset.ch = ch;
    w.append(l);
  });
  return w;
}

/**
 * @param {HTMLElement | null} el  the .hm-rot span; data-terms is a JSON array
 * @param {{ host: HTMLElement | null, hover: HTMLElement | null, reduce: boolean, delay?: number }} o
 */
export function runRotator(el, { host, hover, reduce, delay = HOLD_MS }) {
  /** @type {string[]} */
  let terms = [];
  try { terms = JSON.parse(el?.dataset.terms || "[]"); } catch { terms = []; }
  if (!el || reduce || terms.length < 2 || typeof el.animate !== "function") return () => {};

  const vis = document.createElement("span");
  vis.className = "hm-rot__vis";
  vis.setAttribute("aria-hidden", "true");
  let current = word(terms[0]);
  vis.append(current);
  el.append(vis);
  el.classList.add("is-live");

  let i = 0, timer = 0, stopped = false, busy = false;
  let onScreen = true, hovered = false;
  /** @type {Animation[]} */
  let running = [];

  const paused = () => stopped || !onScreen || hovered || document.hidden;
  const schedule = (/** @type {number} */ ms) => {
    clearTimeout(timer);
    timer = window.setTimeout(() => (paused() ? (timer = 0) : swap()), ms);
  };
  const resume = () => { if (!timer && !busy && !paused()) schedule(HOLD_MS / 2); };

  async function swap() {
    timer = 0;
    busy = true;
    i = (i + 1) % terms.length;
    const prev = current;
    const next = word(terms[i]);
    current = next;

    const from = vis.getBoundingClientRect().width;
    prev.classList.add("is-out");
    vis.append(next);
    const to = next.getBoundingClientRect().width;

    const anims = [];
    anims.push(prev.animate(
      [{ transform: "translateY(0)", opacity: 1 }, { transform: "translateY(-100%)", opacity: 0 }],
      { duration: OUT_MS, easing: EASE_IN, fill: "forwards" },
    ));
    anims.push(vis.animate(
      [{ width: `${from}px` }, { width: `${to}px` }],
      { duration: WIDTH_MS, delay: WIDTH_AT, easing: EASE_IN_OUT, fill: "backwards" },
    ));
    [...next.children].forEach((l, k) => anims.push(l.animate(
      [{ transform: "translateY(100%)" }, { transform: "translateY(0)" }],
      { duration: IN_MS, delay: IN_AT + k * IN_STAGGER, easing: EASE_OUT, fill: "backwards" },
    )));
    running = anims;
    await Promise.allSettled(anims.map((a) => a.finished));
    if (stopped) return;
    prev.remove();
    running = [];
    busy = false;
    if (!paused()) schedule(HOLD_MS);
  }

  const io = host ? new IntersectionObserver(([e]) => { onScreen = e.isIntersecting; resume(); }) : null;
  if (host) io?.observe(host);
  const enter = () => { hovered = true; };
  const leave = () => { hovered = false; resume(); };
  hover?.addEventListener("pointerenter", enter);
  hover?.addEventListener("pointerleave", leave);
  document.addEventListener("visibilitychange", resume);

  // Letters are measured, so wait for the display face before the first swap.
  (document.fonts?.ready ?? Promise.resolve()).then(() => { if (!stopped) schedule(delay); });

  return () => {
    stopped = true;
    clearTimeout(timer);
    running.forEach((a) => a.cancel());
    io?.disconnect();
    hover?.removeEventListener("pointerenter", enter);
    hover?.removeEventListener("pointerleave", leave);
    document.removeEventListener("visibilitychange", resume);
    vis.remove();
    el.classList.remove("is-live");
  };
}
