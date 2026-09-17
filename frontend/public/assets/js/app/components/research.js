// @ts-nocheck — buildless DOM rendering; contract and behavior are validated by research tests.
// Shared, server/browser-safe research components. Inputs are data, never HTML.
import { STANCE_COLORS, stanceColor } from "../lib/stance.js";
import { memberLogo } from "../lib/member-logos.js";
import { CATEGORICAL } from "../lib/chart-theme.js";
export const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export const sleeves = [
  ["conservative_defi_yield", "Conservative DeFi Yield", "DeFi yield"],
  ["agent_tokens", "Agent Tokens", "Agent tokens"],
  ["protocol_tokens", "Protocol Tokens", "Protocol tokens"],
  ["real_world_assets", "Real World Assets", "Real-world assets"],
].map(([key, name, short], i) => ({ key, name, short, color: CATEGORICAL[i] }));
export const num = (n, d = 2) =>
  Number.isFinite(n)
    ? n.toLocaleString("en-US", { maximumFractionDigits: d })
    : "Unavailable";
export const percent = (n) =>
  Number.isFinite(n) ? num(n) + "%" : "Unavailable";
export const date = (d) =>
  d
    ? new Date(d).toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
        timeZone: "UTC",
      })
    : "Date unavailable";
export function stance(value, { compact = false } = {}) {
  const key = String(value ?? "").toLowerCase(),
    known = Object.hasOwn(STANCE_COLORS, key);
  const label = known
    ? key
    : value
      ? "Unrecognized stance"
      : "Stance unavailable";
  return `<span class="rr-stance${compact ? " rr-stance--compact" : ""}" style="--stance:${stanceColor(key)}"${!known && value ? ` title="Source value: ${esc(value)}"` : ""}><i aria-hidden="true"></i>${esc(label)}</span>`;
}
export function delta(a, b, { unit = true } = {}) {
  if (!Number.isFinite(a) || !Number.isFinite(b))
    return '<span class="rr-muted">Unavailable</span>';
  const d = a - b;
  return Math.abs(d) < 0.005
    ? '<span class="rr-muted">0' + (unit ? " pp" : "") + "</span>"
    : `<span class="rr-delta ${d > 0 ? "rr-delta--up" : "rr-delta--down"}">${d > 0 ? "▲ +" : "▼ −"}${num(Math.abs(d))}${unit ? " pp" : ""}</span>`;
}
export function mark(s) {
  return `<i class="rr-key" data-mark="series" style="background:${s.color}" aria-hidden="true"></i>`;
}
export function composition(values) {
  if (!values) return '<p class="rr-muted">Structured weights unavailable.</p>';
  return `<div class="rr-composition" role="img" aria-label="${esc(sleeves.map((s, i) => `${s.name}: ${percent(values[i])}`).join("; "))}">${sleeves.map((s, i) => `<span data-mark="series" style="width:${values[i]}%;background:${s.color}"></span>`).join("")}</div>`;
}
export function weightTable(values, reference = null) {
  return `<div class="rr-table-scroll" tabindex="0" role="region" aria-label="Allocation weights"><table class="rr-table rr-weights${reference ? " rr-weights--comparison" : ""}"><caption class="rr-sr">Recommended sleeve weights${reference ? " compared with the session reference" : ""}</caption><thead><tr><th scope="col">Sleeve</th>${reference ? '<th scope="col">Reference</th>' : ""}<th scope="col">Recommended</th>${reference ? '<th scope="col">Change <small>(pp)</small></th>' : ""}</tr></thead><tbody>${sleeves.map((s, i) => `<tr><th scope="row">${mark(s)}${s.name}</th>${reference ? `<td><span class="rr-cell-label" aria-hidden="true">Reference</span>${percent(reference[i])}</td>` : ""}<td><span class="rr-cell-label" aria-hidden="true">Proposed</span><b>${percent(values?.[i])}</b></td>${reference ? `<td><span class="rr-cell-label" aria-hidden="true">Change (pp)</span>${delta(values?.[i], reference[i], { unit: false })}</td>` : ""}</tr>`).join("")}</tbody></table></div>`;
}
export function excerpt(text, max = 240) {
  const s = String(text ?? "")
    .replace(/\*\*/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (s.length <= max) return s;
  const part = s.slice(0, max),
    at = part.lastIndexOf(" ");
  return part.slice(0, at > 0 ? at : max) + "…";
}
// Minimal safe archive formatting: headings, paragraphs, bullets and internal
// citations. Escape first; no raw HTML or untrusted link protocols are accepted.
export function prose(text) {
  const inline = (s) =>
    esc(s)
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(
        /(^|[\s(])(\/(?:blog\/|smart-contract-risks)[a-z0-9/_-]*)/g,
        '$1<a href="$2">$2</a>',
      );
  return String(text ?? "")
    .split(/\n\s*\n/)
    .filter(Boolean)
    .map((block) => {
      const lines = block.split("\n"),
        out = [];
      let list = false;
      for (const line of lines) {
        if (/^[-*] /.test(line)) {
          if (!list) {
            out.push("<ul>");
            list = true;
          }
          out.push(`<li>${inline(line.slice(2))}</li>`);
        } else {
          if (list) {
            out.push("</ul>");
            list = false;
          }
          out.push(
            /^\*\*[^*]+\*\*$/.test(line.trim())
              ? `<h4>${inline(line.replace(/\*\*/g, ""))}</h4>`
              : `<p>${inline(line)}</p>`,
          );
        }
      }
      if (list) out.push("</ul>");
      return out.join("");
    })
    .join("");
}
export function longText(
  text,
  { label = "Read full explanation", limit = 520 } = {},
) {
  if (!text) return '<p class="rr-muted">Not published.</p>';
  if (text.length <= limit) return `<div class="rr-prose">${prose(text)}</div>`;
  return `<div class="rr-long"><p class="rr-excerpt">${esc(excerpt(text, limit))}</p><details class="rr-disclosure"><summary>${esc(label)} <span class="rr-muted">${String(text).trim().split(/\s+/).length} words</span></summary><div class="rr-prose">${prose(text)}</div></details></div>`;
}
export function identity(t) {
  const logo = memberLogo({ handle: t.memberHandle || (t.memberId === "robotmoney" ? "robot-money" : t.memberId) });
  return `<span class="rr-identity">${logo ? `<img src="${logo}" alt="" width="32" height="32">` : ""}<span><b>${esc(t.name)}</b><small>${esc(t.lens || "Analyst")}</small></span></span>`;
}
export function sourceNote(mode) {
  return `<p class="rr-source">${mode === "live" ? "Recommendations are research records. Published policy and observed vault holdings are separate." : mode === "stress" ? "Scale test: 12 synthetic analysts and 96 simulated sessions. Archived prose is replayed; dates and weights are illustrative." : "Historical archive · June 2026. Recommendations are published research, not evidence of execution."}</p>`;
}

// Definitions belong to the concept, not an individual page. Keep to 1-2
// sentences. Never hide a decision-critical value or state in a tooltip.
export const CONCEPTS = {
  sleeve: [
    "Allocation sleeve",
    "A portion of the allocation with its own investment mandate, such as DeFi yield or agent tokens.",
  ],
  reference: [
    "Session reference",
    "The allocation weights supplied when this session began. A historical recommendation is compared with that reference, not today’s policy.",
  ],
  pp: [
    "Percentage points",
    "The arithmetic difference between two percentages. Moving from 5% to 3% is a decrease of 2 percentage points.",
  ],
  conviction: [
    "Analyst conviction",
    "The analyst’s self-reported confidence in its view. It is not a probability of return or a weight in the allocation.",
  ],
  within: [
    "Share of sleeve",
    "The asset’s share inside one sleeve. For example, 35% of a 95% sleeve is 33.25% of the whole allocation.",
  ],
};
export function conceptTip(key, id, { label = null } = {}) {
  const concept = CONCEPTS[key];
  if (!concept) throw new Error(`Unknown research concept: ${key}`);
  return `<span class="rm-tip${label ? " rm-tip--label" : ""}" data-concept-tip><button type="button" class="rm-tip__btn${label ? " rm-tip__btn--text" : ""}" aria-label="About ${esc(concept[0].toLowerCase())}" aria-describedby="${esc(id)}">${label ? esc(label) : "?"}</button><span class="rm-tip__bub" id="${esc(id)}" role="tooltip">${esc(concept[1])}</span></span>`;
}
