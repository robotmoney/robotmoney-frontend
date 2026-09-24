// @ts-nocheck: buildless Alpine factory for the site nav (index.html, RM-124).
//
// One list of links drives both layouts. At 1024px and up each group is a
// button over a full-width panel; below it the same list is a sheet with every
// group open under a heading (CSS alone: the buttons are hidden there). The links are in the served HTML either way, so an agent that
// does not run JavaScript reads the whole site map, and without this factory a
// desktop panel still opens on hover or focus (components.css, .nav:not(.nav--js)).
//
// Desktop behaviour:
// - Hover opens a panel once the pointer rests on its label for the sleeve
//   ring's intent delay, and closes it after the ring's leave grace, so a
//   pointer crossing the bar's hairline into the panel does not drop it.
//   While a panel is open, moving along the bar switches at once.
// - A click (or Enter, or Space) pins a panel open until a second click, Esc,
//   a click outside, focus leaving the nav, or a route change. Esc also
//   closes a panel the pointer opened while focus is elsewhere on the page.
// - The sheet closes on Esc, on a route change, and when focus leaves it.
// - Keys: Left and Right move along the bar, Down opens a panel and enters
//   it, Up and Down move through its links (Up from the first returns to the
//   label), Home and End jump, Esc closes and hands focus back to the label.
//
// The Vaults card and the sheet show each vault's value, read the first time
// either opens, not on every page load. Only a live read shows: a saved
// snapshot or devnet data must be labelled wherever a figure appears, and a
// menu row has no room for the label, so it shows none.
//
// The active section is not tracked here: router.js syncNav() marks it on
// every route change (lib/site-nav.js navSectionFor).
import { INTENT_MS, LEAVE_MS } from "../lib/sleeve-explorer.js";

const WIDE = "(min-width: 1024px)";

export function registerSiteNav(Alpine) {
  Alpine.data("siteNav", () => ({
    open: null,     // the group whose panel is showing (desktop)
    pinned: false,  // opened by click or key: the pointer leaving does not close it
    sheet: false,   // the phone sheet
    wide: true,
    vaultFigures: null, // { total, rmusdc, ... } once a live read lands
    _intent: 0,
    _grace: 0,
    _figuresAsked: false,

    init() {
      const mq = window.matchMedia(WIDE);
      this.wide = mq.matches;
      mq.addEventListener("change", () => {
        this.wide = mq.matches;
        this.close();
        this.setSheet(false);
      });
      // The router fires this once its fragment arrives, on the first load too.
      // On a slow connection that is after a reader has opened a panel, so
      // only a change of page closes it.
      let path = location.pathname;
      window.addEventListener("rm:before-view-change", () => {
        if (location.pathname === path) return;
        path = location.pathname;
        this.close();
        this.setSheet(false);
      });
      document.addEventListener("pointerdown", (e) => {
        if (this.open && !this.$root.contains(e.target)) this.close();
      });
      // Inside the nav, @keydown.escape (onEscape) handles it and returns focus.
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && this.open && !this.$root.contains(document.activeElement)) this.close();
      });
      this.$watch("open", (key) => { if (key === "vaults") this.loadVaultFigures(); });
      this.$root.classList.add("nav--js");
    },

    async loadVaultFigures() {
      if (this._figuresAsked) return;
      this._figuresAsked = true;
      try {
        // Imported here, not at the top: every page loads the nav, and only a
        // reader who opens Vaults needs the vault loader.
        const [{ loadVaultOverview }, { fmtUsd }] = await Promise.all([
          import("../lib/vault-source.js"),
          import("../lib/vault-data.js"),
        ]);
        const load = await loadVaultOverview({ recommendation: false });
        if (!load?.overview || load.error || load.label) return;
        const figures = {};
        for (const v of load.overview.vaults || []) {
          if (v.availability === "not_on_network") figures[v.slug] = "Coming soon";
          else if (v.availability === "live" && v.tvlUsd !== null) figures[v.slug] = fmtUsd(v.tvlUsd);
        }
        const total = load.overview.combined?.tvlUsd;
        if (total !== null && total !== undefined) figures.total = fmtUsd(total);
        this.vaultFigures = figures;
      } catch {
        /* The menu works without its figures. */
      }
    },

    vaultFigure(key) {
      return this.vaultFigures?.[key] || "";
    },

    isOpen(key) {
      return this.open === key;
    },

    enter(key, e) {
      if (!this.wide || e.pointerType !== "mouse") return;
      clearTimeout(this._grace);
      clearTimeout(this._intent);
      if (this.open === key) return;
      if (this.open) {
        // Moving along the bar hands over to hover: the next click on this
        // label pins it rather than closing what the pointer just opened.
        this.open = key;
        this.pinned = false;
        return;
      }
      this._intent = setTimeout(() => {
        this.open = key;
        this.pinned = false;
      }, INTENT_MS);
    },

    leave(key, e) {
      if (!this.wide || e.pointerType !== "mouse") return;
      clearTimeout(this._intent);
      if (this.pinned || this.open !== key) return;
      clearTimeout(this._grace);
      this._grace = setTimeout(() => {
        if (this.open === key && !this.pinned) this.open = null;
      }, LEAVE_MS);
    },

    toggle(key) {
      if (!this.wide) return;
      clearTimeout(this._intent);
      clearTimeout(this._grace);
      if (this.open === key && this.pinned) {
        this.open = null;
        this.pinned = false;
      } else {
        this.open = key;
        this.pinned = true;
      }
    },

    close(focusKey) {
      clearTimeout(this._intent);
      clearTimeout(this._grace);
      this.open = null;
      this.pinned = false;
      if (focusKey) this.topFor(focusKey)?.focus();
    },

    setSheet(on) {
      this.sheet = on;
      if (on) this.loadVaultFigures();
      document.documentElement.classList.toggle("nav-sheet-open", on);
    },

    toggleSheet() {
      this.setSheet(!this.sheet);
    },

    tops() {
      return [...this.$root.querySelectorAll(".nav__top")];
    },

    topFor(key) {
      return this.$root.querySelector(`.nav__group[data-nav-section="${key}"] > .nav__top`);
    },

    linksIn(key) {
      return [...this.$root.querySelectorAll(`.nav__group[data-nav-section="${key}"] .nav__panel a`)];
    },

    onTopKey(e) {
      if (!this.wide) return;
      const tops = this.tops();
      const i = tops.indexOf(e.currentTarget);
      const key = e.currentTarget.closest(".nav__group")?.dataset.navSection;
      const go = (j) => {
        e.preventDefault();
        this.close();
        tops[(j + tops.length) % tops.length].focus();
      };
      switch (e.key) {
        case "ArrowRight": return go(i + 1);
        case "ArrowLeft": return go(i - 1);
        case "Home": return go(0);
        case "End": return go(tops.length - 1);
        case "ArrowDown": {
          const links = this.linksIn(key);
          if (!links.length) return;
          e.preventDefault();
          clearTimeout(this._intent);
          clearTimeout(this._grace);
          this.open = key;
          this.pinned = true;
          this.$nextTick(() => links[0].focus());
          return;
        }
      }
    },

    onPanelKey(e, key) {
      if (!this.wide) return;
      const links = this.linksIn(key);
      const i = links.indexOf(document.activeElement);
      const go = (j) => {
        e.preventDefault();
        links[(j + links.length) % links.length].focus();
      };
      switch (e.key) {
        case "ArrowDown": return go(i + 1);
        case "ArrowUp":
          if (i <= 0) {
            e.preventDefault();
            this.topFor(key)?.focus();
            return;
          }
          return go(i - 1);
        case "Home": return go(0);
        case "End": return go(links.length - 1);
      }
    },

    onEscape() {
      if (this.sheet) {
        this.setSheet(false);
        this.$root.querySelector(".nav__toggle")?.focus();
      } else if (this.open) {
        this.close(this.open);
      }
    },

    onFocusOut(e) {
      if (this.$root.contains(e.relatedTarget)) return;
      if (this.open) this.close();
      // Tab past the sheet's last link: the page behind it is what takes focus.
      if (this.sheet && e.relatedTarget) this.setSheet(false);
    },

    // Following any link closes the panel and the sheet. A route change does
    // that too, but a link to a section of the page being read (the swarm's
    // members, from the swarm page) changes no route.
    onClick(e) {
      if (!e.target.closest?.("a")) return;
      this.close();
      this.setSheet(false);
    },
  }));
}
