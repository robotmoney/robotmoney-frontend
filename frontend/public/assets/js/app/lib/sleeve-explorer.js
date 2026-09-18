// The allocation mix, explorable (RM-121). A ring and its legend: hovering or
// focusing a sleeve previews it (the other arcs recede and the ring's centre
// names it), selecting it keeps its asset breakdown open, and Escape or Close
// lets it go. Keyboard, pointer and touch reach the same states; a touch never
// previews, it selects.
//
// It draws two kinds of whole: a recommended sleeve mix (a weights subject)
// and a book of holdings with the session's action on each position (a
// portfolio subject, whose sessions set no target sizes). A nested Alpine
// component; the page around it supplies, under the same names everywhere:
//   explorerSvg()     the ring, drawn once
//   explorerCenter()  { value, label } the ring's centre shows at rest; an
//                     empty value shows the label alone, and both empty
//                     leave the centre blank until a row is in focus
//   explorerRows()    [{ key, label, hue, pct, meta, d, was, basis, action,
//                     rationale, assets: [{ key, label, colour, ofSleeve,
//                     ofAllocation }] }] in the order the legend lists them
//
// Smoothness, which is most of what makes this feel right:
// - The ring is drawn ONCE. Focus is a class on the arcs (syncArcs), so the
//   receding arcs fade on a CSS transition instead of being redrawn.
// - Hover intent. Moving from a legend row down to the breakdown crosses the
//   rows below it; switching on every row the pointer grazes made the panel
//   flicker through them. A new sleeve is previewed only once the pointer
//   rests on it (INTENT_MS), and leaving it first cancels the switch. The
//   first preview is immediate.
// - The pointer leaving the explorer lets go after a short grace (LEAVE_MS),
//   so a pointer skimming the edge does not collapse the panel under it.
// - The breakdown stays mounted and animates its height (0fr to 1fr), and it
//   keeps showing the last sleeve while it closes rather than emptying first.
const INTENT_MS = 90;
const LEAVE_MS = 160;

// An action as a chip reads it: the direction glyph first, so the column
// survives greyscale, then the word. Shared with the recommendation history.
/** @param {string} action */
export function actionLabel(action) {
  const a = String(action || "").toLowerCase();
  if (!a) return "—";
  const glyph = /^(add|buy|increase|accumulate)/.test(a) ? "▲ "
    : /^(trim|reduce|sell|exit|cut)/.test(a) ? "▼ "
    : /^rotate/.test(a) ? "⇄ " : "";
  return glyph + a;
}

export function sleeveExplorer() {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let intent;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let leaving;
  return {
    /** @type {string | null} */
    pinned: null,
    /** @type {string | null} */
    hovered: null,
    // The sleeve the panel last showed, kept through the closing animation.
    /** @type {string | null} */
    shown: null,
    status: "",
    /** @returns {string | null} */
    active() { return this.pinned ?? this.hovered; },
    /** @param {string | null} key */
    rowFor(key) {
      if (!key) return null;
      return /** @type {any} */ (this).explorerRows().find((/** @type {any} */ r) => r.key === key) || null;
    },
    activeRow() { return this.rowFor(this.active()); },
    // What the breakdown panel draws: the active sleeve, or the one it is
    // closing on.
    panelRow() { return this.activeRow() || this.rowFor(this.shown); },
    /** @param {string | null} key */
    set(key) {
      this.hovered = key;
      if (key) this.shown = key;
    },
    /** @param {string} key @param {PointerEvent} [ev] */
    preview(key, ev) {
      if (ev && ev.pointerType === "touch") return;
      clearTimeout(leaving);
      if (this.pinned !== null || this.hovered === key) return;
      clearTimeout(intent);
      // Keyboard focus and the first pointer preview are immediate.
      if (!ev || this.hovered === null) { this.set(key); return; }
      intent = setTimeout(() => { if (this.pinned === null) this.set(key); }, INTENT_MS);
    },
    // The pointer left a sleeve before resting on it: it was passing over.
    cancelIntent() { clearTimeout(intent); },
    leave() {
      clearTimeout(intent);
      clearTimeout(leaving);
      if (this.pinned !== null) return;
      leaving = setTimeout(() => { if (this.pinned === null) this.hovered = null; }, LEAVE_MS);
    },
    /** @param {string} key */
    toggle(key) {
      clearTimeout(intent);
      clearTimeout(leaving);
      this.pinned = this.pinned === key ? null : key;
      this.hovered = null;
      if (this.pinned) this.shown = this.pinned;
      const row = this.activeRow();
      this.status = row ? `${row.label}, breakdown open` : "Breakdown closed";
    },
    close() {
      clearTimeout(intent);
      clearTimeout(leaving);
      if (this.active() === null) return;
      const key = this.active();
      this.pinned = null;
      this.hovered = null;
      this.status = "Breakdown closed";
      // Focus goes back to the sleeve's row only when it was inside the
      // explorer (Close, or Escape from the panel): a hover preview dismissed
      // with Escape leaves focus where the reader had it. Focusing the row
      // fires its preview synchronously, which would reopen the panel Close
      // just shut, so that preview is dropped.
      const root = /** @type {any} */ (this).$root;
      if (root && root.contains(document.activeElement)) {
        root.querySelector(`[data-sleeve-btn="${CSS.escape(String(key))}"]`)?.focus();
        this.hovered = null;
      }
    },
    actionLabel,
    // The arcs are drawn with x-html and cannot carry Alpine bindings, so the
    // focus class is set on them from an effect on their host.
    /** @param {Element} host */
    syncArcs(host) {
      const key = this.active();
      for (const arc of host.querySelectorAll("[data-sleeve]")) {
        arc.classList.toggle("is-muted", key !== null && arc.getAttribute("data-sleeve") !== key);
      }
    },
    // One listener serves every arc.
    /** @param {PointerEvent} ev */
    overRing(ev) {
      const key = /** @type {Element} */ (ev.target)?.closest?.("[data-sleeve]")?.getAttribute("data-sleeve");
      if (key) this.preview(key, ev);
    },
    /** @param {MouseEvent} ev */
    clickRing(ev) {
      const key = /** @type {Element} */ (ev.target)?.closest?.("[data-sleeve]")?.getAttribute("data-sleeve");
      if (key) this.toggle(key);
    },
  };
}
