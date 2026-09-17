// Shared allocation composition and sleeve drill-down. Percentages in `values`
// are of the whole allocation; `within` values are fractions of their sleeve.
import {
  esc,
  sleeves,
  percent,
  num,
  mark,
  delta,
  conceptTip,
} from "./research.js";

export function donutPaths(values) {
  if (
    !Array.isArray(values) ||
    values.length !== 4 ||
    values.some((v) => !Number.isFinite(v) || v < 0) ||
    Math.abs(values.reduce((a, b) => a + b, 0) - 100) > 0.02
  )
    return [];
  let start = -Math.PI / 2;
  const point = (r, a) => `${120 + r * Math.cos(a)},${120 + r * Math.sin(a)}`;
  return values.map((value) => {
    const end = start + (value / 100) * Math.PI * 2;
    let path = "";
    if (value === 100)
      path =
        "M120,18 A102,102 0 1 1 120,222 A102,102 0 1 1 120,18 M120,54 A66,66 0 1 0 120,186 A66,66 0 1 0 120,54 Z";
    else if (value > 0)
      path = `M${point(102, start)} A102,102 0 ${value > 50 ? 1 : 0} 1 ${point(102, end)} L${point(66, end)} A66,66 0 ${value > 50 ? 1 : 0} 0 ${point(66, start)} Z`;
    start = end;
    return path;
  });
}

export function sleeveAssets(within, bucket, weight) {
  return Object.entries(within || {})
    .filter(([, v]) => Number.isFinite(v) && v >= 0 && v <= 1)
    .map(([id, fraction]) => ({
      id,
      name: bucket?.items?.find((item) => item.id === id)?.name || id,
      sleeve: fraction * 100,
      allocation: Number.isFinite(weight) ? fraction * weight : null,
    }));
}

export function allocationExplorer({
  id,
  values,
  within = {},
  buckets = [],
  reference = null,
  variant = "donut",
}) {
  const paths = donutPaths(values);
  if (!paths.length)
    return '<p class="rr-muted">A complete allocation mix is unavailable.</p>';
  const panels = sleeves
    .map((s, i) => {
      const assets = sleeveAssets(
        within[s.key],
        buckets.find((b) => b.id === s.key),
        values[i],
      );
      const rows = assets
        .map(
          (a) =>
            `<tr><th scope="row">${esc(a.name)}</th><td>${percent(a.sleeve)}</td><td>${percent(a.allocation)}</td></tr>`,
        )
        .join("");
      return `<section class="ae-panel" id="${esc(id)}-sleeve-${i}" data-sleeve-panel="${i}" aria-label="${esc(s.name)} breakdown"><div class="ae-panel-heading"><h4>${mark(s)}${s.name}</h4><span>${percent(values[i])} of allocation</span></div>${values[i] === 0 ? '<p class="rr-note">No allocation proposed. The internal mix below is conditional.</p>' : ""}${assets.length ? `<div class="ae-asset-scroll" tabindex="0" role="region" aria-label="${esc(s.name)} assets"><table class="rr-table ae-assets"><caption class="rr-sr">Proposed assets in ${esc(s.name)}</caption><thead><tr><th scope="col">Asset</th><th scope="col">${conceptTip("within", `${id}-within-${i}`, { label: "% of sleeve" })}</th><th scope="col">% of allocation</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="rr-note">Asset-level recommendations were not published for this sleeve.</p>'}</section>`;
    })
    .join("");
  const marks =
    variant === "bar"
      ? `<div class="ae-bar" role="img" aria-label="Recommended allocation composition">${sleeves.map((s, i) => (values[i] > 0 ? `<span data-sleeve="${i}" data-mark="series" style="width:${values[i]}%;background:${s.color}"></span>` : "")).join("")}</div>`
      : `<div class="ae-ring"><svg viewBox="0 0 240 240" role="img" aria-label="Recommended allocation: ${esc(sleeves.map((s, i) => `${s.name} ${percent(values[i])}`).join(", "))}">${paths.map((d, i) => (d ? `<path d="${d}" fill="${sleeves[i].color}" fill-rule="evenodd" data-sleeve="${i}" data-mark="series"/>` : "")).join("")}</svg><div class="ae-center" aria-hidden="true"><b data-center-value>100%</b><span data-center-label>Recommended<br>allocation</span></div></div>`;
  return `<div class="ae ae--${variant === "bar" ? "bar" : "donut"}" data-allocation-explorer><div class="ae-overview">${marks}<div class="ae-legend" aria-label="Allocation sleeves">${sleeves.map((s, i) => `<button type="button" data-sleeve="${i}" data-weight="${num(values[i])}" data-name="${esc(s.short)}" aria-controls="${esc(id)}-sleeve-${i}" aria-expanded="false">${mark(s)}<span>${s.name}</span><b>${percent(values[i])}</b>${reference ? `<small>${delta(values[i], reference[i])}</small>` : ""}</button>`).join("")}</div></div><p class="ae-hint"><span class="ae-pointer-hint">Hover to explore. </span>Select a sleeve to keep its breakdown open.${reference ? ` Changes in ${conceptTip("pp", `${id}-pp`, { label: "percentage points" })} vs the ${conceptTip("reference", `${id}-reference`, { label: "session reference" })}.` : ""}</p><div class="ae-inspector"><button class="ae-close" type="button" data-clear-sleeve aria-label="Close sleeve breakdown" hidden>Close ×</button>${panels}</div><span class="rr-sr" data-explorer-status role="status"></span></div>`;
}

// No framework or route knowledge. Each instance owns only its own DOM.
export function mountAllocationExplorers(scope = document) {
  for (const root of scope.querySelectorAll("[data-allocation-explorer]")) {
    if (root.dataset.enhanced) continue;
    root.dataset.enhanced = "true";
    const buttons = [...root.querySelectorAll(".ae-legend button")],
      panels = [...root.querySelectorAll("[data-sleeve-panel]")],
      close = root.querySelector("[data-clear-sleeve]");
    let pinned = null,
      active = null;
    function show(index, announce = false) {
      active = index;
      root.classList.toggle("ae-active", index !== null);
      for (const panel of panels)
        panel.hidden = Number(panel.dataset.sleevePanel) !== index;
      for (const button of buttons) {
        const selected = Number(button.dataset.sleeve) === index;
        button.setAttribute("aria-expanded", String(selected));
        button.classList.toggle("is-active", selected);
      }
      for (const mark of root.querySelectorAll("[data-mark][data-sleeve]"))
        mark.classList.toggle(
          "is-muted",
          index !== null && Number(mark.dataset.sleeve) !== index,
        );
      close.hidden = index === null;
      const value = root.querySelector("[data-center-value]"),
        label = root.querySelector("[data-center-label]");
      if (value)
        value.textContent =
          index === null ? "100%" : buttons[index].dataset.weight + "%";
      if (label)
        label.textContent =
          index === null
            ? "Recommended allocation"
            : buttons[index].dataset.name;
      if (announce)
        root.querySelector("[data-explorer-status]").textContent =
          index === null
            ? "Sleeve breakdown closed"
            : `${buttons[index].dataset.name}, ${buttons[index].dataset.weight}% of allocation`;
    }
    root.addEventListener("pointerover", (event) => {
      if (event.pointerType === "touch" || pinned !== null) return;
      const mark = event.target.closest("[data-sleeve]");
      if (mark) show(Number(mark.dataset.sleeve));
    });
    root.addEventListener("pointerleave", () => {
      if (pinned === null && !root.contains(document.activeElement)) show(null);
    });
    root.addEventListener("focusin", (event) => {
      const button = event.target.closest(".ae-legend button");
      if (button) {
        const index = Number(button.dataset.sleeve);
        if (pinned !== index) pinned = null;
        show(index, true);
      }
    });
    root.addEventListener("focusout", (event) => {
      if (!root.contains(event.relatedTarget) && pinned === null) show(null);
    });
    root.addEventListener("click", (event) => {
      const mark = event.target.closest("[data-sleeve]");
      if (mark) {
        const index = Number(mark.dataset.sleeve);
        pinned = pinned === index ? null : index;
        show(pinned, true);
      }
      if (event.target.closest("[data-clear-sleeve]")) {
        const previous = active;
        pinned = null;
        if (previous !== null) buttons[previous].focus();
        show(null, true);
      }
    });
    root.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        pinned = null;
        const previous = active;
        if (previous !== null) buttons[previous].focus();
        show(null, true);
      }
    });
    show(null);
  }
}
