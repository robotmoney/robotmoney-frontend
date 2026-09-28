// A filter that only hides (RM-138). A row of chips narrows a baked list to
// the items that carry one tag, and "All" brings every item back. Nothing is
// fetched and nothing is re-rendered: every item is in the markup, so a
// reader without JavaScript (an agent, a crawler) gets the whole list, and the
// filter can never come up empty or lose an item.
//
// The changelog's filter (changelogPage in alpine/heroes.js), made reusable
// for the smart contract risks index. Used as x-data="tagFilter()" on the
// view's root:
//   - the filtered items carry data-tags="<tag> <tag>" (space-separated, empty
//     for none) and x-show="has($el)", inside the element named x-ref="filtered";
//   - each chip is :aria-pressed="String(tag === 'x')" @click="toggle('x')",
//     and "All" is toggle('');
//   - `count` and `total` are the items shown and the items there are.
// Only items hide. Anything a link can land on (a record, a heading) must not
// carry x-show here, so every #fragment still resolves while a filter is on.
//
// It lives here and not inline in the view for the reason changelogPage lives
// in heroes.js: an arrow function's ">" closes a naive tag match in an
// HTML-to-text reader and leaks the source into the page's text.

/** @param {Element} el */
function tagsOf(el) {
  return (/** @type {HTMLElement} */ (el).dataset?.tags || "").split(" ").filter(Boolean);
}

export function tagFilter() {
  return {
    /** The tag in force; "" is All. */
    tag: "",
    /** @param {Element} el */
    has(el) {
      return !this.tag || tagsOf(el).includes(this.tag);
    },
    /** A second press on the chip in force, or All, shows everything. @param {string} t */
    toggle(t) {
      this.tag = this.tag === t ? "" : t;
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
  };
}
