// Dash UI primitives — issue #379, docs/bot-analytics-ui-port-plan.md §8 D1 /
// work item P0.2. Hand-rolled Alpine.data factories + one Alpine.directive
// standing in for the ~13 shadcn/Radix primitives the retired
// robotmoney-bot-analytics app imported (Tabs, Tooltip, Dialog, Sheet,
// Select, Switch, ToggleGroup, Progress, Skeleton, ScrollArea, Toast). No
// React/Radix here (buildless invariant) — dash.css supplies the pixels,
// these factories supply just enough behavior for Alpine's x-data/x-show to
// drive them. Sibling to heroes.js/substrate.js: registered once at boot
// (main.js), not per-view, since every future dashboard fragment reuses the
// same handful of factories.
//
// Copy-button is NOT here: it reuses the site-wide delegated `data-copy`
// click handler main.js already wires at boot (see main.js's bottom
// listener) — dash.css's `.a3-copy-btn` only supplies the pixels for that
// same attribute-driven element, so there is nothing dashboard-specific to
// register.

export function registerDashUi(Alpine) {
  // Tabs / pills (also backs ToggleGroup's plain "one active id" case —
  // period pickers just use `a3ToggleGroup` for the segmented-control class
  // hook, the state shape is identical).
  Alpine.data("a3Tabs", (initial = "") => ({
    active: initial,
    select(id) {
      this.active = id;
    },
    isActive(id) {
      return this.active === id;
    },
  }));

  Alpine.data("a3ToggleGroup", (initial = "") => ({
    active: initial,
    select(id) {
      this.active = id;
    },
    isActive(id) {
      return this.active === id;
    },
  }));

  // Dialog (centered modal). Backdrop click-to-close and Escape-to-close are
  // wired in markup (`@click.self="hide()"`, `@keydown.escape.window="hide()"`)
  // rather than imperative listeners here, so Alpine's own element-removal
  // teardown cleans them up for free when the router swaps fragments — no
  // leaked window listener to manage across navigations.
  Alpine.data("a3Dialog", () => ({
    open: false,
    show() {
      this.open = true;
    },
    hide() {
      this.open = false;
    },
    toggle() {
      this.open = !this.open;
    },
  }));

  // Sheet (right slide-over). `size` picks the `.a3-sheet`/`.a3-sheet--xl`
  // width class in markup (sm:max-w-md vs sm:max-w-xl in the original).
  Alpine.data("a3Sheet", (size = "md") => ({
    open: false,
    size,
    show() {
      this.open = true;
    },
    hide() {
      this.open = false;
    },
  }));

  // Select (custom listbox). `options` is `{value, label}[]`.
  Alpine.data("a3Select", (options = [], value = null) => ({
    open: false,
    options,
    value,
    label() {
      const found = this.options.find((o) => o.value === this.value);
      return found ? found.label : "Select…";
    },
    choose(v) {
      this.value = v;
      this.open = false;
    },
    toggle() {
      this.open = !this.open;
    },
    close() {
      this.open = false;
    },
  }));

  // Switch.
  Alpine.data("a3Switch", (checked = false) => ({
    checked,
    toggle() {
      this.checked = !this.checked;
    },
  }));

  // Toast — a store (not per-component data) since any fragment anywhere
  // should be able to push a toast; one host component renders the
  // viewport. Matches the sonner look, not radix's separate toaster (§4.5:
  // the dual-toast-system drop — one helper, one stack).
  Alpine.store("a3Toast", {
    items: [],
    push(message, tone = "default", ttlMs = 4000) {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      this.items.push({ id, message, tone });
      setTimeout(() => this.dismiss(id), ttlMs);
      return id;
    },
    dismiss(id) {
      this.items = this.items.filter((t) => t.id !== id);
    },
  });

  // Tooltip (hover + focus, plain or rich-content). One directive instance
  // per trigger element: `<span x-a3-tooltip="'Label text'">`. The bubble is
  // appended to <body> (fixed-position, follows scroll) rather than as a
  // sibling, so it never gets clipped by an ancestor's overflow:hidden/auto
  // (tables, scroll-areas, sheets). `cleanup()` is Alpine's own per-directive
  // teardown hook — it fires when the router removes this element, so a
  // stray bubble or a leaked scroll listener can't survive a view change.
  Alpine.directive("a3-tooltip", (el, { expression }, { evaluateLater, cleanup }) => {
    const getContent = expression ? evaluateLater(expression) : null;
    let bubble = null;

    const position = () => {
      if (!bubble) return;
      const r = el.getBoundingClientRect();
      bubble.style.left = `${r.left + r.width / 2}px`;
      bubble.style.top = `${r.top - 8}px`;
    };

    const show = () => {
      if (!getContent) return;
      getContent((content) => {
        if (!content) return;
        if (bubble) bubble.remove();
        bubble = document.createElement("div");
        bubble.className = "a3-tooltip-bubble";
        bubble.setAttribute("role", "tooltip");
        bubble.textContent = String(content);
        document.body.appendChild(bubble);
        position();
      });
    };
    const hide = () => {
      bubble?.remove();
      bubble = null;
    };
    const onKeydown = (e) => {
      if (e.key === "Escape") hide();
    };

    if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "0");
    el.addEventListener("mouseenter", show);
    el.addEventListener("mouseleave", hide);
    el.addEventListener("focus", show);
    el.addEventListener("blur", hide);
    el.addEventListener("keydown", onKeydown);
    window.addEventListener("scroll", position, true);

    cleanup(() => {
      hide();
      el.removeEventListener("mouseenter", show);
      el.removeEventListener("mouseleave", hide);
      el.removeEventListener("focus", show);
      el.removeEventListener("blur", hide);
      el.removeEventListener("keydown", onKeydown);
      window.removeEventListener("scroll", position, true);
    });
  });
}
