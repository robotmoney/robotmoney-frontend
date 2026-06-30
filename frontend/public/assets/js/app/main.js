// SPA shell entry module. Loaded as a <script type="module"> BEFORE the Alpine
// CDN script (document order = execution order), so our `alpine:init` listener
// is registered before Alpine boots and starts processing the DOM. No build
// step, no Web Components — Alpine owns all behavior and lifecycle.
import { registerSubstrate } from "./alpine/substrate.js";
import { registerViews } from "./alpine/views.js";
import { registerHeroes } from "./alpine/heroes.js";
import { start } from "./router.js";

// Terminal boot animation copy — drives the hero's faux deployment log.
const TERMINAL_LINES = [
  { text: "$ robot-money init --chain base --vault erc4626", delay: 0 },
  { text: "  Deploying vault contract...", delay: 800 },
  { text: "  ✓ Vault deployed at 0x7a3f...b2c1", delay: 1600 },
  { text: "  ✓ Bucket A: Aave/Compound (33%)", delay: 2200 },
  { text: "  ✓ Bucket B: Agent-token trading (33%)", delay: 2800 },
  { text: "  ✓ Bucket C: Revenue liquid tokens (33%)", delay: 3400 },
  { text: "  Launching $ROBOTMONEY on Base...", delay: 4200 },
  { text: "  ✓ LP locked until 2100", delay: 5000 },
  { text: "  ✓ Prop wallet initialized", delay: 5600 },
  { text: "", delay: 6200 },
  { text: "  Ready. Accepting deposits.", delay: 6400 },
];

// Register every Alpine.data factory the views need, before Alpine starts.
document.addEventListener("alpine:init", () => {
  const Alpine = window.Alpine;

  Alpine.data("terminalBoot", () => ({
    lines: TERMINAL_LINES,
    visible: 0,
    start() {
      TERMINAL_LINES.forEach((line, i) => {
        setTimeout(() => {
          this.visible = i + 1;
        }, line.delay + 500);
      });
    },
    lineClass(line) {
      const t = line.text;
      let tone = "term-line--muted";
      if (t.includes("✓")) tone = "term-line--accent";
      else if (t.startsWith("$")) tone = "term-line--cmd";
      else if (t.includes("Ready")) tone = "term-line--ready";
      return `term-line ${tone}${t === "" ? " term-line--blank" : ""}`;
    },
  }));

  registerSubstrate(Alpine);
  registerViews(Alpine);
  registerHeroes(Alpine);
});

// Boot the router once the document is parsed. The router renders the current
// path into #view; Alpine's MutationObserver initializes the injected markup.
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start);
} else {
  start();
}

// Global delegated "copy to clipboard" handler. An element with a
// `data-copy="<text>"` attribute copies that literal text; an element with
// `data-copy-code` copies the textContent of the <pre> in its closest
// `.docs-codeblock`. Both show transient "Copied!" feedback. Registered once at
// boot so it works for router-injected views (whose inline scripts never run).
document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-copy], [data-copy-code]");
  if (!btn) return;
  let text;
  if (btn.hasAttribute("data-copy")) {
    text = btn.getAttribute("data-copy");
  } else {
    const pre = btn.closest(".docs-codeblock")?.querySelector("pre");
    text = pre ? pre.textContent : "";
  }
  const done = () => {
    const label = btn.querySelector("[data-copy-label]") || btn;
    const prev = label.textContent;
    label.textContent = btn.getAttribute("data-copied-text") || "Copied!";
    btn.classList.add("is-copied");
    setTimeout(() => { label.textContent = prev; btn.classList.remove("is-copied"); }, 2000);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(done);
  } else {
    const ta = document.createElement("textarea");
    ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); } catch (_) {}
    document.body.removeChild(ta); done();
  }
});
