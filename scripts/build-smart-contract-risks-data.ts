// The smart contract risks page as data (RM-138).
//
//   bun scripts/build-smart-contract-risks-data.ts          write both files
//   bun scripts/build-smart-contract-risks-data.ts --check  exit 1 if either is stale
//
// The view, frontend/public/views/smart-contract-risks.html, is the one source.
// This reads it and writes:
//   frontend/public/data/smart-contract-risks.json
//     every case with its facts, lists and root cause, the attack categories,
//     the 2026 update, the recommendations and the circuit breakers, every
//     string copied from the page as it reads there;
//   frontend/public/assets/js/app/lib/smart-contract-risks-index.js
//     the case ids and titles and the category ids and names, which seo.js
//     builds the page's ItemList, DefinedTermSet and Dataset from.
//
// It refuses to write anything when the page disagrees with itself: an index
// row whose categories, date, attack or amount differ from its record's, or a
// category whose cited cases differ from the records filed under it.
// scripts/tests/unit/smart-contract-risks-data.test.ts runs --check's
// comparison, so a view edited without re-running this fails the unit tier.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");
export const VIEW_PATH = join(repoRoot, "frontend/public/views/smart-contract-risks.html");
export const JSON_PATH = join(repoRoot, "frontend/public/data/smart-contract-risks.json");
export const INDEX_PATH = join(repoRoot, "frontend/public/assets/js/app/lib/smart-contract-risks-index.js");

export const ORIGIN = "https://robotmoney.network";
export const PAGE_PATH = "/smart-contract-risks";
export const DATA_PATH = "/data/smart-contract-risks.json";

// ── A small HTML reader ─────────────────────────────────────────────────────
// Enough for a hand-written view fragment: elements, attributes (Alpine's
// ":x" and "@x" included), comments, void elements and character references.
// It throws on an unknown named reference or a mismatched closing tag, rather
// than decoding a page into something it does not say.

export type HNode = { tag: string; attrs: Record<string, string>; children: (HNode | string)[] };

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0",
  rsquo: "\u2019", lsquo: "\u2018", ldquo: "\u201c", rdquo: "\u201d",
  rarr: "\u2192", larr: "\u2190", ndash: "\u2013", mdash: "\u2014",
  cent: "\u00a2", middot: "\u00b7", hellip: "\u2026", times: "\u00d7",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (_m, e: string) => {
    if (e[0] === "#") return String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    const ch = NAMED[e];
    if (ch === undefined) throw new Error(`unknown character reference &${e};`);
    return ch;
  });
}

export function parseHtml(src: string): HNode {
  const root: HNode = { tag: "#root", attrs: {}, children: [] };
  const stack: HNode[] = [root];
  const token = /<!--[\s\S]*?-->|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[^\s=>"'/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/g;
  const attr = /([^\s=>"'/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let last = 0;
  for (const m of src.matchAll(token)) {
    const text = src.slice(last, m.index);
    if (text) stack.at(-1)!.children.push(decodeEntities(text));
    last = m.index! + m[0].length;
    if (m[0].startsWith("<!--")) continue;
    if (m[1]) {
      const name = m[1].toLowerCase();
      const open = stack.at(-1)!;
      if (open.tag !== name) throw new Error(`</${name}> closes <${open.tag}> at ${m.index}`);
      stack.pop();
      continue;
    }
    const node: HNode = { tag: m[2]!.toLowerCase(), attrs: {}, children: [] };
    for (const a of (m[3] ?? "").matchAll(attr)) node.attrs[a[1]!] = decodeEntities(a[2] ?? a[3] ?? a[4] ?? "");
    stack.at(-1)!.children.push(node);
    if (!VOID.has(node.tag) && !m[4]) stack.push(node);
  }
  const tail = src.slice(last);
  if (tail.trim()) stack.at(-1)!.children.push(decodeEntities(tail));
  if (stack.length !== 1) throw new Error(`unclosed <${stack.at(-1)!.tag}>`);
  return root;
}

export const squash = (s: string) => s.replace(/\s+/g, " ").trim();
export const hasClass = (n: HNode, c: string) => (n.attrs.class ?? "").split(/\s+/).includes(c);
export const elements = (n: HNode) => n.children.filter((c): c is HNode => typeof c !== "string");

export function findAll(n: HNode, pred: (x: HNode) => boolean, out: HNode[] = []): HNode[] {
  for (const c of elements(n)) {
    if (pred(c)) out.push(c);
    findAll(c, pred, out);
  }
  return out;
}

export function find(n: HNode, pred: (x: HNode) => boolean): HNode {
  const hit = findAll(n, pred)[0];
  if (!hit) throw new Error("smart-contract-risks: an element the page must have is missing");
  return hit;
}

/** The text a reader sees, with whitespace collapsed. `skip` leaves out a
 *  child element (a nested list, when reading its item). */
export function textOf(n: HNode | string, skip?: (x: HNode) => boolean): string {
  const raw = (x: HNode | string): string => (typeof x === "string" ? x : skip?.(x) ? "" : x.children.map(raw).join(""));
  return squash(raw(n));
}

const byId = (id: string) => (n: HNode) => n.attrs.id === id;
const hashOf = (a: HNode) => (a.attrs.href ?? "").replace(/^#/, "");

// ── The page ────────────────────────────────────────────────────────────────

export type Item = { text: string; sub_items?: string[] };
export type Block = { label: string; items: Item[]; paragraphs?: string[] };
export type Case = {
  id: string; url: string; date_text: string; month: string; protocol: string; title: string; attack: string;
  what_happened: string; amount_lost: string; amount_usd: number; parties: string; categories: string[]; blocks: Block[]; root_cause: string;
};
export type Category = { id: string; name: string; text: string; cases: string[] };
export type SmartContractRisks = {
  title: string; url: string; last_updated_text: string; sources_text: string;
  cases: Case[];
  categories: Category[];
  key_compromises: { heading: string; paragraphs: string[] };
  recommendations: { id: string; title: string; text: string }[];
  circuit_breakers: { heading: string; text: string; items: { title: string; text: string }[] };
};
export type IndexRow = {
  id: string; protocol: string; date_text: string; attack: string; categories: string[]; amount_lost: string;
  /** The row's sort keys: data-month, data-protocol, data-usd, as written. */
  sort: { month: string; protocol: string; usd: string };
};

/** The first US dollar figure a phrase states, as a number: "$3.7 million
 *  extracted, $2.15M bad debt" is 3700000, "3.6M ETH (~$60 million ...)" is
 *  60000000, "$70+ million" is 70000000. NaN when it states none. */
export function firstUsd(phrase: string): number {
  const m = /\$(\d[\d,]*(?:\.\d+)?)\+?\s*(billion|million|thousand|B|M|K)?\b/.exec(phrase);
  if (!m) return NaN;
  const scale: Record<string, number> = { billion: 1e9, B: 1e9, million: 1e6, M: 1e6, thousand: 1e3, K: 1e3 };
  return Math.round(Number(m[1]!.replace(/,/g, "")) * (m[2] ? scale[m[2]]! : 1));
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "Step 1: Attacker ..." as one string; a nested list as its sub_items. */
function itemOf(li: HNode): Item {
  const sub = elements(li).find((c) => c.tag === "ul");
  const text = textOf(li, (c) => c.tag === "ul");
  return sub ? { text, sub_items: elements(sub).filter((c) => c.tag === "li").map((c) => textOf(c)) } : { text };
}

/** A bold lead and what follows it: { title, text }, the lead without its colon. */
function leadOf(li: HNode) {
  const strong = elements(li).find((c) => c.tag === "strong");
  if (!strong) throw new Error(`smart-contract-risks: "${textOf(li)}" has no bold lead`);
  const lead = textOf(strong);
  const all = textOf(li);
  if (!all.startsWith(lead)) throw new Error(`smart-contract-risks: "${all}" does not open with its lead`);
  return { title: lead.replace(/:$/, ""), text: squash(all.slice(lead.length)) };
}

/** A record: its date, its title, then its body (what happened, the facts,
 *  each labelled list, the root cause), in that order and nothing else. */
function readCase(article: HNode): Case {
  const [time, h3, body, ...extra] = elements(article);
  if (time?.tag !== "time" || h3?.tag !== "h3" || !body || !hasClass(body, "rr-case__body") || extra.length) {
    throw new Error(`smart-contract-risks: a record must be <time>, <h3>, div.rr-case__body (${article.attrs["aria-labelledby"]})`);
  }
  const id = h3.attrs.id!;
  const title = textOf(h3);
  const cut = title.indexOf(": ");
  if (cut < 0) throw new Error(`smart-contract-risks: ${id}'s title has no "Protocol: attack" colon`);
  const parts: Block[] = [];
  const facts: Record<string, HNode> = {};
  for (const el of elements(body)) {
    if (hasClass(el, "rr-k")) parts.push({ label: textOf(el), items: [], paragraphs: [] });
    else if (el.tag === "dl") for (const row of elements(el)) facts[textOf(find(row, (n) => n.tag === "dt"))] = find(row, (n) => n.tag === "dd");
    else if (!parts.length) throw new Error(`smart-contract-risks: ${id} has a ${el.tag} before its first label`);
    else if (el.tag === "ul") parts.at(-1)!.items.push(...elements(el).filter((c) => c.tag === "li").map(itemOf));
    else if (el.tag === "p") parts.at(-1)!.paragraphs!.push(textOf(el));
    else throw new Error(`smart-contract-risks: ${id} has an unexpected ${el.tag}`);
  }
  const single = (label: string) => {
    const hit = parts.filter((p) => p.label === label);
    if (hit.length !== 1 || hit[0]!.items.length || hit[0]!.paragraphs!.length !== 1) throw new Error(`smart-contract-risks: ${id} needs one "${label}" paragraph`);
    return hit[0]!.paragraphs![0]!;
  };
  for (const k of ["Amount Lost", "Parties", "Category"]) if (!facts[k]) throw new Error(`smart-contract-risks: ${id} has no ${k} row`);
  const month = time.attrs.datetime ?? "";
  const dateText = textOf(time);
  const [monthName, year] = dateText.split(" ");
  if (`${year}-${String(MONTHS.indexOf(monthName!) + 1).padStart(2, "0")}` !== month) {
    throw new Error(`smart-contract-risks: ${id} is dated "${dateText}" but datetime="${month}"`);
  }
  return {
    id,
    url: `${ORIGIN}${PAGE_PATH}#${id}`,
    date_text: dateText,
    month,
    protocol: title.slice(0, cut),
    title,
    attack: title.slice(cut + 2),
    what_happened: single("What happened"),
    amount_lost: textOf(facts["Amount Lost"]!),
    amount_usd: firstUsd(textOf(facts["Amount Lost"]!)),
    parties: textOf(facts["Parties"]!),
    categories: findAll(facts["Category"]!, (n) => n.tag === "a").map(hashOf),
    blocks: parts
      .filter((p) => p.label !== "What happened" && p.label !== "Root cause")
      .map((p) => (p.paragraphs!.length ? p : { label: p.label, items: p.items })),
    root_cause: single("Root cause"),
  };
}

export type Parsed = {
  data: SmartContractRisks; rows: IndexRow[]; listName: string; termsName: string; dataHref: string; categoryHeadings: string[];
  /** What each chip toggles, in order ("" for All), and the heading it is described by. */
  chips: { tag: string; describedBy: string }[];
  /** The index's sortable columns: the row attribute each heading sorts by. */
  sortKeys: string[];
};

/** The first quoted argument of a call in an Alpine attribute: toggle('x', ...) is "x". */
const firstArg = (expr: string | undefined, fn: string) => new RegExp(`^${fn}\\('([^']*)'`).exec(expr ?? "")?.[1];

/** Everything the page states, read from its markup. */
export function readPage(html: string): Parsed {
  const root = parseHtml(html);
  const cases = findAll(root, (n) => n.tag === "article" && hasClass(n, "rr-case")).map(readCase);

  const table = find(root, byId("incidents"));
  // A row: the date, the protocol (the row's heading), the attack, the
  // categories, the amount lost; data-month, data-protocol and data-usd are
  // what its sortable columns sort by.
  const rows: IndexRow[] = findAll(table, (n) => n.tag === "tr" && "data-tags" in n.attrs).map((tr) => {
    const [date, th, attack, cats, amount, ...extra] = elements(tr);
    if (date?.tag !== "td" || th?.tag !== "th" || !amount || extra.length) throw new Error("smart-contract-risks: an index row must be date, protocol, attack, category, amount lost");
    return {
      id: hashOf(find(th, (n) => n.tag === "a")),
      protocol: textOf(th),
      date_text: textOf(date),
      attack: textOf(attack!),
      categories: findAll(cats!, (n) => n.tag === "a").map(hashOf),
      amount_lost: textOf(amount),
      sort: { month: tr.attrs["data-month"] ?? "", protocol: tr.attrs["data-protocol"] ?? "", usd: tr.attrs["data-usd"] ?? "" },
      tags: tr.attrs["data-tags"]!.split(" ").filter(Boolean),
    };
  }).map(({ tags, ...row }) => {
    if (tags.join(" ") !== row.categories.join(" ")) throw new Error(`smart-contract-risks: the ${row.id} row's data-tags differ from the categories it links`);
    return row;
  });

  const patterns = find(root, byId("patterns-sec"));
  const h4s = findAll(patterns, (n) => n.tag === "h4");
  const categories: Category[] = h4s.map((h4) => {
    const block = findAll(patterns, (n) => elements(n).includes(h4))[0]!;
    const p = find(block, (n) => n.tag === "p");
    const lead = find(p, (n) => n.tag === "strong");
    return { id: h4.attrs.id!, name: textOf(h4), text: textOf(p), cases: findAll(lead, (n) => n.tag === "a").map(hashOf) };
  });

  const kc = find(root, byId("key-compromises-sec"));
  const cbHeading = find(root, byId("circuit-breakers-post-resolv-update"));
  const cbBlock = findAll(root, (n) => hasClass(n, "rr-block") && findAll(n, (x) => x === cbHeading).length > 0)[0]!;
  const note = textOf(find(root, (n) => hasClass(n, "rr-note")));
  const [lastUpdated, sources, ...rest] = note.split(" · ");
  if (!lastUpdated || !sources || rest.length) throw new Error(`smart-contract-risks: the note should read "Last Updated ... · Sources ...": ${note}`);

  const data: SmartContractRisks = {
    title: textOf(find(root, (n) => n.tag === "h1")),
    url: ORIGIN + PAGE_PATH,
    last_updated_text: lastUpdated,
    sources_text: sources,
    cases,
    categories,
    key_compromises: {
      heading: textOf(find(kc, (n) => n.tag === "h2")),
      paragraphs: findAll(kc, (n) => n.tag === "p").map((p) => textOf(p)),
    },
    recommendations: findAll(root, (n) => n.tag === "li" && (n.attrs.id ?? "").startsWith("rec-")).map((li) => ({ id: li.attrs.id!, ...leadOf(li) })),
    circuit_breakers: {
      heading: textOf(cbHeading),
      text: textOf(find(cbBlock, (n) => n.tag === "p")),
      items: findAll(find(cbBlock, (n) => n.tag === "ul"), (n) => n.tag === "li").map(leadOf),
    },
  };
  return {
    data,
    rows,
    listName: textOf(find(root, byId("chronology"))),
    termsName: textOf(find(root, byId("common-attack-categories"))),
    dataHref: find(find(root, byId("chronology-sec")), (n) => hasClass(n, "rr-sec__aside")).attrs.href ?? "",
    categoryHeadings: h4s.map((h) => h.attrs.id!),
    chips: findAll(find(find(root, byId("chronology-sec")), (n) => hasClass(n, "rm-chips")), (n) => n.tag === "button").map((b) => ({
      tag: firstArg(b.attrs["@click"], "toggle") ?? "?",
      describedBy: b.attrs["aria-describedby"] ?? "",
    })),
    sortKeys: findAll(find(table, (n) => n.tag === "thead"), (n) => n.tag === "th")
      .map((th) => firstArg(elements(th).find((b) => hasClass(b, "rr-sort"))?.attrs["@click"], "sortBy") ?? "")
      .filter(Boolean),
  };
}

/** The attributes a row's sortable columns read, by the key each heading sorts by. */
export const SORT_KEYS = ["month", "protocol", "usd"];

/** Where the page disagrees with itself; empty when it does not. */
export function disagreements({ data, rows, dataHref, chips, sortKeys, categoryHeadings }: Parsed): string[] {
  const out: string[] = [];
  // The chips toggle the categories, in the page's order, each described by its heading.
  const wantChips = ["", ...categoryHeadings];
  if (chips.map((c) => c.tag).join() !== wantChips.join()) out.push(`the chips toggle [${chips.map((c) => c.tag)}], not All and the categories [${categoryHeadings}]`);
  for (const c of chips) if (c.tag && c.describedBy !== c.tag) out.push(`the ${c.tag} chip is described by "${c.describedBy}", not its heading`);
  // Date, Protocol and Amount lost sort, by attributes every row carries and
  // that say what the row says.
  if ([...sortKeys].sort().join() !== [...SORT_KEYS].sort().join()) out.push(`the index sorts by [${sortKeys}], not [${SORT_KEYS}]`);
  for (const r of rows) {
    const rec = data.cases.find((c) => c.id === r.id);
    if (!r.sort.month || !r.sort.protocol || !r.sort.usd) out.push(`${r.id}: a row needs data-month, data-protocol and data-usd`);
    if (rec && r.sort.month !== rec.month) out.push(`${r.id}: data-month="${r.sort.month}", but the record is dated ${rec.month}`);
    if (r.sort.protocol !== r.protocol) out.push(`${r.id}: data-protocol="${r.sort.protocol}", but the row names ${r.protocol}`);
    if (Number(r.sort.usd) !== firstUsd(r.amount_lost)) out.push(`${r.id}: data-usd="${r.sort.usd}", but the first dollar figure of "${r.amount_lost}" is ${firstUsd(r.amount_lost)}`);
  }
  const ids = data.cases.map((c) => c.id);
  const catIds = data.categories.map((c) => c.id);
  if (new Set(ids).size !== ids.length) out.push("two cases share an id");
  if (new Set(catIds).size !== catIds.length) out.push("two categories share an id");
  if (dataHref !== DATA_PATH) out.push(`the chronology links ${dataHref}, not ${DATA_PATH}`);
  if (rows.map((r) => r.id).join() !== ids.join()) out.push("the index rows are not the records, in the records' order");
  for (const c of data.cases) {
    const row = rows.find((r) => r.id === c.id);
    if (!row) continue;
    for (const k of ["protocol", "date_text", "attack", "amount_lost"] as const) {
      if (row[k] !== c[k]) out.push(`${c.id}: the index gives ${k} "${row[k]}", the record "${c[k]}"`);
    }
    if (row.categories.join() !== c.categories.join()) out.push(`${c.id}: the index files it under [${row.categories}], the record under [${c.categories}]`);
    for (const k of c.categories) if (!catIds.includes(k)) out.push(`${c.id}: no category ${k}`);
  }
  for (const cat of data.categories) {
    for (const k of cat.cases) if (!ids.includes(k)) out.push(`${cat.id} cites ${k}, which has no record`);
    const filed = data.cases.filter((c) => c.categories.includes(cat.id)).map((c) => c.id).sort();
    if ([...cat.cases].sort().join() !== filed.join()) out.push(`${cat.id} cites [${cat.cases}] but [${filed}] are filed under it`);
  }
  // A case's categories run in the page's category order, as the index lists them.
  for (const c of data.cases) {
    const ordered = [...c.categories].sort((a, b) => catIds.indexOf(a) - catIds.indexOf(b));
    if (ordered.join() !== c.categories.join()) out.push(`${c.id}: categories out of the page's order`);
  }
  return out;
}


// ── The timeline ────────────────────────────────────────────────────────────
// The chronology opens on a chart: each case a Beacon point at its month and
// the first dollar figure its Amount Lost states (the row's data-usd), on a
// log scale from $1M to $2B. Two panels, the page's own era split: the years
// before the latest by year on the left, the latest year by month on the
// right, with a gap between them so the change of scale shows. Cases in the
// same month spread across that month's band.
//
// Baked, not drawn in the browser, so a reader without JavaScript gets it,
// and written twice (like the changelog's diagrams): a wide drawing, and one
// with the panels stacked for a phone; views.css shows one.
//
// Neither drawing has a viewBox. Across the page its x positions are
// percentages of the drawing's width and every size is in pixels, so a dot is
// the same 10px and a label the same type size at every width. A label sits
// a fixed number of pixels from its dot, so its box moves linearly with the
// width: placeLabels() picks, for each point, the first side of its dot where
// the label stays inside its panel and clears every other label and dot at
// both ends of the width range the drawing is shown at, which by linearity is
// every width in between.

export type TimelinePoint = { id: string; protocol: string; month: string; usd: number; tags: string[]; title: string };

/** The y axis: amount lost, log scale. */
const USD_LO = 1e6;
const USD_HI = 2e9;
const USD_TICKS: [number, string][] = [[1e6, "$1M"], [1e7, "$10M"], [1e8, "$100M"], [1e9, "$1B"]];
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Type and marks, in pixels. Labels are JetBrains Mono at 0.625rem: 6px an
 *  advance, and a line box of 10.2px over the baseline and 3px under it (the
 *  box a browser measures a label by, a little more than its ink). The dot is
 *  Beacon's point, under the covenant's 12px. */
const CH = 6;
const ASC = 10.2;
const DESC = 3;
const LABEL_H = ASC + DESC;
const DOT_R = 5;
const PAD = 1;

type Panel = { x0: number; x1: number; top: number; h: number; kind: "years" | "months" };
type Variant = { name: "wide" | "narrow"; wMin: number; wMax: number; height: number; gutter: number; panels: Panel[] };

/** The drawings. wMin and wMax bound the column each one is shown in: the
 *  wide one from a 641px window (the column is the window less 1.5rem a side,
 *  and less a scrollbar) to .rv__body's 1280px less 2rem a side; the narrow
 *  one from a 320px phone to the 640px breakpoint. */
export const TIMELINE_VARIANTS: Variant[] = [
  {
    name: "wide", wMin: 560, wMax: 1216, height: 316, gutter: 0.075,
    panels: [
      { x0: 0.075, x1: 0.405, top: 6, h: 280, kind: "years" },
      { x0: 0.445, x1: 1, top: 6, h: 280, kind: "months" },
    ],
  },
  {
    name: "narrow", wMin: 300, wMax: 592, height: 562, gutter: 0.14,
    panels: [
      { x0: 0.14, x1: 1, top: 6, h: 230, kind: "years" },
      { x0: 0.14, x1: 1, top: 302, h: 230, kind: "months" },
    ],
  },
];

const yOf = (panel: Panel, usd: number) =>
  panel.top + panel.h * (1 - (Math.log10(usd) - Math.log10(USD_LO)) / (Math.log10(USD_HI) - Math.log10(USD_LO)));

/** A box whose x runs a·W + [b0, b1] for a drawing W pixels wide; y is fixed. */
type Box = { a: number; b0: number; b1: number; y0: number; y1: number };

/** Clear of each other at every width in [lo, hi]: apart in y, or one wholly
 *  left of the other at both ends of the range (x is linear in W). */
function clear(p: Box, q: Box, lo: number, hi: number) {
  if (p.y1 <= q.y0 || q.y1 <= p.y0) return true;
  const leftOf = (l: Box, r: Box) => [lo, hi].every((w) => l.a * w + l.b1 <= r.a * w + r.b0);
  return leftOf(p, q) || leftOf(q, p);
}

/** The sides a label can take, in order of preference: right of its dot,
 *  left of it, then over or under it, running right, left or centred. */
const SIDES = ["r", "l", "ar", "br", "al", "bl", "a", "b"] as const;
type Side = (typeof SIDES)[number];

function labelBox(side: Side, a: number, cy: number, w: number): Box {
  const d = DOT_R + 4;
  const above = [cy - DOT_R - 2 - LABEL_H, cy - DOT_R - 2];
  // Centred on the dot: the baseline sits (ASC - DESC) / 2 under its centre.
  const below = [cy + DOT_R + 2, cy + DOT_R + 2 + LABEL_H];
  const mid = [cy - LABEL_H / 2, cy + LABEL_H / 2];
  const [y0, y1] = side === "r" || side === "l" ? mid : side.startsWith("a") ? above : below;
  const [b0, b1] =
    side === "r" ? [d, d + w] :
    side === "l" ? [-d - w, -d] :
    side.endsWith("r") ? [-4, -4 + w] :
    side.endsWith("l") ? [4 - w, 4] :
    [-w / 2, w / 2];
  return { a, b0: b0! - PAD, b1: b1! + PAD, y0: y0!, y1: y1! };
}

type Placed = { point: TimelinePoint; panel: Panel; a: number; cy: number; side: Side };

/** Every point's x (as a fraction of the drawing's width), its y, and its panel. */
function positions(points: TimelinePoint[], v: Variant) {
  const years = points.map((p) => Number(p.month.slice(0, 4)));
  const last = Math.max(...years);
  const first = Math.min(...years);
  const lastMonths = Math.max(...points.filter((p) => p.month.startsWith(String(last))).map((p) => Number(p.month.slice(5))));
  const [yp, mp] = [v.panels.find((p) => p.kind === "years")!, v.panels.find((p) => p.kind === "months")!];
  // Within a month, the page lists the newest first; left to right is oldest first.
  const inMonth = (p: TimelinePoint) => {
    const same = points.filter((q) => q.month === p.month).reverse();
    return (same.indexOf(p) + 0.5) / same.length;
  };
  return {
    first, last, lastMonths,
    placed: points.map((p) => {
      const y = Number(p.month.slice(0, 4));
      const m = Number(p.month.slice(5));
      const panel = y === last ? mp : yp;
      const t = y === last ? (m - 1 + inMonth(p)) / lastMonths : (y - first + (m - 0.5) / 12) / (last - first);
      return { point: p, panel, a: panel.x0 + (panel.x1 - panel.x0) * t, cy: yOf(panel, p.usd) };
    }),
  };
}

/** Each label's side: inside its panel, clear of every other label and dot,
 *  at every width the drawing is shown at. Throws when there is no such set. */
export function placeLabels(points: TimelinePoint[], v: Variant): Placed[] {
  const { placed } = positions(points, v);
  // A label keeps 4px clear of every other dot, so it never reads as that dot's.
  const clearing = DOT_R + 2;
  const dots: Box[] = placed.map((p) => ({ a: p.a, b0: -clearing, b1: clearing, y0: p.cy - clearing, y1: p.cy + clearing }));
  const width = (p: TimelinePoint) => p.protocol.length * CH;
  const fits = (i: number, side: Side) => {
    const p = placed[i]!;
    const box = labelBox(side, p.a, p.cy, width(p.point));
    const inside = [v.wMin, v.wMax].every((w) => box.a * w + box.b0 >= p.panel.x0 * w && box.a * w + box.b1 <= p.panel.x1 * w);
    if (!inside || box.y0 < p.panel.top - 6 || box.y1 > p.panel.top + p.panel.h - 1) return null;
    for (let j = 0; j < dots.length; j++) if (j !== i && !clear(box, dots[j]!, v.wMin, v.wMax)) return null;
    return box;
  };
  // The most crowded points choose first.
  const crowd = (i: number) => placed.filter((q, j) => j !== i && Math.abs(q.cy - placed[i]!.cy) < 24 && Math.abs(q.a - placed[i]!.a) * v.wMin < 140).length;
  const order = placed.map((_, i) => i).sort((i, j) => crowd(j) - crowd(i) || i - j);
  const chosen: (Box | null)[] = placed.map(() => null);
  const sides: Side[] = [];
  const search = (k: number): boolean => {
    if (k === order.length) return true;
    const i = order[k]!;
    for (const side of SIDES) {
      const box = fits(i, side);
      if (!box || chosen.some((b) => b && !clear(box, b, v.wMin, v.wMax))) continue;
      chosen[i] = box;
      sides[i] = side;
      if (search(k + 1)) return true;
      chosen[i] = null;
    }
    return false;
  };
  if (!search(0)) throw new Error(`smart-contract-risks: the ${v.name} timeline has no place for every label between ${v.wMin}px and ${v.wMax}px`);
  return placed.map((p, i) => ({ ...p, side: sides[i]! }));
}

const pct = (a: number) => `${+(a * 100).toFixed(3)}%`;
const px = (n: number) => `${+n.toFixed(1)}`;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** One drawing: gridlines and axes, then a link per point. */
export function timelineSvg(points: TimelinePoint[], v: Variant): string {
  const placed = placeLabels(points, v);
  const { first, last, lastMonths } = positions(points, v);
  const out: string[] = [];
  out.push(`<figure class="rr-tl rr-tl--${v.name}" aria-labelledby="timeline">`);
  out.push(`  <svg class="rr-tl__svg" width="100%" height="${v.height}">`);
  out.push(`    <g aria-hidden="true">`);
  const yLabelled = new Set<number>();
  for (const panel of v.panels) {
    const base = panel.top + panel.h;
    // The dollar gridlines, and the axis's own labels in the gutter once per
    // row of panels.
    for (const [usd, label] of USD_TICKS) {
      const y = yOf(panel, usd);
      const cls = usd === USD_LO ? "rr-tl__base" : "rr-tl__grid";
      out.push(`      <line class="${cls}" x1="${pct(panel.x0)}" x2="${pct(panel.x1)}" y1="${px(y)}" y2="${px(y)}"/>`);
      if (!yLabelled.has(Math.round(y))) out.push(`      <text class="rr-tl__y" x="${pct(v.gutter)}" dx="-8" y="${px(y + 3.5)}" text-anchor="end">${esc(label)}</text>`);
    }
    for (const [usd] of USD_TICKS) yLabelled.add(Math.round(yOf(panel, usd)));
    const at = (t: number) => panel.x0 + (panel.x1 - panel.x0) * t;
    if (panel.kind === "years") {
      const span = last - first;
      for (let k = 0; k <= span; k++) {
        out.push(`      <line class="rr-tl__tick" x1="${pct(at(k / span))}" x2="${pct(at(k / span))}" y1="${px(base)}" y2="${px(base + 5)}"/>`);
        // Every other year is named: at a phone's width a year is 20px.
        if (k < span && k % 2 === 0) out.push(`      <text class="rr-tl__x" x="${pct(at(k / span))}" y="${px(base + 17)}" text-anchor="middle">${first + k}</text>`);
      }
    } else {
      for (let k = 0; k <= lastMonths; k++) {
        out.push(`      <line class="rr-tl__tick" x1="${pct(at(k / lastMonths))}" x2="${pct(at(k / lastMonths))}" y1="${px(base)}" y2="${px(base + 5)}"/>`);
        if (k < lastMonths) {
          const name = k === 0 ? `${MONTH_SHORT[k]} ${last}` : MONTH_SHORT[k]!;
          out.push(`      <text class="rr-tl__x" x="${pct(at((k + 0.5) / lastMonths))}" y="${px(base + 17)}" text-anchor="middle">${name}</text>`);
        }
      }
    }
  }
  out.push(`    </g>`);
  // Oldest first, left to right: the order a keyboard moves through them.
  const byTime = [...placed].sort((p, q) => p.point.month.localeCompare(q.point.month) || p.a - q.a);
  for (const p of byTime) {
    const { point, side, a, cy } = p;
    const d = DOT_R + 4;
    const mid = cy + (ASC - DESC) / 2;
    const [anchor, dx, y] =
      side === "r" ? ["start", d, mid] :
      side === "l" ? ["end", -d, mid] :
      [side.endsWith("r") ? "start" : side.endsWith("l") ? "end" : "middle", side.endsWith("r") ? -4 : side.endsWith("l") ? 4 : 0,
        side.startsWith("a") ? cy - DOT_R - 2 - DESC : cy + DOT_R + 2 + ASC];
    out.push(`    <a href="#${point.id}" data-tags="${point.tags.join(" ")}" :class="has($el) ? '' : 'is-faded'" :tabindex="has($el) ? null : -1">` +
      `<title>${esc(point.title)}</title>` +
      `<circle class="rr-tl__dot" data-mark="series" cx="${pct(a)}" cy="${px(cy)}" r="${DOT_R}"/>` +
      `<text class="rr-tl__lbl" x="${pct(a)}" dx="${dx}" y="${px(y as number)}"${anchor === "start" ? "" : ` text-anchor="${anchor}"`}>${esc(point.protocol)}</text></a>`);
  }
  out.push(`  </svg>`);
  out.push(`</figure>`);
  return out.join("\n");
}

/** The timeline's points, from the index rows: newest first, as the page lists them. */
export function timelinePoints(rows: IndexRow[]): TimelinePoint[] {
  return rows.map((r) => ({
    id: r.id,
    protocol: r.protocol,
    month: r.sort.month,
    usd: Number(r.sort.usd),
    tags: r.categories,
    title: `${r.protocol}, ${r.date_text}: ${r.amount_lost}`,
  }));
}

const TL_START = "<!-- timeline:start -->";
const TL_END = "<!-- timeline:end -->";

/** The view with both drawings written between its markers. */
export function withTimeline(html: string, rows: IndexRow[]): string {
  const start = html.indexOf(TL_START);
  const end = html.indexOf(TL_END);
  if (start < 0 || end < start || html.indexOf(TL_START, start + 1) >= 0) throw new Error("smart-contract-risks: the view needs one timeline:start and timeline:end marker pair");
  const indent = html.slice(html.lastIndexOf("\n", start) + 1, start);
  const points = timelinePoints(rows);
  const body = TIMELINE_VARIANTS.map((v) => timelineSvg(points, v)).join("\n").split("\n").map((l) => indent + l).join("\n");
  return html.slice(0, start) + TL_START + "\n" + body + "\n" + indent + html.slice(end);
}

/** A category's name without its parenthetical: "Oracle Manipulation (~35% of exploits)" reads "Oracle Manipulation". */
export const termName = (heading: string) => heading.replace(/\s*\([^)]*\)\s*$/, "");

export function buildSmartContractRisksData(html: string): { json: string; index: string; view: string; parsed: Parsed } {
  const parsed = readPage(html);
  const problems = disagreements(parsed);
  if (problems.length) throw new Error(`smart-contract-risks disagrees with itself:\n  ${problems.join("\n  ")}`);
  const { data, listName, termsName } = parsed;
  const index = {
    path: PAGE_PATH,
    data: DATA_PATH,
    listName,
    termsName,
    cases: data.cases.map((c) => ({ id: c.id, title: c.title, protocol: c.protocol, date: c.date_text, month: c.month })),
    categories: data.categories.map((c) => ({ id: c.id, name: termName(c.name) })),
  };
  const lines = [
    "// GENERATED by scripts/build-smart-contract-risks-data.ts from",
    "// views/smart-contract-risks.html. Edit the view, then run the script; its",
    "// --check (and scripts/tests/unit/smart-contract-risks-data.test.ts) fails",
    "// while this file is stale.",
    "//",
    "// The page's cases, newest first, and its attack categories, for the",
    "// ItemList, DefinedTermSet and Dataset seo.js describes the page with. The",
    "// cases themselves, in full, are the JSON file at `data`.",
    `export const SMART_CONTRACT_RISKS = ${JSON.stringify(index, null, 2)};`,
    "",
  ];
  return { json: JSON.stringify(data, null, 2) + "\n", index: lines.join("\n"), view: withTimeline(html, parsed.rows), parsed };
}

if (import.meta.main) {
  const check = process.argv.includes("--check");
  const { json, index, view } = buildSmartContractRisksData(readFileSync(VIEW_PATH, "utf8"));
  const read = (p: string) => { try { return readFileSync(p, "utf8"); } catch { return ""; } };
  const stale = [[JSON_PATH, json], [INDEX_PATH, index], [VIEW_PATH, view]].filter(([p, body]) => read(p!) !== body).map(([p]) => p!);
  if (check) {
    if (stale.length) {
      console.error(`Out of date: ${stale.map((p) => p.slice(repoRoot.length + 1)).join(", ")}\n  Run: bun scripts/build-smart-contract-risks-data.ts`);
      process.exit(1);
    }
    console.log("smart contract risks data is up to date");
  } else {
    writeFileSync(JSON_PATH, json);
    writeFileSync(INDEX_PATH, index);
    writeFileSync(VIEW_PATH, view);
    console.log(`wrote ${[JSON_PATH, INDEX_PATH].map((p) => p.slice(repoRoot.length + 1)).join(", ")} and the view's timeline`);
  }
}
