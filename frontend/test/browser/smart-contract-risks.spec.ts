// The smart contract risks page on the research record (RM-138): an index of
// its cases that sorts and filters, then every case as one record led by its
// date.
//
// Runs against a plain static server with /api answering 503, as
// heading-anchors.spec.ts does: the page is static prose and needs no data.
// Specs enter at "/" and move in-app from there.
//
// What only a browser shows, so it is asserted here and nowhere else:
//   - the index is baked newest first; Date, Protocol and Amount lost reorder
//     it, a second click reverses, aria-sort and the live region follow, and
//     oldest first lists each month's cases oldest first too;
//   - a chip hides index rows and never a record, and All brings everything
//     back;
//   - rules divide, never close: the last row SHOWN, under any filter and any
//     sort, draws no bottom rule, on a desktop and on a phone;
//   - a link from the index lands its record with the date clear of the fixed
//     nav, at every layout the record takes;
//   - "September 2026", the longest date, fits both date columns;
//   - on a phone the sort row keeps its place: a tap moves no heading, and the
//     whole row's height takes the tap;
//   - nothing runs past a phone's edge (a hash or an address in a list, an
//     amount in the facts); .rv__body.rr clips sideways overflow, so a page
//     with no scrollbar can still be cutting text off, and each box is
//     measured as well;
//   - the covenant, on computed styles: no shadow, gradient or rounded corner,
//     no cyan area, no cyan figure or link, and no Beacon anywhere.
import { expect, test, type Page } from "@playwright/test";
import { navigate } from "./navigation.ts";

const ROUTE = "/smart-contract-risks";
const BEACON = "rgb(255, 122, 41)";

async function open(page: Page) {
  await page.goto("/");
  await navigate(page, ROUTE);
  await expect(page.locator("#view h1.rv__title")).toHaveText("Smart Contract Risks");
}

/** Console errors, less the site nav's failed /api fetches (a static server answers 503). */
function collectErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    if (m.text().startsWith("Failed to load resource") && (m.location()?.url ?? "").includes("/api/")) return;
    errors.push(`${m.text()} (${m.location()?.url ?? ""})`);
  });
  return errors;
}

/** Which index rows are on screen, in order, which records, and what was said. */
async function shown(page: Page) {
  return page.evaluate(() => {
    const visible = (el: Element) => getComputedStyle(el).display !== "none" && (el as HTMLElement).getClientRects().length > 0;
    const rows = [...document.querySelectorAll("#view #incidents tbody tr")];
    return {
      rows: rows.filter(visible).map((tr) => tr.querySelector("th a")!.getAttribute("href")!.slice(1)),
      tags: rows.map((tr) => ({ id: tr.querySelector("th a")!.getAttribute("href")!.slice(1), tags: (tr.getAttribute("data-tags") || "").split(" ").filter(Boolean) })),
      records: [...document.querySelectorAll("#view article.rr-case")].filter(visible).length,
      spoken: document.querySelector("#view .rm-visually-hidden[aria-live]")?.textContent ?? null,
      sort: [...document.querySelectorAll("#view #incidents thead th")].map((th) => th.getAttribute("aria-sort")),
    };
  });
}

/** The last row a reader sees closes with no rule; the one above it keeps its own. */
async function lastRowRules(page: Page) {
  return page.evaluate(() => {
    const out: string[] = [];
    const rows = [...document.querySelectorAll("#view #incidents tbody tr")].filter((tr) => getComputedStyle(tr).display !== "none");
    const rule = (tr: Element) => [tr, ...tr.children].filter((el) => getComputedStyle(el).display !== "none").some((el) => getComputedStyle(el).borderBottomWidth !== "0px");
    const last = rows.at(-1);
    if (!last) return ["no row shown"];
    if (rule(last)) out.push(`the last row shown (${last.querySelector("th")!.textContent!.trim()}) closes with a rule`);
    if (rows.length > 1 && !rule(rows.at(-2)!)) out.push("the rows above the last draw no rule either, so this check reads nothing");
    return out;
  });
}

/** Where a record's date lands after a link from the index: its top against
 *  the fixed nav's bottom. */
async function landing(page: Page, id: string) {
  await page.locator(`#view #incidents a[href="#${id}"]`).click();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe(`#${id}`);
  // The page scrolls smoothly: wait until it has stopped, the same offset a
  // quarter of a second apart.
  await expect.poll(() => page.evaluate(() => new Promise<boolean>((done) => {
    const y = scrollY;
    setTimeout(() => done(scrollY === y && y > 0), 250);
  }))).toBe(true);
  return page.evaluate((id) => {
    const nav = document.querySelector("nav.nav")!.getBoundingClientRect();
    const date = document.querySelector(`#view article[aria-labelledby="${id}"] time.rr-case__date`)!.getBoundingClientRect();
    return { navBottom: Math.round(nav.bottom), dateTop: Math.round(date.top), dateBottom: Math.round(date.bottom), fixed: getComputedStyle(document.querySelector("nav.nav")!).position };
  }, id);
}

test.describe("desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("the index is newest first and sorts by date, protocol and amount lost", async ({ page }) => {
    const errors = collectErrors(page);
    await open(page);
    const head = (name: string) => page.locator("#view #incidents thead button.rr-sort", { hasText: name });
    const start = await shown(page);
    expect(start.rows).toHaveLength(17);
    expect(start.rows[0]).toBe("new-market-trading");
    expect(start.rows.at(-1)).toBe("the-dao");
    // Date, Protocol, Attack, Category, Amount lost: three sort, two do not.
    await expect(page.locator("#view #incidents thead th")).toHaveText(["Date", "Protocol", "Attack", "Category", "Amount lost"]);
    expect(start.sort).toEqual(["descending", "none", null, null, "none"]);

    await head("Amount lost").click();
    let now = await shown(page);
    expect(now.rows.slice(0, 3)).toEqual(["bybit-safe", "kelp-dao", "drift-protocol"]);
    expect(now.sort).toEqual(["none", "none", null, null, "descending"]);
    expect(now.spoken).toBe("Sorted by Amount lost, descending");
    expect(await lastRowRules(page)).toEqual([]);

    await head("Amount lost").click();
    now = await shown(page);
    expect(now.rows[0]).toBe("solv-protocol");
    expect(now.rows.at(-1)).toBe("bybit-safe");
    expect(now.sort).toEqual(["none", "none", null, null, "ascending"]);
    expect(now.spoken).toBe("Sorted by Amount lost, ascending");
    expect(await lastRowRules(page)).toEqual([]);

    await head("Protocol").click();
    now = await shown(page);
    expect(now.rows[0]).toBe("aave");
    expect(now.rows.at(-1)).toBe("yieldblox");
    expect(now.sort).toEqual(["none", "ascending", null, null, "none"]);
    expect(await lastRowRules(page)).toEqual([]);

    // Date's first click is newest first again: the page's own order.
    await head("Date").click();
    now = await shown(page);
    expect(now.rows).toEqual(start.rows);
    expect(now.sort).toEqual(start.sort);
    // Oldest first reverses each month too, so a month's cases read oldest
    // first: 2026 opens on Truebit, then Step Finance, and April is Drift
    // (April 1), then Kelp DAO. Without the reversal, a month would keep the
    // page's newest-first order inside an oldest-first list.
    await head("Date").click();
    now = await shown(page);
    expect(now.sort[0]).toBe("ascending");
    expect(now.spoken).toBe("Sorted by Date, ascending");
    expect(now.rows).toEqual([...start.rows].reverse());
    expect(now.rows).toEqual([
      "the-dao", "harvest-finance", "beanstalk", "euler-finance", "curve-finance", "bybit-safe",
      "truebit", "step-finance", "iotex", "yieldblox", "aave", "resolv", "venus-protocol", "solv-protocol",
      "drift-protocol", "kelp-dao", "new-market-trading",
    ]);
    expect(await lastRowRules(page)).toEqual([]);
    // And back: newest first is the page's order again, every month included.
    await head("Date").click();
    expect((await shown(page)).rows).toEqual(start.rows);
    expect(errors).toEqual([]);
  });

  test("the index is named by its heading's words, not its section link", async ({ page }) => {
    await open(page);
    await expect(page.locator("#view h2#chronology > a.rm-hlink")).toHaveCount(1);
    await expect(page.locator("#view table#incidents")).toHaveAccessibleName("The Attack Chronology");
  });

  test("a chip filters the index, never a record; All brings them back", async ({ page }) => {
    const errors = collectErrors(page);
    await open(page);

    const chips = page.locator('#view .rm-chips[role="group"][aria-label="Filter by attack category"] button.rm-chip');
    await expect(chips).toHaveCount(9);
    const all = chips.first();
    await expect(all).toHaveText("All");
    await expect(all).toHaveAttribute("aria-pressed", "true");

    const start = await shown(page);
    expect(start.rows).toHaveLength(17);
    expect(start.records).toBe(17);
    expect(start.spoken).toBe("");

    // Every category chip, in turn: its rows and only its rows, and every record.
    for (let i = 1; i < 9; i++) {
      const chip = chips.nth(i);
      const tag = await chip.evaluate((b) => /toggle\('([^']+)'/.exec(b.getAttribute("@click") || "")![1]!);
      const label = (await chip.textContent())!.trim();
      await chip.click();
      await expect(chip).toHaveAttribute("aria-pressed", "true");
      await expect(all).toHaveAttribute("aria-pressed", "false");
      const now = await shown(page);
      const want = start.tags.filter((r) => r.tags.includes(tag)).map((r) => r.id);
      expect(want.length, `${tag} files no case`).toBeGreaterThan(0);
      expect(now.rows, tag).toEqual(want);
      expect(now.records, `${tag} hid a record`).toBe(17);
      expect(now.spoken).toBe(`${want.length} of 17 exploits: ${label}`);
      // The chip's name is its visible text; its category's heading describes it.
      expect(await chip.getAttribute("aria-label")).toBeNull();
      await expect(chip).toHaveAttribute("aria-describedby", tag);
      await expect(page.locator(`#view h4#${tag}`)).toHaveCount(1);
      expect(await lastRowRules(page), tag).toEqual([]);
    }

    // A second press on the chip in force, then All, each restore everything.
    const last = chips.nth(8);
    await last.click();
    await expect(all).toHaveAttribute("aria-pressed", "true");
    expect((await shown(page)).rows).toHaveLength(17);
    expect((await shown(page)).spoken).toBe("17 of 17 exploits: All");
    await chips.nth(3).click();
    expect((await shown(page)).rows.length).toBeLessThan(17);
    await all.click();
    await expect(all).toHaveAttribute("aria-pressed", "true");
    const end = await shown(page);
    expect(end.rows).toHaveLength(17);
    expect(end.spoken).toBe("17 of 17 exploits: All");

    // A link from the index lands on its record while a filter is on, its
    // date clear of the fixed nav.
    await chips.nth(1).click();
    const at = await landing(page, "drift-protocol");
    expect(at.fixed).toBe("fixed");
    expect(at.dateTop, "the date is under the nav").toBeGreaterThanOrEqual(at.navBottom);
    expect(errors).toEqual([]);
  });

  test("a sort and a filter together keep the last row shown open", async ({ page }) => {
    await open(page);
    const head = (name: string) => page.locator("#view #incidents thead button.rr-sort", { hasText: name });
    const chip = (name: string) => page.locator("#view .rm-chips button.rm-chip", { hasText: name });
    // Oracle manipulation's last row in page order is Harvest Finance, which is
    // not the table's last row: without the factory's mark it keeps its rule.
    await chip("Oracle manipulation").click();
    expect(await lastRowRules(page)).toEqual([]);
    for (const col of ["Amount lost", "Amount lost", "Protocol", "Protocol", "Date", "Date"]) {
      await head(col).click();
      expect(await lastRowRules(page), col).toEqual([]);
    }
    await chip("Private key compromise").click();
    expect(await lastRowRules(page)).toEqual([]);
  });

  test("a record leads with its date, and its facts sit beside the narrative, flush with it", async ({ page }) => {
    await open(page);
    const r = await page.evaluate(() => {
      const art = document.querySelector('#view article[aria-labelledby="kelp-dao"]')!;
      const box = (s: string) => art.querySelector(s)!.getBoundingClientRect();
      const date = box("time.rr-case__date");
      const title = box("h3");
      const first = box(".rr-case__body > .rr-k");
      const facts = box(".rr-case__body > .rr-dl");
      const factsFirst = art.querySelector(".rr-case__body > .rr-dl > div:first-child dt")!.getBoundingClientRect();
      return {
        dateLeftOfTitle: date.right <= title.left,
        dateTop: Math.round(date.top - title.top),
        factsRightOfNarrative: facts.left > first.right,
        factsTop: Math.round(factsFirst.top - first.top),
        dateFont: getComputedStyle(art.querySelector("time")!).fontFamily,
        dateColor: getComputedStyle(art.querySelector("time")!).color,
      };
    });
    expect(r.dateLeftOfTitle).toBe(true);
    expect(Math.abs(r.dateTop)).toBeLessThanOrEqual(4);
    expect(r.factsRightOfNarrative).toBe(true);
    expect(Math.abs(r.factsTop)).toBeLessThanOrEqual(4);
    expect(r.dateFont).toMatch(/mono/i);
    expect(r.dateColor).toBe("rgb(242, 244, 249)");
  });

  test('"September 2026" fits the record\'s date column and the index\'s', async ({ page }) => {
    await open(page);
    // The longest month there is, written into a record and an index row: it
    // must stay inside its column, clear of the title and the next cell.
    const fit = await page.evaluate(() => {
      const art = document.querySelector('#view article[aria-labelledby="kelp-dao"]')!;
      const time = art.querySelector("time.rr-case__date")!;
      time.textContent = "September 2026";
      const cols = getComputedStyle(art).gridTemplateColumns.split(" ").map(parseFloat);
      const td = document.querySelector("#view #incidents tbody tr td.rr-table__date")!;
      td.textContent = "September 2026";
      const text = document.createRange();
      text.selectNodeContents(td);
      const t = text.getBoundingClientRect();
      const cell = td.getBoundingClientRect();
      return {
        dateWidth: time.getBoundingClientRect().width,
        column: cols[0]!,
        titleClear: time.getBoundingClientRect().right <= art.querySelector("h3")!.getBoundingClientRect().left,
        textRight: t.right,
        cellInner: cell.right - parseFloat(getComputedStyle(td).paddingRight),
      };
    });
    expect(fit.dateWidth, "the record's date").toBeLessThanOrEqual(fit.column);
    expect(fit.titleClear).toBe(true);
    expect(fit.textRight, "the index's date").toBeLessThanOrEqual(fit.cellInner);
  });

  test("Pattern Analysis steps down from its heading to the categories", async ({ page }) => {
    await open(page);
    const step = await page.evaluate(() => {
      const size = (s: string) => parseFloat(getComputedStyle(document.querySelector(s)!).fontSize);
      const h3 = document.querySelector("#view h3#common-attack-categories")!.getBoundingClientRect();
      const h4 = document.querySelector("#view #patterns-sec h4")!.getBoundingClientRect();
      return { h3: size("#view h3#common-attack-categories"), h4: size("#view #patterns-sec h4"), gap: h4.top - h3.bottom };
    });
    // A rung of the type scale apart, and more room under the heading than
    // between a category's name and its text.
    expect(step.h3 - step.h4).toBeGreaterThanOrEqual(4);
    expect(step.gap).toBeGreaterThanOrEqual(24);
  });

  test("the page keeps the covenant on its computed styles", async ({ page }) => {
    await open(page);
    // A filter on, so the pressed chip is scanned too.
    await page.locator("#view .rm-chips button.rm-chip").nth(3).click();
    const findings = await page.evaluate((beacon) => {
      const CYAN = ["rgb(0, 229, 255)", "rgb(0, 184, 212)"];
      const BEACON = [beacon, "rgb(255, 102, 68)"];
      const out: string[] = [];
      const root = document.querySelector("#view section.rv")!;
      let scanned = 0;
      for (const el of [root, ...root.querySelectorAll("*")]) {
        if (!el.getClientRects().length) continue;
        scanned++;
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        const tag = `${el.tagName.toLowerCase()}.${(el.getAttribute("class") || "").split(" ")[0]}`;
        const own = [...el.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent || "").join("").trim();
        const svg = el instanceof SVGElement;
        if (cs.boxShadow !== "none") out.push(`box-shadow on ${tag}`);
        if (cs.backgroundImage !== "none") out.push(`gradient or image on ${tag}: ${cs.backgroundImage}`);
        for (const c of ["borderTopLeftRadius", "borderTopRightRadius", "borderBottomLeftRadius", "borderBottomRightRadius"] as const) {
          if (cs[c] !== "0px") { out.push(`rounded ${tag}: ${cs[c]}`); break; }
        }
        if (CYAN.includes(cs.backgroundColor) && r.width * r.height > 200) out.push(`cyan area on ${tag}: ${Math.round(r.width * r.height)}px²`);
        if (svg && CYAN.includes(cs.fill) && r.width * r.height > 200) out.push(`cyan fill on ${tag}`);
        if (CYAN.includes(cs.color) && own && /[0-9]/.test(own)) out.push(`cyan figure in ${tag}: "${own}"`);
        if (svg && CYAN.includes(cs.fill) && own) out.push(`cyan text in ${tag}: "${own}"`);
        if (CYAN.includes(cs.color) && el.tagName === "A") out.push(`cyan link: "${el.textContent}"`);
        if (CYAN.includes(cs.borderBottomColor) && el.tagName === "A") out.push(`cyan underline: "${el.textContent}"`);
        // Nothing on this page is Beacon: no point, no note, no rule.
        const beaconHere = [cs.color, cs.backgroundColor, cs.borderTopColor, cs.borderRightColor, cs.borderBottomColor, cs.borderLeftColor, cs.outlineColor]
          .some((c) => BEACON.includes(c)) || (svg && [cs.fill, cs.stroke].some((c) => BEACON.includes(c)));
        if (beaconHere) out.push(`Beacon on ${tag}`);
      }
      // A scan that reached nothing would pass on nothing.
      if (scanned < 500) out.push(`only ${scanned} elements scanned`);
      // Figures in mono: dates and amounts in the index, the facts and the records' dates.
      for (const el of document.querySelectorAll("#view #incidents td.rr-table__date, #view #incidents td:last-of-type, #view .rr-case .rr-dl dd.rr-mono, #view .rr-case time")) {
        if (!/mono/i.test(getComputedStyle(el).fontFamily)) out.push(`a figure out of mono: "${el.textContent}"`);
      }
      return out;
    }, BEACON);
    expect(findings).toEqual([]);
    expect(await lastRowRules(page)).toEqual([]);
  });
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("nothing runs past the edge at 390px", async ({ page }) => {
    await open(page);
    const over = await page.evaluate(() => {
      const doc = document.documentElement;
      const out: string[] = [];
      if (doc.scrollWidth > doc.clientWidth) out.push(`page scrolls sideways: ${doc.scrollWidth} > ${doc.clientWidth}`);
      const edge = doc.clientWidth;
      for (const el of document.querySelectorAll("#view section.rv *")) {
        if (!el.getClientRects().length || el.closest(".rm-visually-hidden")) continue;
        const r = el.getBoundingClientRect();
        if (r.width && r.right > edge + 0.5) out.push(`${el.tagName.toLowerCase()}.${el.getAttribute("class") || ""} ends at ${Math.round(r.right)}: "${(el.textContent || "").trim().slice(0, 60)}"`);
      }
      return out;
    });
    expect(over).toEqual([]);
  });

  test("the sort and the last row's rule on a phone", async ({ page }) => {
    await open(page);
    // The stacked rows print no lone dash for a case with no category.
    const dashes = await page.evaluate(() => [...document.querySelectorAll("#view #incidents td.is-zero")].filter((td) => getComputedStyle(td).display !== "none").length);
    expect(dashes).toBe(0);
    // The sortable headings stay on a phone, and a sort under a filter keeps
    // the last row shown open.
    const head = (name: string) => page.locator("#view #incidents thead button.rr-sort", { hasText: name });
    await expect(head("Date")).toBeVisible();
    await page.locator("#view .rm-chips button.rm-chip", { hasText: "Reentrancy" }).click();
    expect(await lastRowRules(page)).toEqual([]);
    await head("Amount lost").click();
    expect((await shown(page)).rows).toEqual(["curve-finance", "solv-protocol"]);
    expect(await lastRowRules(page)).toEqual([]);
    await head("Protocol").click();
    expect((await shown(page)).rows).toEqual(["curve-finance", "solv-protocol"]);
    expect(await lastRowRules(page)).toEqual([]);
    await head("Protocol").click();
    expect((await shown(page)).rows).toEqual(["solv-protocol", "curve-finance"]);
    expect(await lastRowRules(page)).toEqual([]);
  });

  test("the sort row keeps its place, and all of its height takes a tap", async ({ page }) => {
    await open(page);
    const row = () => page.evaluate(() => {
      // Measured from the row's own corner, so a scroll between two readings
      // moves nothing.
      const tr = document.querySelector("#view #incidents thead tr")!.getBoundingClientRect();
      return {
        row: { top: 0, bottom: Math.round(tr.height) },
        buttons: [...document.querySelectorAll("#view #incidents thead button.rr-sort")].map((b) => {
          const r = b.getBoundingClientRect();
          return { name: b.textContent!.trim(), left: Math.round(r.left - tr.left), right: Math.round(r.right - tr.left), top: Math.round(r.top - tr.top), bottom: Math.round(r.bottom - tr.top) };
        }),
      };
    });
    const before = await row();
    expect(before.buttons.map((b) => b.name)).toEqual(["Date", "Protocol", "Amount lost"]);
    for (const b of before.buttons) {
      expect(b.top, `${b.name} reaches the row's top`).toBe(before.row.top);
      expect(b.bottom, `${b.name} reaches the row's bottom`).toBe(before.row.bottom);
      expect(b.bottom - b.top, b.name).toBeGreaterThanOrEqual(24);
    }
    // Each order in turn: no heading moves, whichever carries the arrow.
    for (const name of ["Protocol", "Amount lost", "Amount lost", "Date"]) {
      await page.locator("#view #incidents thead button.rr-sort", { hasText: name }).click();
      const after = await row();
      expect(after.buttons, `after ${name}`).toEqual(before.buttons);
    }
  });
});

// Below 1120px a record's date sits over its title, so a link from the index
// must land the title low enough for the date to clear the fixed nav: the
// title's scroll margin carries the date's height too.
for (const width of [1024, 390]) {
  test.describe(`a link lands its record at ${width}px`, () => {
    test.use({ viewport: { width, height: width < 600 ? 844 : 800 } });

    test("the date clears the fixed nav", async ({ page }) => {
      await open(page);
      for (const id of ["kelp-dao", "curve-finance"]) {
        const at = await landing(page, id);
        expect(at.fixed).toBe("fixed");
        expect(at.dateTop, `${id}: the date's top is under the nav`).toBeGreaterThanOrEqual(at.navBottom);
      }
    });
  });
}
