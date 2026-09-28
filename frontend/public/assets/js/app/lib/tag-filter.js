// A filter that only hides, and a sort that only moves (RM-138). A row of
// chips narrows a baked list to the items that carry one tag, and "All" brings
// every item back; a sortable column heading reorders the baked rows. Nothing
// is fetched and nothing is re-rendered: every item is in the markup, in the
// page's own order, so a reader without JavaScript (an agent, a crawler) gets
// the whole list, and the filter can never come up empty or lose an item.
//
// The changelog's filter (changelogPage in alpine/heroes.js), made reusable
// for the smart contract risks index. Used as x-data on the view's root:
//   x-data="tagFilter({ sortKey: 'month', sortDir: 'desc', noun: 'exploits' })"
// where sortKey and sortDir name the order the rows are baked in.
//   - the filtered items carry data-tags="<tag> <tag>" (space-separated, empty
//     for none) and x-show="has($el)", inside the element named x-ref="filtered";
//     anything else the filter reaches (a chart's points) binds has($el) too,
//     to fade rather than hide;
//   - each chip is :aria-pressed="String(tag === 'x')" and
//     @click="toggle('x', $el.textContent)", and "All" is toggle('', ...);
//   - a sortable heading is th :aria-sort="sortState('k')" holding
//     button.rr-sort @click="sortBy('k', 'desc', $el.textContent)", where each
//     row carries data-k: numbers compare as numbers, anything else as text
//     ("2026-05" sorts as a month), and the second argument is the order a
//     first click gives. A second click reverses it. Ties keep page order;
//   - each row binds :class="isLast($el) ? 'is-last' : ''", the last row
//     shown in the current order, which draws no closing rule;
//   - `said` is the live region's line: what the last click changed.
// Only items hide. Anything a link can land on (a record, a heading) must not
// carry x-show here, so every #fragment still resolves while a filter is on.
//
// It lives here and not inline in the view for the reason changelogPage lives
// in heroes.js: an arrow function's ">" closes a naive tag match in an
// HTML-to-text reader and leaks the source into the page's text.

/** Each list's rows in the order the page gives them, captured on first use.
 *  @type {WeakMap<Element, Element[]>} */
const PAGE_ORDER = new WeakMap();

/** @param {Element} el */
function tagsOf(el) {
  return (/** @type {HTMLElement} */ (el).dataset?.tags || "").split(" ").filter(Boolean);
}

/** @param {Element} el @param {string} key */
function valueOf(el, key) {
  return /** @type {HTMLElement} */ (el).dataset?.[key] ?? "";
}

/** @param {string} a @param {string} b */
function compare(a, b) {
  const x = Number(a);
  const y = Number(b);
  if (a !== "" && b !== "" && Number.isFinite(x) && Number.isFinite(y)) return x - y;
  return a.localeCompare(b, "en", { sensitivity: "base" });
}

/** @param {{ sortKey?: string; sortDir?: "asc" | "desc"; noun?: string; all?: string }} [opts] */
export function tagFilter(opts = {}) {
  return {
    /** The tag in force; "" is All. */
    tag: "",
    /** The order in force: the row attribute (data-<key>) and its direction. */
    sortKey: opts.sortKey ?? "",
    sortDir: opts.sortDir ?? "desc",
    /** What the live region says: the last change a click made. */
    said: "",
    /** @param {Element} el */
    has(el) {
      return !this.tag || tagsOf(el).includes(this.tag);
    },
    /** A second press on the chip in force, or All, shows everything.
     *  @param {string} t @param {string} [label] the chip's name */
    toggle(t, label = "") {
      this.tag = this.tag === t ? "" : t;
      // Said on every press, the chip's name included, so a switch between two
      // categories with the same count is still a change a screen reader reads.
      this.said = `${this.count} of ${this.total} ${opts.noun ?? "items"}: ${this.tag ? label.trim() : opts.all ?? "All"}`;
    },
    /** @returns {Element[]} */
    items() {
      const root = /** @type {any} */ (this).$refs?.filtered;
      return root ? [...root.querySelectorAll("[data-tags]")] : [];
    },
    get count() {
      return this.items().filter((el) => this.has(el)).length;
    },
    get total() {
      return this.items().length;
    },
    /** The rows in the page's own order, whatever order they are in now.
     *  @returns {Element[]} */
    pageRows() {
      const root = /** @type {Element | undefined} */ (/** @type {any} */ (this).$refs?.filtered);
      if (!root) return [];
      if (!PAGE_ORDER.has(root)) PAGE_ORDER.set(root, this.items());
      return PAGE_ORDER.get(root) ?? [];
    },
    /** The rows in the order in force.
     *  @returns {Element[]} */
    ordered() {
      const key = this.sortKey;
      const sign = this.sortDir === "desc" ? -1 : 1;
      const rows = this.pageRows().map((el, i) => ({ el, i, v: valueOf(el, key) }));
      if (key) rows.sort((a, b) => sign * compare(a.v, b.v) || a.i - b.i);
      return rows.map((r) => r.el);
    },
    /** A heading's aria-sort. @param {string} key */
    sortState(key) {
      return this.sortKey === key ? (this.sortDir === "desc" ? "descending" : "ascending") : "none";
    },
    /** @param {string} key @param {"asc" | "desc"} first @param {string} [label] the heading's name */
    sortBy(key, first, label = "") {
      if (this.sortKey === key) this.sortDir = this.sortDir === "desc" ? "asc" : "desc";
      else {
        this.sortKey = key;
        this.sortDir = first;
      }
      const rows = this.ordered();
      // append() moves each row to the end in turn: the rows keep their
      // bindings, and nothing is rendered twice.
      rows[0]?.parentElement?.append(...rows);
      this.said = `Sorted by ${label.trim()}, ${this.sortDir === "desc" ? "descending" : "ascending"}`;
    },
    /** The last row shown in the order in force: it closes with no rule. @param {Element} el */
    isLast(el) {
      const shown = this.ordered().filter((r) => this.has(r));
      return shown[shown.length - 1] === el;
    },
  };
}
