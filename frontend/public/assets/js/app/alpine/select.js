// The site's select: a button that opens a listbox drawn as the nav's dropdown
// card (.rm-select in components.css). A native <select> opens a menu the
// operating system draws, which no stylesheet reaches.
//
// The options are written in the page as <li role="option" data-value="…">,
// so a reader without JavaScript sees them. Bind the value with x-modelable:
//
//   <div class="rm-select" x-data="rmSelect('Choose one')" x-modelable="value" x-model="draft.kind">
//
// It dispatches `rm-select-change` once the bound value has moved. Keyboard
// follows the WAI-ARIA listbox pattern: arrows, Home/End, Enter or Space to
// choose, Escape to close, and typing a letter jumps to the option it starts.

export function registerSelect(Alpine) {
  Alpine.data("rmSelect", (placeholder = "Choose one") => ({
    value: "",
    open: false,
    active: -1,
    placeholder,
    options: [],
    uid: Math.random().toString(36).slice(2, 8),

    init() {
      const list = this.$root.querySelector("[role=listbox]");
      this.options = [...list.querySelectorAll("[role=option]")].map((el, i) => {
        el.id = `rms-${this.uid}-${i}`;
        el.addEventListener("click", () => this.choose(i));
        el.addEventListener("pointermove", () => { this.active = i; });
        return { value: el.dataset.value, label: el.textContent.trim(), el };
      });
      this.$watch("value", () => this.mark());
      this.$watch("active", () => this.mark());
      this.mark();
    },

    // aria-selected and the active row live on the page's own <li>s.
    mark() {
      this.options.forEach((o, i) => {
        o.el.setAttribute("aria-selected", String(o.value === this.value));
        o.el.classList.toggle("is-active", i === this.active);
      });
      // Keep the active row in view by scrolling the list only, never the page.
      const el = this.open ? this.options[this.active]?.el : null;
      const list = el?.parentElement;
      if (el && list) {
        if (el.offsetTop < list.scrollTop) list.scrollTop = el.offsetTop;
        else if (el.offsetTop + el.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = el.offsetTop + el.offsetHeight - list.clientHeight;
      }
    },

    index() { return this.options.findIndex((o) => o.value === this.value); },
    label() { return this.options[this.index()]?.label || ""; },
    activeId() { return this.open ? this.options[this.active]?.el.id || "" : ""; },

    show(at) {
      this.open = true;
      this.active = at ?? Math.max(0, this.index());
      this.$nextTick(() => this.$root.querySelector("[role=listbox]").focus());
    },
    close(refocus = true) {
      if (!this.open) return;
      this.open = false;
      if (refocus) this.$root.querySelector("button").focus();
    },
    toggle() { this.open ? this.close() : this.show(); },

    choose(i) {
      const o = this.options[i];
      if (!o) return;
      this.value = o.value;
      this.close();
      this.$nextTick(() => this.$dispatch("rm-select-change", { value: o.value }));
    },

    onButtonKey(e) {
      // Keys typed before focus has moved into the open list still steer it.
      if (this.open) return this.onListKey(e);
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) {
        e.preventDefault();
        const i = this.index();
        this.show(e.key === "ArrowUp" ? (i < 0 ? this.options.length - 1 : i) : Math.max(0, i));
      }
    },

    onListKey(e) {
      const n = this.options.length;
      const go = (i) => { e.preventDefault(); this.active = (i + n) % n; };
      switch (e.key) {
        case "ArrowDown": return go(this.active + 1);
        case "ArrowUp": return go(this.active - 1);
        case "Home": return go(0);
        case "End": return go(n - 1);
        case "Enter": case " ": e.preventDefault(); return this.choose(this.active);
        case "Escape": e.preventDefault(); return this.close();
        case "Tab": return this.close(false);
        default:
          if (e.key.length === 1) {
            const k = e.key.toLowerCase();
            const from = this.active + 1;
            for (let s = 0; s < n; s++) {
              const i = (from + s) % n;
              if (this.options[i].label.toLowerCase().startsWith(k)) return go(i);
            }
          }
      }
    },
  }));
}
