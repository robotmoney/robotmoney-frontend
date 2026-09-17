import { allocationExplorer } from "../../assets/js/app/components/allocation-explorer.js";
import {
  esc as e,
  sleeves,
  num,
  percent,
  date,
  stance,
  delta,
  mark,
  composition,
  weightTable,
  excerpt,
  prose,
  longText,
  identity,
  sourceNote,
  conceptTip,
} from "../../assets/js/app/components/research.js";
import { SWARM_DISCLAIMER } from "../../assets/js/app/lib/swarm-disclaimer.js";
export const subjectPath = "/swarm/subjects/robotmoney-allocation";
export const sessionPath = (r) =>
  r.mode === "stress"
    ? `/swarm/sessions/${r.id}?data=stress`
    : `/swarm/${r.date}/robotmoney-allocation`;
const query = (mode) => (mode === "stress" ? "?data=stress" : "");
const changed = (r) =>
  r.reference && r.weights
    ? r.weights.filter((v, i) => Math.abs(v - r.reference[i]) > 0.005).length
    : null;
const outcome = (r) =>
  changed(r) == null
    ? "Reference unavailable"
    : changed(r)
      ? `${changed(r)} sleeve changes proposed`
      : "Reference weights retained";
const timing = (r) =>
  r.mode === "stress"
    ? ` · ${new Date(r.date).toISOString().slice(11, 16)} UTC`
    : "";
const conviction = (t) =>
  t.confidence == null ? "Unavailable" : percent(t.confidence * 100);
const jsonLink = (mode) =>
  `?${mode === "stress" ? "data=stress&" : ""}format=json`;
const title = (eyebrow, heading, lede) =>
  `<header class="rr-head"><p class="rr-eyebrow">${eyebrow}</p><h1>${heading}</h1><p class="rr-lede">${lede}</p></header>`;
const section = (n, heading, aside = "") =>
  `<div class="rr-section-head"><div><span class="rr-section-no" aria-hidden="true">${n}</span><h2>${heading}</h2></div>${aside}</div>`;
const provenance = (mode) =>
  `<div class="rr-preview"><span>Local design preview · ${mode === "stress" ? "Simulated scale dataset" : "Original archive records"}</span><a href="${mode === "stress" ? subjectPath : subjectPath + "?data=stress"}">${mode === "stress" ? "Use archived records" : "Test 12 analysts / 96 sessions"}</a><a href="/prototypes/research/components">Component catalogue</a></div>`;
const wrap = (mode, content) =>
  `${provenance(mode)}<article class="rr">${content}<aside class="rr-disclaimer" aria-label="Swarm disclaimer"><p class="rr-eyebrow">Disclaimer</p><p>${e(SWARM_DISCLAIMER)}</p></aside></article>`;
const bread = (items) =>
  `<nav class="rr-breadcrumb" aria-label="Breadcrumb">${items.map(([label, href]) => (href ? `<a href="${e(href)}">${e(label)}</a>` : `<span aria-current="page">${e(label)}</span>`)).join('<span aria-hidden="true">/</span>')}</nav>`;
const reason = (r) =>
  r.mode === "stress"
    ? `<p class="rr-muted">Replayed archived prose. The synthetic weights and text do not represent a real investment decision.</p>${longText(r.rationale, { label: "Read archived rationale" })}`
    : longText(r.rationale, { label: "Read full rationale", limit: 480 });
const referenceNote = (r) =>
  `<p class="rr-note">${r.reference ? `Reference weights are from the brief supplied to this session, policy dated ${date(r.referenceAsOf)}. Changes are percentage points.` : "Session-time reference weights are unavailable. No change from current policy is inferred."}</p>`;
const pager = () =>
  '<nav class="rr-pager" aria-label="Result pages" hidden data-pager><span role="status" data-count></span><div><button type="button" data-page="previous">Previous</button><button type="button" data-page="next">Next</button></div></nav>';
function stances(takes) {
  return `<div class="rr-stances">${Object.keys({
    bearish: 1,
    cautious: 1,
    neutral: 1,
    constructive: 1,
    bullish: 1,
  })
    .map((s) => {
      const count = takes.filter((t) => t.stance === s).length;
      return count
        ? `<span>${stance(s, { compact: true })}<b class="rr-mono">${count}</b></span>`
        : "";
    })
    .join("")}</div>`;
}
function historyRow(r) {
  return `<tr data-item data-search="${e([r.date, r.id, r.rationale].join(" ").toLowerCase())}" data-kind="${changed(r) == null ? "unknown" : changed(r) ? "changed" : "retained"}"><th scope="row"><a class="rr-rowlink" href="${sessionPath(r)}">${date(r.date)}<span aria-hidden="true"> ↗</span></a>${r.mode === "stress" ? `<small>${timing(r).slice(3)}</small>` : ""}<small>${r.takes.length} analyst takes</small></th>${sleeves.map((s, i) => `<td><span class="rr-mobile-label">${s.short}</span>${percent(r.weights?.[i])}</td>`).join("")}<td class="rr-history-outcome">${r.reference && r.weights ? r.weights.map((v, i) => (Math.abs(v - r.reference[i]) > 0.005 ? `<span>${e(sleeves[i].short)} ${delta(v, r.reference[i])}</span>` : "")).join("") || "<span>Reference retained</span>" : "Reference unavailable"}</td></tr>`;
}
export function subjectPage(records, mode) {
  const r = records[0],
    authors = new Set(records.flatMap((x) => x.takes.map((t) => t.memberId)))
      .size;
  return wrap(
    mode,
    `${bread([["Swarm", "/swarm"], ["Allocation research"]])}${title("Flagship allocation · Research record", "Robot Money Allocation", "The swarm reviews the policy that guides capital across Robot Money’s four vault sleeves. Follow its recommendations and the reasoning behind them.")}
<div class="rr-meta"><span>Latest review <b>${date(r.date)}</b></span><span>${mode === "stress" ? "Simulated" : "Archived"} sessions <b>${records.length}</b></span><span>Contributing analysts <b>${authors}</b></span><a class="rr-link" href="/allocation">Allocation & vaults ↗</a></div>${sourceNote(mode)}
<section class="rr-section" aria-labelledby="latest-heading"><div class="rr-section-head"><div><span class="rr-section-no" aria-hidden="true">01</span><h2 id="latest-heading">Latest recommendation ${conceptTip("sleeve", "latest-sleeve")}</h2></div><time datetime="${r.date}">${date(r.date)}</time></div><div class="rr-latest"><div class="rr-latest-weights">${allocationExplorer({ id: "latest-mix", values: r.weights, within: r.within, buckets: r.buckets })}<p class="rr-note">Recommended share of total allocation. Application is not established by this archive.</p></div><div class="rr-latest-reason"><p class="rr-eyebrow">${outcome(r)}</p>${reason(r)}<div class="rr-contributors">${stances(r.takes)}<span class="rr-muted">${r.takes.length} takes</span></div><a class="rr-primary" href="${sessionPath(r)}">Read the ${date(r.date)} session <span aria-hidden="true">→</span></a></div></div></section>
<section class="rr-section" id="history" data-list data-size="12">${section("02", `Recommendation history ${conceptTip("reference", "history-reference")}`, '<span class="rr-muted">Weights recommended by session</span>')}<p class="rr-intro">Compare the proposed mix over time. Each session preserves the views and evidence behind its recommendation.</p><form class="rr-controls" data-filters><label>Search sessions<input type="search" name="search" placeholder="Date or reasoning" aria-label="Search sessions"></label><label>Recommendation<select name="kind"><option value="all">All recommendations</option><option value="changed">Changes proposed</option><option value="retained">Reference retained</option><option value="unknown">Reference unavailable</option></select></label><button type="submit">Search</button><button type="reset" class="rr-reset">Clear</button></form>${pager()}<table class="rr-table rr-history"><caption class="rr-sr">Archived recommended sleeve weights, percent of total allocation. Change compares each recommendation with its own session reference.</caption><thead><tr><th scope="col">Session</th>${sleeves.map((s) => `<th scope="col">${mark(s)}${s.short}<small>% of allocation</small></th>`).join("")}<th scope="col">vs session reference</th></tr></thead><tbody>${records.map(historyRow).join("")}</tbody></table><p class="rr-empty" data-empty hidden>No sessions match. Clear the search or choose another filter.</p>${pager()}<p class="rr-note">“Reference unavailable” means the dated brief is absent. These are recommendations, not returns or a history of executed holdings.</p></section>
<section class="rr-section rr-about">${section("03", "About this record")}<div><p>This is the flagship allocation policy. The swarm proposes how much belongs in each sleeve and which assets belong within it. Other subjects are portfolios or books that receive the swarm’s assessment.</p><p>Vault holdings are separate observations. A published recommendation does not prove that router weights changed or that capital was rebalanced.</p><div class="rr-links"><a href="/allocation">Allocation & vaults ↗</a><a href="${jsonLink(mode)}" type="application/json">Read this record as JSON ↗</a></div></div></section>`,
  );
}
function analyst(t, r) {
  return `<article class="rr-take" id="take-${e(t.id)}" data-item data-search="${e([t.name, t.lens, t.body].join(" ").toLowerCase())}" data-kind="${e(t.stance)}"><div class="rr-take-top"><div>${identity(t)}</div><div>${stance(t.stance)}<span class="rr-confidence">Conviction <b>${conviction(t)}</b></span></div></div><div class="rr-take-main"><div>${longText(t.body, { label: "Read full take", limit: 260 })}</div><aside><p class="rr-eyebrow">Proposed weights</p>${t.weights ? `${composition(t.weights)}<dl class="rr-proposals">${sleeves.map((s, i) => `<div><dt>${mark(s)}${s.short}</dt><dd>${percent(t.weights[i])}</dd></div>`).join("")}</dl>` : '<p class="rr-muted">Structured weights were not recorded. The full take preserves the author’s proposal.</p>'}</aside></div><div class="rr-take-foot"><span>${r.mode === "stress" ? "Synthetic identity · replayed archive text" : "Archived · unsigned"}</span><a href="#take-${e(t.id)}" data-permalink>Link to this take</a>${r.mode === "archive" ? `<a href="/swarm/members/${encodeURIComponent(t.memberId)}">Analyst profile ↗</a>` : ""}</div></article>`;
}
function disagreements(r) {
  return r.disagreements
    .map(
      (d, i) =>
        `<details class="rr-disagreement"><summary><span><small class="rr-eyebrow">Question ${i + 1}</small><b>${e(d.topic)}</b></span><span class="rr-muted">${d.positions?.length || 0} views</span></summary><div class="rr-disagreement-body">${(
          d.positions || []
        )
          .map((p) => {
            const t = r.takes.find((t) => t.memberId === p.member_id);
            return `<div class="rr-position"><div><b>${e(t?.name || p.member_id)}</b>${t ? stance(t.stance, { compact: true }) : "<small>Archived source author</small>"}</div><p>${e(p.view)}</p></div>`;
          })
          .join(
            "",
          )}<div class="rr-resolution"><p class="rr-eyebrow">What would resolve it</p><p>${e(d.what_settles || "No resolution condition recorded.")}</p></div></div></details>`,
    )
    .join("");
}
function marketContext(r) {
  const panels = [
    ["Composite", r.regime.composite_percentile],
    ["Macro", r.regime.macro_percentile],
    ["On-chain", r.regime.onchain_percentile],
    ["Factor", r.regime.factor_percentile],
  ];
  return `<div class="rr-context"><div class="rr-context-head"><p class="rr-eyebrow">Market context</p><span>${date(r.sourceDate || r.date)}</span></div><p class="rr-muted">Recorded regime <b class="rr-neutral-text">${e(String(r.regime.regime || "Unavailable").replaceAll("_", "-"))}</b></p><table class="rr-context-table"><caption>Percentile against each series’ own history</caption><tbody>${panels.map(([label, v]) => `<tr><th scope="row">${label}</th><td><div class="rr-percentile" aria-hidden="true"><span style="width:${Number.isFinite(v) ? v * 100 : 0}%"></span></div></td><td>${Number.isFinite(v) ? num(v * 100, 0) + " / 100" : "Unavailable"}</td></tr>`).join("")}</tbody></table><p class="rr-note">The archived regime label is preserved. No classification thresholds are inferred from these percentiles.</p></div>`;
}
export function sessionPage(r, records) {
  const mode = r.mode,
    index = records.indexOf(r),
    newer = records[index - 1],
    older = records[index + 1];
  return wrap(
    mode,
    `${bread([["Swarm", "/swarm"], ["Allocation research", subjectPath + query(mode)], [date(r.date)]])}${title("Flagship allocation · Published session", "Allocation review", `${date(r.date)}${timing(r)}`)}<div class="rr-meta"><span>Analyst takes <b>${r.takes.length}</b></span><span>Disagreement topics <b>${r.disagreements.length}</b></span><span>Execution <b>Not reported</b></span><a href="${jsonLink(mode)}" type="application/json">Session JSON ↗</a></div>${sourceNote(mode)}
<nav class="rr-sections" aria-label="Session sections"><a href="#recommendation">Recommendation</a><a href="#reasoning">Reasoning</a><a href="#analysts">Analyst takes <span>${r.takes.length}</span></a><a href="#evidence">Evidence</a></nav>
<section class="rr-section" id="recommendation">${section("01", `The recommendation ${conceptTip("sleeve", "session-sleeve")}`)}<div class="rr-outcome"><div><h3 class="rr-outcome-title">${outcome(r)}</h3>${reason(r)}<p class="rr-note">Published research. Execution and current holdings are separate records.</p></div><div>${allocationExplorer({ id: "session-mix", values: r.weights, within: r.within, buckets: r.buckets, reference: r.reference })}<details class="rr-disclosure rr-exact-comparison"><summary>Reference & recommended weights <span class="rr-muted">Full comparison</span></summary>${weightTable(r.weights, r.reference)}${referenceNote(r)}</details></div></div></section>
<section class="rr-section" id="reasoning">${section("02", "Reasoning & disagreement")}<div class="rr-reasoning"><div><h3>Session synthesis</h3>${longText(r.synthesis, { label: "Read full synthesis", limit: 570 })}${r.consensus.length ? `<div class="rr-consensus"><h3>Where analysts agree</h3><ul>${r.consensus.map((c) => `<li>${e(c)}</li>`).join("")}</ul></div>` : ""}</div>${marketContext(r)}</div><div class="rr-disagreements"><h3>Where views differ</h3>${disagreements(r) || '<p class="rr-muted">No disagreement topics were recorded.</p>'}</div></section>
<section class="rr-section" id="analysts" data-list data-size="6">${section("03", "Analyst takes", `<span class="rr-muted">${r.takes.length} contributions</span>`)}<div class="rr-analyst-intro">${stances(r.takes)}<p class="rr-note">${conceptTip("conviction", "analyst-conviction", { label: "Analyst conviction" })}</p></div><form class="rr-controls" data-filters><label>Find an analyst or argument<input type="search" name="search" placeholder="Name, lens or take text"></label><label>Stance<select name="kind"><option value="all">All stances</option>${Object.keys(
      { bearish: 1, cautious: 1, neutral: 1, constructive: 1, bullish: 1 },
    )
      .map((s) => `<option>${s}</option>`)
      .join(
        "",
      )}</select></label><button type="submit">Search</button><button type="reset" class="rr-reset">Clear</button></form>${pager()}<div class="rr-takes">${r.takes.map((t) => analyst(t, r)).join("")}</div><p class="rr-empty" data-empty hidden>No takes match. Clear the search or choose another stance.</p>${pager()}</section>
<section class="rr-section" id="evidence">${section("04", "Evidence & provenance")}<div class="rr-evidence"><div><h3>${mode === "stress" ? "Scale-test fixture" : "Archived, unsigned research"}</h3><p>${mode === "stress" ? "Dates, analyst identities and vectors are synthetic. Original archive passages are deliberately replayed to test long content." : "These takes predate member key registration. They were never member-signed; this is not a failed signature check."}</p><p>No receipt-linked execution evidence is supplied with this record. Application of the recommendation is not confirmed.</p></div><dl><div><dt>Record generated</dt><dd>${e(r.generatedAt || "Unavailable")}</dd></div><div><dt>Reference policy</dt><dd>${r.referenceAsOf ? date(r.referenceAsOf) : "Not available for this session"}</dd></div><div><dt>Original source</dt><dd><a href="${r.source}">Archived session JSON ↗</a></dd></div>${r.brief ? `<div><dt>Session inputs</dt><dd><a href="${r.brief}">Original brief JSON ↗</a></dd></div>` : ""}<div><dt>Readable data</dt><dd><a href="${jsonLink(mode)}">Complete session JSON ↗</a></dd></div></dl></div></section>
<nav class="rr-record-nav" aria-label="Session navigation">${older ? `<a href="${sessionPath(older)}">← ${date(older.date)}${timing(older)}</a>` : "<span>Earliest available session</span>"}<a href="${subjectPath + query(mode)}#history">All allocation sessions</a>${newer ? `<a href="${sessionPath(newer)}">${date(newer.date)}${timing(newer)} →</a>` : "<span>Latest available session</span>"}</nav>`,
  );
}
export function catalogue(example) {
  return `<article class="rr rr--catalogue">${bread([["Allocation research", subjectPath], ["Component catalogue"]])}${title("Shared research components", "One visual language", "These examples use the same rendering functions and styles as both Allocation research pages.")}<section class="rr-section">${section("01", "Stance")}<p>Direction of an analyst’s view. Missing and unknown values are distinct from neutral.</p><div class="rr-catalogue-row">${["bearish", "cautious", "neutral", "constructive", "bullish", null, "undecided"].map((s) => stance(s)).join("")}</div><div class="rr-catalogue-row">${["bearish", "cautious", "neutral", "constructive", "bullish"].map((s) => stance(s, { compact: true })).join("")}</div></section><section class="rr-section">${section("02", "Allocation composition & comparison")}${`<div class="rr-catalogue-explorers"><div><h3>Donut · overview</h3>${allocationExplorer({ id: "catalogue-ring", values: example.weights, within: example.within, buckets: example.buckets, reference: example.reference })}</div><div><h3>Bar · compact composition</h3>${allocationExplorer({ id: "catalogue-bar", values: example.weights, within: example.within, buckets: example.buckets, variant: "bar" })}</div></div>`}<details class="rr-disclosure rr-exact-comparison"><summary>Reference & recommended weights</summary>${weightTable(example.weights, example.reference)}</details><p class="rr-note">Example values. Stances use an ordered colour mapping; sleeves use fixed categorical colours. These meanings are separate.</p></section><section class="rr-section">${section("03", "Concept help")}<p>Short definitions on hover, focus or tap. Escape or a tap outside dismisses them. Essential values and status stay visible; longer explanations belong in disclosures.</p><div class="rr-catalogue-row">${conceptTip("sleeve", "catalogue-sleeve", { label: "Sleeve" })}${conceptTip("reference", "catalogue-reference", { label: "Session reference" })}${conceptTip("pp", "catalogue-pp", { label: "Percentage points" })}${conceptTip("within", "catalogue-within", { label: "Share of sleeve" })}${conceptTip("conviction", "catalogue-conviction", { label: "Conviction" })}</div></section><section class="rr-section">${section("04", "Long text & missing data")}${longText("An example paragraph. ".repeat(40), { label: "Read complete example", limit: 180 })}<p>${stance(null)} Conviction: Unavailable</p><p>Zero is a known value: ${percent(0)}. Missing is ${percent(null)}.</p></section></article>`;
}
