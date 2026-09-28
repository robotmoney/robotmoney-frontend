// The smart contract risks page on the research record (RM-138): an index of
// its cases that filters by attack category, then every case as one record.
//
// Runs against a plain static server with /api answering 503, as
// heading-anchors.spec.ts does: the page is static prose and needs no data.
// Specs enter at "/" and move in-app from there.
//
// What only a browser shows, so it is asserted here and nowhere else:
//   - the filter hides index rows and never a record, and All brings every
//     row back;
//   - nothing runs past a phone's edge (a hash or an address in a list, an
//     amount in the facts); .rv__body.rr clips sideways overflow, so a page
//     with no scrollbar can still be cutting text off, and each box is
//     measured as well;
//   - the covenant, on computed styles: no shadow, gradient or rounded corner,
//     no cyan area, no cyan figure or link, no Beacon.
import { expect, test, type Page } from "@playwright/test";
import { navigate } from "./navigation.ts";

const ROUTE = "/smart-contract-risks";

async function open(page: Page) {
  await page.goto("/");
  await navigate(page, ROUTE);
  await expect(page.locator("#view h1.rv__title")).toHaveText("Smart Contract Risks");
}

/** Which index rows and which records are on screen. */
async function shown(page: Page) {
  return page.evaluate(() => {
    const visible = (el: Element) => (el as HTMLElement).offsetParent !== null && getComputedStyle(el).display !== "none";
    const rows = [...document.querySelectorAll("#view #incidents tbody tr")];
    return {
      rows: rows.filter(visible).map((tr) => tr.querySelector("th a")!.getAttribute("href")!.slice(1)),
      tags: rows.map((tr) => ({ id: tr.querySelector("th a")!.getAttribute("href")!.slice(1), tags: (tr.getAttribute("data-tags") || "").split(" ").filter(Boolean) })),
      records: [...document.querySelectorAll("#view article.rr-case")].filter(visible).length,
      spoken: document.querySelector("#view .rm-visually-hidden[aria-live]")?.textContent ?? null,
    };
  });
}

test.describe("desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("a chip hides the index rows outside its category and never a record; All brings them back", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    // The site nav asks /api for the vaults' values, which a static server
    // answers 503; that failed load is the only console error expected here.
    page.on("console", (m) => { if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) errors.push(m.text()); });
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

    // Every category chip, in turn: its rows and only its rows, every record.
    for (let i = 1; i < 9; i++) {
      const chip = chips.nth(i);
      const tag = await chip.evaluate((b) => /toggle\('([^']+)'\)/.exec(b.getAttribute("@click") || "")![1]!);
      await chip.click();
      await expect(chip).toHaveAttribute("aria-pressed", "true");
      await expect(all).toHaveAttribute("aria-pressed", "false");
      const now = await shown(page);
      const want = start.tags.filter((r) => r.tags.includes(tag)).map((r) => r.id);
      expect(want.length, `${tag} files no case`).toBeGreaterThan(0);
      expect(now.rows, tag).toEqual(want);
      expect(now.records, `${tag} hid a record`).toBe(17);
      expect(now.spoken).toBe(`${want.length} of 17 incidents`);
      // The chip names its category in full for a screen reader.
      const full = await page.locator(`#view h4#${tag}`).textContent();
      await expect(chip).toHaveAttribute("aria-label", full!.trim());
    }

    // A second press on the chip in force, then All, each restore every row.
    const last = chips.nth(8);
    await last.click();
    await expect(all).toHaveAttribute("aria-pressed", "true");
    expect((await shown(page)).rows).toHaveLength(17);
    await chips.nth(3).click();
    expect((await shown(page)).rows.length).toBeLessThan(17);
    await all.click();
    await expect(all).toHaveAttribute("aria-pressed", "true");
    const end = await shown(page);
    expect(end.rows).toHaveLength(17);
    expect(end.spoken).toBe("");

    // A link from the index lands on its record while a filter is on.
    await chips.nth(1).click();
    await page.locator('#view #incidents a[href="#drift-protocol"]').click();
    await expect.poll(() => page.evaluate(() => location.hash)).toBe("#drift-protocol");
    await expect(page.locator("#view h3#drift-protocol")).toBeInViewport();
    expect(errors).toEqual([]);
  });

  test("the page keeps the covenant on its computed styles", async ({ page }) => {
    await open(page);
    // A filter on, so the pressed chip is scanned too.
    await page.locator("#view .rm-chips button.rm-chip").nth(3).click();
    const findings = await page.evaluate(() => {
      const CYAN = ["rgb(0, 229, 255)", "rgb(0, 184, 212)"];
      const BEACON = ["rgb(255, 122, 41)", "rgb(255, 102, 68)"];
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
        if (cs.boxShadow !== "none") out.push(`box-shadow on ${tag}`);
        if (cs.backgroundImage !== "none") out.push(`gradient or image on ${tag}: ${cs.backgroundImage}`);
        for (const c of ["borderTopLeftRadius", "borderTopRightRadius", "borderBottomLeftRadius", "borderBottomRightRadius"] as const) {
          if (cs[c] !== "0px") { out.push(`rounded ${tag}: ${cs[c]}`); break; }
        }
        if (CYAN.includes(cs.backgroundColor) && r.width * r.height > 200) out.push(`cyan area on ${tag}: ${Math.round(r.width * r.height)}px²`);
        if (CYAN.includes(cs.color) && own && /[0-9]/.test(own)) out.push(`cyan figure in ${tag}: "${own}"`);
        if (CYAN.includes(cs.color) && el.tagName === "A") out.push(`cyan link: "${el.textContent}"`);
        if (CYAN.includes(cs.borderBottomColor) && el.tagName === "A") out.push(`cyan underline: "${el.textContent}"`);
        if ([cs.color, cs.backgroundColor, cs.borderTopColor, cs.borderLeftColor].some((c) => BEACON.includes(c))) out.push(`Beacon on ${tag}`);
      }
      // A scan that reached nothing would pass on nothing.
      if (scanned < 500) out.push(`only ${scanned} elements scanned`);
      // Rules divide, they never close: the index's last row draws no line.
      for (const cell of document.querySelectorAll("#view #incidents tbody tr:last-of-type > *")) {
        if (getComputedStyle(cell).borderBottomWidth !== "0px") out.push("the index's last row closes with a rule");
      }
      // Figures in mono: dates and amounts in the index and the facts.
      for (const el of document.querySelectorAll("#view #incidents td:nth-of-type(1), #view #incidents td:last-of-type, #view .rr-case .rr-dl dd.rr-mono, #view .rr-case time")) {
        if (!/mono/i.test(getComputedStyle(el).fontFamily)) out.push(`a figure out of mono: "${el.textContent}"`);
      }
      return out;
    });
    expect(findings).toEqual([]);
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
});
