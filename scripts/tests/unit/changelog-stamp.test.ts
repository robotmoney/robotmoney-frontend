// scripts/changelog-stamp.ts dates the changelog's pending release on release
// day. Two shapes matter: the release lands in a month the log does not have
// yet (the block becomes that month), or in the month already on top (the
// block merges into it, entries first and Also lines at the top of each list).
// Pure string work over fixtures, plus one pass over a temp copy of the real
// page while it has a pending block, and the CLI against a temp file.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHANGELOG_PATH, SITEMAP_PATH, StampError, monthDivider, parseReleaseDate, stampChangelog, stampSitemap } from "../../changelog-stamp.ts";

const SCRIPT = join(import.meta.dir, "..", "..", "changelog-stamp.ts");

const entry = (id: string, meta: string, title: string) => `        <article class="cl__entry" id="${id}" data-tags="swarm"${id.startsWith("next-") ? ' data-release="pending"' : ""} x-show="has($el)">
          <div class="cl__meta">${meta}<span class="cl__sep">/</span><span>Swarm</span></div>
          <h3 class="cl__title"><a href="#${id}">${title}</a></h3>
          <p>${title} body.</p>
        </article>`;
const pendingMeta = '<span class="cl__pending" data-release="pending">Next release</span>';
const time = (iso: string, label: string) => `<time datetime="${iso}">${label}</time>`;

const PENDING = `        <!-- release:pending -->
        ${monthDivider("Next release")}
        <h2 class="cl__month-h" data-release="pending" x-show="!tag">Next release</h2>

${entry("next-research-records", pendingMeta, "Research records")}

${entry("next-against-the-target", pendingMeta, "Against the target")}

        <div class="cl__also" data-release="pending" x-show="!tag">
          <h3 class="cl__also-h">Also in the next release</h3>
          <h4 class="cl__also-k">Improvements</h4>
          <ul>
            <li>New improvement A.</li>
            <li>New improvement B.</li>
          </ul>
          <h4 class="cl__also-k">Fixes</h4>
          <ul>
            <li>New fix.</li>
          </ul>
        </div>
        <!-- /release:pending -->
`;

const SEPTEMBER_ALSO = `        <div class="cl__also" x-show="!tag">
          <h3 class="cl__also-h">Also in September</h3>
          <h4 class="cl__also-k">Improvements</h4>
          <ul>
            <li>Old improvement.</li>
          </ul>
          <h4 class="cl__also-k">Fixes</h4>
          <ul>
            <li>Old fix.</li>
          </ul>
        </div>

`;

function page(opts: { pending?: string; septemberAlso?: string } = {}): string {
  return `<section class="cl" x-data="changelogPage()">
  <header class="cl__hero">
      <p class="cl__updated">Updated <span class="cl__pending" data-release="pending">with the next release</span></p>
  </header>
      <div class="cl__log" x-ref="log">

${opts.pending ?? PENDING}
        ${monthDivider("September 2026")}
        <h2 class="cl__month-h" x-show="!tag">September 2026</h2>

${entry("2026-09-21-a-new-allocation-page", time("2026-09-21", "21 Sep 2026"), "A new allocation page")}

${entry("2026-09-04-site-readable", time("2026-09-04", "4 Sep 2026"), "Site readable")}

${opts.septemberAlso ?? SEPTEMBER_ALSO}        ${monthDivider("August 2026")}
        <h2 class="cl__month-h" x-show="!tag">August 2026</h2>

${entry("2026-08-31-ecosystem-august", time("2026-08-31", "31 Aug 2026"), "Ecosystem, August")}

      </div>
</section>
`;
}

function noPendingTrace(html: string): void {
  expect(html).not.toContain('data-release="pending"');
  expect(html).not.toContain("<!-- release:pending -->");
  expect(html).not.toContain("<!-- /release:pending -->");
  expect(html).not.toContain('id="next-');
  expect(html).not.toContain('href="#next-');
  expect(html).not.toContain('class="cl__pending"');
  expect(html).not.toContain(">Next release<");
  expect(html).not.toContain(">Also in the next release<");
}

const ids = (html: string) => [...html.matchAll(/<article class="cl__entry" id="([^"]+)"/g)].map((m) => m[1]);
const months = (html: string) => [...html.matchAll(/<h2 class="cl__month-h"[^>]*>([^<]+)<\/h2>/g)].map((m) => m[1]);
const listUnder = (html: string, alsoHeading: string, label: string) => {
  const also = new RegExp(`<h3 class="cl__also-h">${alsoHeading}</h3>[\\s\\S]*?</div>`).exec(html)?.[0] ?? "";
  const ul = new RegExp(`<h4 class="cl__also-k">${label}</h4>\\s*<ul>([\\s\\S]*?)</ul>`).exec(also)?.[1] ?? "";
  return [...ul.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => m[1]);
};

describe("a release in a new month becomes that month's section", () => {
  const { html, mode, month, entries, improvements, fixes } = stampChangelog(page(), "2026-10-02");

  test("reports what it did", () => {
    expect({ mode, month, entries, improvements, fixes }).toEqual({ mode: "new", month: "October 2026", entries: 2, improvements: 2, fixes: 1 });
  });

  test("the heading, the divider and the Also block name the month", () => {
    expect(months(html)).toEqual(["October 2026", "September 2026", "August 2026"]);
    expect(html).toContain(monthDivider("October 2026"));
    expect(html).toContain('<h3 class="cl__also-h">Also in October</h3>');
    expect(listUnder(html, "Also in October", "Improvements")).toEqual(["New improvement A.", "New improvement B."]);
    expect(listUnder(html, "Also in October", "Fixes")).toEqual(["New fix."]);
  });

  test("each entry gets the date, a dated id and a matching permalink", () => {
    expect(ids(html)).toEqual([
      "2026-10-02-research-records",
      "2026-10-02-against-the-target",
      "2026-09-21-a-new-allocation-page",
      "2026-09-04-site-readable",
      "2026-08-31-ecosystem-august",
    ]);
    expect(html).toContain('<a href="#2026-10-02-research-records">');
    expect(html).toContain('<a href="#2026-10-02-against-the-target">');
    expect(html.match(/<div class="cl__meta"><time datetime="2026-10-02">2 Oct 2026<\/time>/g)).toHaveLength(2);
  });

  test("the hero carries the day in full", () => {
    expect(html).toContain('<p class="cl__updated">Updated <time datetime="2026-10-02">2 October 2026</time></p>');
  });

  test("nothing pending is left, and September is untouched", () => {
    noPendingTrace(html);
    expect(listUnder(html, "Also in September", "Improvements")).toEqual(["Old improvement."]);
    expect(listUnder(html, "Also in September", "Fixes")).toEqual(["Old fix."]);
  });
});

describe("a release in the month on top merges into it", () => {
  const { html, mode, month } = stampChangelog(page(), "2026-09-29");

  test("no second heading: one September, its entries first", () => {
    expect({ mode, month }).toEqual({ mode: "merged", month: "September 2026" });
    expect(months(html)).toEqual(["September 2026", "August 2026"]);
    expect(html.match(/<!-- ── September 2026 /g)).toHaveLength(1);
    expect(ids(html)).toEqual([
      "2026-09-29-research-records",
      "2026-09-29-against-the-target",
      "2026-09-21-a-new-allocation-page",
      "2026-09-04-site-readable",
      "2026-08-31-ecosystem-august",
    ]);
    expect(html).toContain('<div class="cl__meta"><time datetime="2026-09-29">29 Sep 2026</time>');
  });

  test("the pending Also lines go to the top of the month's lists, and its Also block is gone", () => {
    expect(listUnder(html, "Also in September", "Improvements")).toEqual(["New improvement A.", "New improvement B.", "Old improvement."]);
    expect(listUnder(html, "Also in September", "Fixes")).toEqual(["New fix.", "Old fix."]);
    expect(html.match(/<div class="cl__also"/g)).toHaveLength(1);
  });

  test("the hero is dated and nothing pending is left", () => {
    expect(html).toContain('Updated <time datetime="2026-09-29">29 September 2026</time>');
    noPendingTrace(html);
  });

  test("a month with no Fixes list gets one, last in its Also block", () => {
    const noFixes = SEPTEMBER_ALSO.replace(/\s*<h4 class="cl__also-k">Fixes<\/h4>\s*<ul>[\s\S]*?<\/ul>/, "");
    const out = stampChangelog(page({ septemberAlso: noFixes }), "2026-09-29").html;
    expect(listUnder(out, "Also in September", "Improvements")).toEqual(["New improvement A.", "New improvement B.", "Old improvement."]);
    expect(listUnder(out, "Also in September", "Fixes")).toEqual(["New fix."]);
    const also = /<div class="cl__also"[\s\S]*?<\/div>/.exec(out)![0];
    expect(also.indexOf("Improvements")).toBeLessThan(also.indexOf("Fixes"));
  });

  test("a month with no Also block gets one, after its last entry", () => {
    const out = stampChangelog(page({ septemberAlso: "" }), "2026-09-29").html;
    expect(listUnder(out, "Also in September", "Improvements")).toEqual(["New improvement A.", "New improvement B."]);
    expect(listUnder(out, "Also in September", "Fixes")).toEqual(["New fix."]);
    const september = out.slice(out.indexOf("September 2026</h2>"), out.indexOf("<!-- ── August"));
    expect(september.lastIndexOf("</article>")).toBeLessThan(september.indexOf('<div class="cl__also"'));
    noPendingTrace(out);
  });

  test("an unlabelled Also list is refused rather than guessed at", () => {
    const bare = `        <div class="cl__also" x-show="!tag">
          <h3 class="cl__also-h">Also in September</h3>
          <ul>
            <li>Old line.</li>
          </ul>
        </div>

`;
    expect(() => stampChangelog(page({ septemberAlso: bare }), "2026-09-29")).toThrow(/unlabelled list/);
  });

  test("an unlabelled pending Also line is refused, in either shape, rather than dropped", () => {
    const bare = PENDING.replace(/(<h3 class="cl__also-h">Also in the next release<\/h3>\n)/, "$1          <ul>\n            <li>Unlabelled line.</li>\n          </ul>\n");
    for (const day of ["2026-09-29", "2026-10-02"]) {
      expect(() => stampChangelog(page({ pending: bare }), day)).toThrow(/outside an Improvements or Fixes list/);
    }
  });
});

describe("it refuses what it cannot stamp", () => {
  test("a malformed or impossible date", () => {
    for (const bad of ["2026-9-29", "29-09-2026", "2026-02-30", "2026-13-01", "tomorrow", ""]) {
      expect(() => parseReleaseDate(bad)).toThrow(StampError);
      expect(() => stampChangelog(page(), bad)).toThrow(StampError);
    }
    expect(parseReleaseDate("2028-02-29")).toEqual({ iso: "2028-02-29", year: 2028, month: 2, day: 29 });
  });

  test("a page with nothing pending, including one it already stamped", () => {
    const stamped = stampChangelog(page(), "2026-10-02").html;
    expect(() => stampChangelog(stamped, "2026-10-03")).toThrow(/nothing pending/);
    const empty = "        <!-- release:pending -->\n        <!-- /release:pending -->\n";
    expect(() => stampChangelog(page({ pending: empty }), "2026-10-02")).toThrow(/nothing pending/);
  });

  test("a date older than the newest dated entry", () => {
    expect(() => stampChangelog(page(), "2026-09-20")).toThrow(/older than the newest dated entry \(2026-09-21\)/);
  });
});

describe("the CLI writes the file, and writes nothing when it refuses", () => {
  test("stamps a copy in place, then refuses a second run", () => {
    const dir = mkdtempSync(join(tmpdir(), "changelog-stamp-"));
    try {
      const file = join(dir, "changelog.html");
      writeFileSync(file, page());
      const bad = Bun.spawnSync(["bun", SCRIPT, "2026-10-32", "--file", file], { stdout: "pipe", stderr: "pipe" });
      expect(bad.exitCode).toBe(1);
      expect(readFileSync(file, "utf8")).toBe(page());

      const ok = Bun.spawnSync(["bun", SCRIPT, "2026-10-02", "--file", file], { stdout: "pipe", stderr: "pipe" });
      expect(ok.exitCode).toBe(0);
      expect(new TextDecoder().decode(ok.stdout)).toContain("as October 2026");
      const out = readFileSync(file, "utf8");
      expect(out).toContain('id="2026-10-02-research-records"');
      noPendingTrace(out);

      const again = Bun.spawnSync(["bun", SCRIPT, "2026-10-03", "--file", file], { stdout: "pipe", stderr: "pipe" });
      expect(again.exitCode).toBe(1);
      expect(new TextDecoder().decode(again.stderr)).toContain("nothing pending");
      expect(readFileSync(file, "utf8")).toBe(out);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the sitemap's changelog lastmod moves with the stamp", () => {
  const xml = `<urlset>
  <url><loc>https://robotmoney.network/faq</loc><lastmod>2026-09-11</lastmod></url>
  <url><loc>https://robotmoney.network/changelog</loc><lastmod>2026-09-11</lastmod><changefreq>weekly</changefreq></url>
</urlset>
`;

  test("only the changelog's lastmod takes the day", () => {
    const out = stampSitemap(xml, "2026-10-02");
    expect(out).toContain("<loc>https://robotmoney.network/changelog</loc><lastmod>2026-10-02</lastmod>");
    expect(out).toContain("<loc>https://robotmoney.network/faq</loc><lastmod>2026-09-11</lastmod>");
    expect(out.length).toBe(xml.length);
  });

  test("it refuses a bad date or a sitemap without the entry", () => {
    expect(() => stampSitemap(xml, "2026-02-30")).toThrow(StampError);
    expect(() => stampSitemap(xml.replace("/changelog", "/changes"), "2026-10-02")).toThrow(/no changelog <lastmod>/);
  });

  test("the shipped sitemap has the entry the stamp rewrites", () => {
    expect(() => stampSitemap(readFileSync(SITEMAP_PATH, "utf8"), "2026-10-02")).not.toThrow();
  });
});

describe("the shipped page stamps cleanly while it has a pending block", () => {
  const real = readFileSync(CHANGELOG_PATH, "utf8");
  const pending = real.includes("<!-- release:pending -->");

  test.skipIf(!pending)("both shapes leave a well-formed log with nothing pending", () => {
    const newest = [...real.matchAll(/<div class="cl__meta"><time datetime="(\d{4}-\d{2}-\d{2})">/g)].map((m) => m[1]).sort().at(-1)!;
    const topMonth = /<h2 class="cl__month-h" x-show="!tag">([^<]+)<\/h2>/.exec(real)![1];
    const before = ids(real).length;
    // The newest entry's own day merges into its month; the first of the
    // following month opens a new one.
    const [y, m] = newest.split("-").map(Number);
    const nextMonth = `${m === 12 ? y + 1 : y}-${String((m % 12) + 1).padStart(2, "0")}-01`;
    for (const [day, expectMode] of [[newest, "merged"], [nextMonth, "new"]] as const) {
      const r = stampChangelog(real, day);
      expect(r.mode).toBe(expectMode);
      noPendingTrace(r.html);
      expect(ids(r.html)).toHaveLength(before);
      expect(new Set(ids(r.html)).size).toBe(before);
      const heads = months(r.html);
      expect(new Set(heads).size).toBe(heads.length);
      expect(heads[expectMode === "merged" ? 0 : 1]).toBe(topMonth);
    }
  });
});
