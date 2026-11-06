// The regime dial that explains itself (lib/regime-dial.js draws it). Point at
// a segment or its name, focus the name, or tap it, and that segment lights
// with a tip at its middle saying what the state means; the current one also
// says where the composite sits today and how the label moves. Escape or a
// tap outside closes it. The model is read through a function, so the dial
// follows its page:
//
//   <div class="rm-dial" x-data="rmRegimeDial(() => ({ percentile, riskOff, riskOn, regime }))"
//        @pointermove="move($event)" @mouseleave="point = null" @click.outside="point = null; pinned = null"
//        @keydown.escape="point = null; pinned = null">
//     <div class="rm-dial__arc" x-ref="arc">
//       <div class="rm-dial__svg" x-html="svg()"></div>
//       <div class="rm-dial__tip" role="tooltip" :id="tipId" :class="{ 'is-open': open }" :style="tipStyle()" :data-side="tipSide()">…tip(at)…</div>
//     </div>
//     <p class="rm-dial__v"><b class="rm-dial__n"><span x-text="reading().n"></span><small x-text="reading().suffix"></small></b>…the regime's name…</p>
//     <template x-for="k in keys" :key="k">
//       <button type="button" class="rm-dial__k" :class="{ 'is-on': lit() === k }" :style="labelAt(k)" :data-at="k"
//               :aria-describedby="shown() === k ? tipId : null" :aria-expanded="shown() === k ? 'true' : 'false'"
//               @mouseenter="point = k" @focus="point = k" @blur="point = null" @click="pin(k)" x-text="tip(k).title"></button>
//     </template>
//   </div>
//
// The tip is always in the page and fades: it opens a beat after the pointer
// arrives (a pass across the dial does not flash it), glides from segment to
// segment while open, and closes a beat after it leaves (a move from a name
// onto the arc does not flicker it). It keeps its last state while it fades
// out, so it never empties mid-fade.
import { DIAL_KEYS, DIAL_LABEL_AT, ordinalParts, regimeDialAt, regimeDialSvg, regimeDialTip, regimeDialTipAt } from "../lib/regime-dial.js";

// The lib's two types, restated: the asset stamper reads a JSDoc type import
// as a module specifier, so one here would break the static build.
/** @typedef {"risk_off" | "neutral" | "risk_on"} DialKey */
/** @typedef {{ percentile: number | null | undefined, riskOff: number, riskOn: number, regime?: string | null }} DialModel */

const OPEN_DELAY_MS = 70;
const CLOSE_DELAY_MS = 120;
let seq = 0;

export function registerRegimeDial(Alpine) {
  Alpine.data("rmRegimeDial", (/** @type {() => DialModel} */ read) => ({
    keys: DIAL_KEYS,
    tipId: `rm-dial-tip-${++seq}`,
    // What the pointer or focus is on, and what a tap pinned open.
    /** @type {DialKey | null} */ point: null,
    /** @type {DialKey | null} */ pinned: null,
    // The tip's state: whether it shows, and the segment it is anchored to.
    open: false,
    /** @type {DialKey} */ at: "neutral",
    /** @type {ReturnType<typeof setTimeout> | null} */ timer: null,

    init() {
      this.$watch("point || pinned", (/** @type {DialKey | null} */ k) => this.settle(k));
    },
    destroy() { if (this.timer) clearTimeout(this.timer); },
    settle(/** @type {DialKey | null} */ k) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      if (k && this.open) { this.at = k; return; }
      if (k) {
        // Anchor first, then open, so a fresh tip fades in where it belongs
        // instead of gliding there from the last one.
        this.timer = setTimeout(() => { this.at = k; requestAnimationFrame(() => { this.open = true; }); }, this.pinned ? 0 : OPEN_DELAY_MS);
        return;
      }
      this.timer = setTimeout(() => { this.open = false; }, CLOSE_DELAY_MS);
    },

    model() { return read(); },
    shown() { return this.point || this.pinned; },
    lit() { return this.shown() || String(this.model()?.regime || "").replace(/-/g, "_"); },
    svg() { return regimeDialSvg({ ...this.model(), focus: this.shown() }); },
    tip(/** @type {DialKey} */ k) { return regimeDialTip(this.model(), k); },
    reading() { return ordinalParts(+(this.model()?.percentile ?? 0)); },
    labelAt(/** @type {DialKey} */ k) { const p = DIAL_LABEL_AT[k]; return `left:${p.left}%;top:${p.top}%`; },
    tipStyle() { const p = regimeDialTipAt(this.model(), this.at); return `left:${p.left.toFixed(2)}%;top:${p.top.toFixed(2)}%`; },
    tipSide() { return regimeDialTipAt(this.model(), this.at).side; },
    // A mouse over the arc lights the segment under it; touch goes by taps.
    move(/** @type {PointerEvent} */ ev) {
      if (ev.pointerType !== "mouse") return;
      const box = this.$refs.arc?.getBoundingClientRect();
      if (!box || !box.width) return;
      const k = regimeDialAt(this.model(), (ev.clientX - box.left) / box.width, (ev.clientY - box.top) / box.height);
      if (k || !(/** @type {HTMLElement} */ (ev.target)).closest?.(".rm-dial__k")) this.point = k;
    },
    pin(/** @type {DialKey} */ k) { this.pinned = this.pinned === k ? null : k; },
  }));
}
