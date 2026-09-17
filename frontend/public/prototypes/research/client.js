import { initTooltips } from "/assets/js/app/lib/tooltip.js";
initTooltips();
import { mountAllocationExplorers } from "/assets/js/app/components/allocation-explorer.js";
mountAllocationExplorers();
// Progressive enhancement: complete records are server-rendered and readable
// without JavaScript. Pagination only limits the visible human reading window.
document.documentElement.classList.add("rr-js");
const lists = [];
for (const root of document.querySelectorAll("[data-list]")) {
  const items = [...root.querySelectorAll("[data-item]")],
    form = root.querySelector("[data-filters]"),
    size = Number(root.dataset.size) || 12;
  let offset = 0;
  function render() {
    const text = form.elements.search.value.trim().toLowerCase(),
      kind = form.elements.kind.value;
    const filtered = items.filter(
      (el) =>
        (kind === "all" || el.dataset.kind === kind) &&
        el.dataset.search.includes(text),
    );
    offset = Math.min(
      offset,
      Math.max(0, Math.floor((filtered.length - 1) / size) * size),
    );
    const visible = new Set(filtered.slice(offset, offset + size));
    for (const item of items) item.hidden = !visible.has(item);
    for (const pager of root.querySelectorAll("[data-pager]")) {
      pager.hidden = items.length <= size && !text && kind === "all";
      pager.querySelector("[data-count]").textContent =
        `${filtered.length ? offset + 1 : 0}–${Math.min(offset + size, filtered.length)} of ${filtered.length}`;
      pager.querySelector("[data-page=previous]").disabled = offset === 0;
      pager.querySelector("[data-page=next]").disabled =
        offset + size >= filtered.length;
    }
    root.querySelector("[data-empty]").hidden = filtered.length !== 0;
  }
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    offset = 0;
    render();
  });
  form.elements.kind.addEventListener("change", () => {
    offset = 0;
    render();
  });
  form.addEventListener("reset", () => {
    requestAnimationFrame(() => {
      offset = 0;
      render();
    });
  });
  root.addEventListener("click", (ev) => {
    const button = ev.target.closest("[data-page]");
    if (!button) return;
    offset += button.dataset.page === "next" ? size : -size;
    render();
    root.scrollIntoView();
    form.elements.search.focus({ preventScroll: true });
  });
  lists.push({
    root,
    show(target) {
      if (!root.contains(target)) return;
      form.elements.search.value = "";
      form.elements.kind.value = "all";
      const index = items.findIndex((x) => x === target || x.contains(target));
      if (index >= 0) {
        offset = Math.floor(index / size) * size;
        render();
      }
    },
  });
  render();
}
function revealHash() {
  let id;
  try {
    id = decodeURIComponent(location.hash.slice(1));
  } catch {
    return;
  }
  if (!id) return;
  const target = document.getElementById(id);
  if (!target) return;
  for (const list of lists) list.show(target);
  if (target.classList.contains("rr-take")) {
    const details = target.querySelector("details");
    if (details) details.open = true;
  }
  requestAnimationFrame(() => target.scrollIntoView());
}
window.addEventListener("hashchange", revealHash);
revealHash();
