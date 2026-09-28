// The smart contract risks page on the research record (RM-138): a timeline of
// its cases, an index of them that sorts and filters, then every case as one
// record led by its date.
//
// Runs against a plain static server with /api answering 503, as
// heading-anchors.spec.ts does: the page is static prose and needs no data.
// Specs enter at "/" and move in-app from there.
//
// What only a browser shows, so it is asserted here and nowhere else:
//   - the index is baked newest first; Date, Protocol and Amount lost reorder
//     it, a second click reverses, aria-sort and the live region follow;
//   - a chip hides index rows and never a record, fades the timeline points
//     outside its category and takes them out of the tab order, and All
//     brings everything back;
//   - rules divide, never close: the last row SHOWN, under any filter and any
//     sort, draws no bottom rule, on a desktop and on a phone;
//   - the timeline: a point per case linking its record, each a Beacon dot of
//     at most 12px, mono axis labels, the wide drawing on a desktop and the
//     stacked one on a phone;
//   - nothing runs past a phone's edge (a hash or an address in a list, an
//     amount in the facts); .rv__body.rr clips sideways overflow, so a page
//     with no scrollbar can still be cutting text off, and each box is
//     measured as well;
//   - the covenant, on computed styles: no shadow, gradient or rounded corner,
//     no cyan area, no cyan figure or link, and Beacon on the timeline's
//     points and nowhere else.
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

/** The timeline drawing on show: its points, their dots, and its axis labels. */
async function timeline(page: Page) {
  return page.evaluate(() => {
    const figs = [...document.querySelectorAll("#view figure.rr-tl")].filter((f) => getComputedStyle(f).display !== "none");
    const fig = figs[0];
    if (!fig) return null;
    const points = [...fig.querySelectorAll("a")];
    return {
      shown: figs.map((f) => f.getAttribute("class")),
      points: points.map((a) => {
        const dot = a.querySelector("circle")!;
        const r = dot.getBoundingClientRect();
        const cs = getComputedStyle(a);
        return {
          href: a.getAttribute("href")!,
          tags: (a.getAttribute("data-tags") || "").split(" ").filter(Boolean),
          fill: getComputedStyle(dot).fill,
          size: Math.max(r.width, r.height),
          round: Math.abs(r.width - r.height) < 0.5,
          opacity: Number(cs.opacity),
          tabindex: a.getAttribute("tabindex"),
          label: a.querySelector("text")!.getBoundingClientRect().toJSON() as { left: number; right: number; top: number; bottom: number },
        };
      }),
      axisFonts: [...fig.querySelectorAll("text.rr-tl__x, text.rr-tl__y, text.rr-tl__lbl")].map((t) => getComputedStyle(t).fontFamily),
    };
  });
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

    // Date's first click is newest first again; ties keep the page's order.
    await head("Date").click();
    now = await shown(page);
    expect(now.rows).toEqual(start.rows);
    expect(now.sort).toEqual(start.sort);
    await head("Date").click();
    now = await shown(page);
    expect(now.rows[0]).toBe("the-dao");
    expect(now.rows.at(-1)).toBe("new-market-trading");
    expect(now.sort[0]).toBe("ascending");
    expect(errors).toEqual([]);
  });

  test("a chip filters the index and fades the timeline, never a record; All brings them back", async ({ page }) => {
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

    // Every category chip, in turn: its rows and only its rows, every record,
    // its points bright and the rest faded out of the tab order.
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
      await expect.poll(async () => {
        const t = (await timeline(page))!;
        return t.points.every((p) => (p.tags.includes(tag) ? p.opacity === 1 && p.tabindex === null : p.opacity < 0.3 && p.tabindex === "-1"));
      }, { message: `${tag}: the timeline's points` }).toBe(true);
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
    await expect.poll(async () => (await timeline(page))!.points.every((p) => p.opacity === 1 && p.tabindex === null)).toBe(true);

    // A link from the index lands on its record while a filter is on, its
    // date clear of the fixed nav.
    await chips.nth(1).click();
    await page.locator('#view #incidents a[href="#drift-protocol"]').click();
    await expect.poll(() => page.evaluate(() => location.hash)).toBe("#drift-protocol");
    await expect(page.locator("#view h3#drift-protocol")).toBeInViewport();
    await expect(page.locator('#view article[aria-labelledby="drift-protocol"] time.rr-case__date')).toBeInViewport();
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

  test("the timeline: a Beacon point per case, linking its record", async ({ page }) => {
    await open(page);
    const t = (await timeline(page))!;
    expect(t.shown).toEqual(["rr-tl rr-tl--wide"]);
    expect(t.points).toHaveLength(17);
    const ids = await page.evaluate(() => [...document.querySelectorAll("#view article.rr-case h3[id]")].map((h) => `#${h.id}`));
    expect(t.points.map((p) => p.href).sort()).toEqual([...ids].sort());
    for (const p of t.points) {
      expect(p.fill, p.href).toBe(BEACON);
      expect(p.size, p.href).toBeGreaterThan(4);
      expect(p.size, p.href).toBeLessThanOrEqual(12);
      expect(p.round, `${p.href} is a round point, a reading`).toBe(true);
    }
    // No two labels overlap.
    const boxes = t.points.map((p) => p.label);
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const [a, b] = [boxes[i]!, boxes[j]!];
        const overlap = a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
        expect(overlap, `${t.points[i]!.href} and ${t.points[j]!.href}`).toBe(false);
      }
    }
    for (const f of t.axisFonts) expect(f).toMatch(/mono/i);

    // A point takes the keyboard, visibly: Shift+Tab from the first chip lands
    // on the timeline's last point.
    await page.locator("#view .rm-chips button.rm-chip").first().focus();
    await page.keyboard.press("Shift+Tab");
    const focused = await page.evaluate(() => {
      const a = document.activeElement!;
      return {
        inTimeline: !!a.closest("figure.rr-tl"),
        outline: getComputedStyle(a).outlineStyle,
        label: a.querySelector("text") ? getComputedStyle(a.querySelector("text")!).textDecorationLine : "",
      };
    });
    expect(focused.inTimeline).toBe(true);
    expect(focused.outline).toBe("solid");
    expect(focused.label).toBe("underline");
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

  test("the page keeps the covenant on its computed styles", async ({ page }) => {
    await open(page);
    // A filter on, so the pressed chip and the faded points are scanned too.
    await page.locator("#view .rm-chips button.rm-chip").nth(3).click();
    const findings = await page.evaluate((beacon) => {
      const CYAN = ["rgb(0, 229, 255)", "rgb(0, 184, 212)"];
      const BEACON = [beacon, "rgb(255, 102, 68)"];
      const out: string[] = [];
      const root = document.querySelector("#view section.rv")!;
      let scanned = 0;
      let points = 0;
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
        // Beacon marks the timeline's points and nothing else: a dot of at
        // most 12px, never a mass, a line or a note.
        const isPoint = el.matches("figure.rr-tl circle.rr-tl__dot");
        if (isPoint) {
          points++;
          if (cs.fill !== beacon) out.push(`a timeline point is not Beacon: ${cs.fill}`);
          if (Math.max(r.width, r.height) > 12) out.push(`a timeline point is ${Math.round(r.width)}px`);
        }
        const beaconHere = [cs.color, cs.backgroundColor, cs.borderTopColor, cs.borderLeftColor, cs.borderBottomColor].some((c) => BEACON.includes(c)) ||
          (svg && [cs.fill, cs.stroke].some((c) => BEACON.includes(c)));
        if (beaconHere && !isPoint) out.push(`Beacon on ${tag}`);
      }
      // A scan that reached nothing would pass on nothing.
      if (scanned < 500) out.push(`only ${scanned} elements scanned`);
      if (points !== 17) out.push(`${points} timeline points scanned, not 17`);
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

  test("the stacked timeline, the sort and the last row's rule on a phone", async ({ page }) => {
    await open(page);
    const t = (await timeline(page))!;
    expect(t.shown).toEqual(["rr-tl rr-tl--narrow"]);
    expect(t.points).toHaveLength(17);
    for (const p of t.points) {
      expect(p.fill).toBe(BEACON);
      expect(p.size).toBeLessThanOrEqual(12);
      expect(p.label.right, p.href).toBeLessThanOrEqual(390);
      expect(p.label.left, p.href).toBeGreaterThanOrEqual(0);
    }
    for (let i = 0; i < t.points.length; i++) {
      for (let j = i + 1; j < t.points.length; j++) {
        const [a, b] = [t.points[i]!.label, t.points[j]!.label];
        expect(a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom, `${t.points[i]!.href} and ${t.points[j]!.href}`).toBe(false);
      }
    }
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
});
