// The smart contract risks page as data (RM-138).
//
// scripts/build-smart-contract-risks-data.ts reads the view and writes the
// cases as JSON (frontend/public/data/smart-contract-risks.json) and the case
// and category lists the structured data uses (lib/smart-contract-risks-index.js).
// Both are committed and served, so both go stale the moment the view is edited
// without re-running it; and the JSON promises to be the page's own words, so a
// string it carries that the page does not say is a fabrication. Neither shows
// in a browser. This holds them:
//   - the committed files are exactly what the view builds (--check is clean);
//   - every string in the JSON is in the view's text, and every id is an id there;
//   - the index rows, the records and the Pattern Analysis citations agree, and
//     a view where they do not is refused.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildSmartContractRisksData,
  disagreements,
  findAll,
  hasClass,
  INDEX_PATH,
  JSON_PATH,
  parseHtml,
  readPage,
  textOf,
  VIEW_PATH,
} from "../../build-smart-contract-risks-data.ts";
import { SMART_CONTRACT_RISKS } from "../../../frontend/public/assets/js/app/lib/smart-contract-risks-index.js";

const repoRoot = join(import.meta.dir, "../../..");
const view = readFileSync(VIEW_PATH, "utf8");
const json = readFileSync(JSON_PATH, "utf8");
const data = JSON.parse(json);
const root = parseHtml(view);
const viewText = textOf(root);
const viewIds = findAll(root, (n) => "id" in n.attrs).map((n) => n.attrs.id!);

// The five cases Pattern Analysis names under no category, and the three names
// it cites that have no case on the page.
const UNCITED = ["new-market-trading", "kelp-dao", "bybit-safe", "beanstalk", "the-dao"];
const NO_CASE = ["Yearn", "Radiant", "Cream"];

describe("the committed files are the view's", () => {
  test("--check is clean", () => {
    const r = Bun.spawnSync(["bun", "scripts/build-smart-contract-risks-data.ts", "--check"], { cwd: repoRoot });
    expect(new TextDecoder().decode(r.stderr)).toBe("");
    expect(r.exitCode).toBe(0);
  });

  test("the JSON and the index module are exactly what the view builds", () => {
    const built = buildSmartContractRisksData(view);
    expect(built.json).toBe(json);
    expect(built.index).toBe(readFileSync(INDEX_PATH, "utf8"));
  });

  test("the index module lists the JSON's cases and categories, in its order", () => {
    expect(SMART_CONTRACT_RISKS.cases.map((c) => [c.id, c.title, c.month])).toEqual(data.cases.map((c: any) => [c.id, c.title, c.month]));
    expect(SMART_CONTRACT_RISKS.categories.map((c) => c.id)).toEqual(data.categories.map((c: any) => c.id));
    expect(SMART_CONTRACT_RISKS.data).toBe("/data/smart-contract-risks.json");
  });
});

describe("the JSON says what the page says", () => {
  test("it holds the whole page: 17 cases, 8 categories, the 2026 update, 10 recommendations, 5 circuit breakers", () => {
    expect(data.cases).toHaveLength(17);
    expect(data.categories).toHaveLength(8);
    expect(data.key_compromises.paragraphs).toHaveLength(2);
    expect(data.recommendations).toHaveLength(10);
    expect(data.circuit_breakers.items).toHaveLength(5);
    for (const c of data.cases) {
      for (const k of ["what_happened", "amount_lost", "parties", "root_cause"]) expect(c[k].length, `${c.id}.${k}`).toBeGreaterThan(0);
      expect(c.blocks.length, `${c.id} has no attack vector`).toBeGreaterThan(0);
    }
  });

  test("every string in it is in the view's text", () => {
    // Ids, urls and months are addresses and dates in attributes, checked below.
    const SKIP = new Set(["id", "url", "month", "categories", "cases"]);
    const strings: [string, string][] = [];
    const walk = (v: unknown, path: string, key: string) => {
      if (typeof v === "string") { if (!SKIP.has(key)) strings.push([path, v]); return; }
      if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${path}[${i}]`, key)); return; }
      if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`, k);
    };
    walk(data, "", "");
    expect(strings.length).toBeGreaterThan(300);
    const missing = strings.filter(([, s]) => !viewText.includes(s)).map(([p, s]) => `${p}: ${s}`);
    expect(missing).toEqual([]);
  });

  test("every id in it is an id on the page, and every url lands on one", () => {
    const refs = [
      ...data.cases.map((c: any) => c.id),
      ...data.cases.flatMap((c: any) => c.categories),
      ...data.categories.map((c: any) => c.id),
      ...data.categories.flatMap((c: any) => c.cases),
      ...data.recommendations.map((r: any) => r.id),
    ];
    for (const id of refs) expect(viewIds, id).toContain(id);
    for (const c of data.cases) expect(c.url).toBe(`${data.url}#${c.id}`);
    expect(data.url).toBe("https://robotmoney.network/smart-contract-risks");
  });

  test("each case's month is the one its record is dated", () => {
    const times = findAll(root, (n) => n.tag === "time").map((t) => [t.attrs.datetime, textOf(t)]);
    expect(data.cases.map((c: any) => [c.month, c.date_text])).toEqual(times);
  });
});

describe("the page agrees with itself", () => {
  test("ids are unique: cases, categories, recommendations and every id on the page", () => {
    for (const list of [data.cases, data.categories, data.recommendations]) {
      const ids = list.map((x: any) => x.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
    expect(viewIds.filter((id, i) => viewIds.indexOf(id) !== i)).toEqual([]);
  });

  test("the index rows, the records and the Pattern Analysis citations agree", () => {
    const parsed = readPage(view);
    expect(parsed.rows).toHaveLength(17);
    expect(disagreements(parsed)).toEqual([]);
    // Categories only where Pattern Analysis names the case, and none inferred.
    for (const id of UNCITED) expect(data.cases.find((c: any) => c.id === id).categories, id).toEqual([]);
    const filed = data.cases.filter((c: any) => c.categories.length).map((c: any) => c.id);
    expect(filed).toHaveLength(12);
    // Named cases with no record stay text: no link in the lead carries them.
    for (const cat of findAll(root, (n) => n.tag === "h4")) {
      const block = findAll(root, (n) => n.children.includes(cat))[0]!;
      const lead = findAll(block, (n) => n.tag === "strong")[0]!;
      for (const a of findAll(lead, (n) => n.tag === "a")) expect(NO_CASE).not.toContain(textOf(a));
    }
    for (const name of NO_CASE) expect(viewText).toContain(name);
  });

  test("a view that disagrees with itself is refused, not written", () => {
    // Venus filed under reentrancy in the index alone.
    const bad = view.replace(
      '<tr data-tags="oracle-manipulation supply-cap-bypass"',
      '<tr data-tags="oracle-manipulation reentrancy"',
    );
    expect(bad).not.toBe(view);
    expect(() => buildSmartContractRisksData(bad)).toThrow();
    // A record dated one month in its text and another in its datetime.
    const misdated = view.replace('datetime="2026-05">May 2026', 'datetime="2026-04">May 2026');
    expect(misdated).not.toBe(view);
    expect(() => buildSmartContractRisksData(misdated)).toThrow();
    // A category citing a case the records do not file under it.
    const cited = view.replace(
      '<strong><a class="rr-lnk" href="#resolv">Resolv</a>.</strong>',
      '<strong><a class="rr-lnk" href="#resolv">Resolv</a>, <a class="rr-lnk" href="#aave">Aave</a>.</strong>',
    );
    expect(cited).not.toBe(view);
    expect(disagreements(readPage(cited)).length).toBeGreaterThan(0);
  });

  test("records never hide: only index rows carry the filter", () => {
    const filtered = findAll(root, (n) => (n.attrs["x-show"] ?? "").includes("has("));
    expect(filtered).toHaveLength(17);
    for (const n of filtered) expect(n.tag).toBe("tr");
    for (const n of findAll(root, (x) => x.tag === "article" && hasClass(x, "rr-case"))) {
      expect(findAll(n, (x) => "x-show" in x.attrs || "x-if" in x.attrs || "x-cloak" in x.attrs)).toEqual([]);
    }
  });
});
