// Tabs for the hosted proposals: each tab frames its proposal's own page.
const LINES = {"prism":"Many models as beams of light, one crystal, one allocation split across the assets.","murmuration":"Swarm intelligence as nature does it: no leader, one shape, streams to the assets.","monument":"Lex's direction at full scale: the mark as a monument, its cut lit by the swarm. Render or real-time 3D."};
const tabs = [...document.querySelectorAll(".tab")];
function show(slug, push) {
  if (!LINES[slug]) slug = tabs[0].dataset.slug;
  for (const t of tabs) {
    const on = t.dataset.slug === slug;
    t.setAttribute("aria-selected", String(on));
    t.tabIndex = on ? 0 : -1;
    const f = document.getElementById("panel-" + t.dataset.slug);
    if (on && !f.getAttribute("src")) f.src = "./" + t.dataset.slug + "/";
    f.hidden = !on;
  }
  document.getElementById("line").textContent = LINES[slug];
  if (push) history.replaceState(null, "", "#" + slug);
}
tabs.forEach((t, i) => {
  t.addEventListener("click", () => show(t.dataset.slug, true));
  t.addEventListener("keydown", (e) => {
    const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!d) return;
    const n = tabs[(i + d + tabs.length) % tabs.length];
    n.focus(); show(n.dataset.slug, true);
  });
});
addEventListener("hashchange", () => show(location.hash.slice(1)));
show(location.hash.slice(1));
