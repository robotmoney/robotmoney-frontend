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
// row whose categories, date, attack or amount differ from its record's, a row
// dated later than the one above it (the page is newest first), or a category
// whose cited cases differ from the records filed under it.
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
  // Baked newest first: the sort's ties, and a reader without JavaScript, take
  // the page's order as the date order.
  rows.forEach((r, i) => {
    const above = rows[i - 1];
    if (above && r.sort.month > above.sort.month) out.push(`${r.id}: data-month="${r.sort.month}" is later than ${above.id}'s "${above.sort.month}" above it`);
  });
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

/** A category's name without its parenthetical: "Oracle Manipulation (~35% of exploits)" reads "Oracle Manipulation". */
export const termName = (heading: string) => heading.replace(/\s*\([^)]*\)\s*$/, "");

export function buildSmartContractRisksData(html: string): { json: string; index: string; parsed: Parsed } {
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
  return { json: JSON.stringify(data, null, 2) + "\n", index: lines.join("\n"), parsed };
}

if (import.meta.main) {
  const check = process.argv.includes("--check");
  const { json, index } = buildSmartContractRisksData(readFileSync(VIEW_PATH, "utf8"));
  const read = (p: string) => { try { return readFileSync(p, "utf8"); } catch { return ""; } };
  const stale = [[JSON_PATH, json], [INDEX_PATH, index]].filter(([p, body]) => read(p!) !== body).map(([p]) => p!);
  if (check) {
    if (stale.length) {
      console.error(`Out of date: ${stale.map((p) => p.slice(repoRoot.length + 1)).join(", ")}\n  Run: bun scripts/build-smart-contract-risks-data.ts`);
      process.exit(1);
    }
    console.log("smart contract risks data is up to date");
  } else {
    writeFileSync(JSON_PATH, json);
    writeFileSync(INDEX_PATH, index);
    console.log(`wrote ${[JSON_PATH, INDEX_PATH].map((p) => p.slice(repoRoot.length + 1)).join(", ")}`);
  }
}
