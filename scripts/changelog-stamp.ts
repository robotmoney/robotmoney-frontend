// Dates the changelog's pending release on release day.
//
//   bun scripts/changelog-stamp.ts YYYY-MM-DD [--file path/to/changelog.html]
//
// frontend/public/views/changelog.html keeps merged-but-unreleased work in one
// block at the top of its log, between `<!-- release:pending -->` and
// `<!-- /release:pending -->`: a "Next release" heading, entries whose id is
// `next-<slug>` and whose meta carries `<span class="cl__pending">Next
// release</span>` where the date goes, and an "Also in the next release" list.
// The hero reads "Updated with the next release".
//
// Stamping rewrites that block for the given day:
//   - each pending meta span becomes `<time datetime="YYYY-MM-DD">D Mon YYYY</time>`;
//   - each `next-<slug>` id and its permalink become `YYYY-MM-DD-<slug>`;
//   - the hero becomes `<time datetime="YYYY-MM-DD">D Month YYYY</time>`;
//   - the heading becomes the month ("October 2026") and the Also block
//     "Also in October", OR, when the first month below is that same month,
//     the block merges into it: its entries go to the top of the month, its
//     Improvements and Fixes go to the top of the month's lists (a list or the
//     whole Also block is created when missing), and its own heading and Also
//     block are dropped;
//   - the markers go.
// Run on the shipped page (no --file), it also dates the changelog's
// <lastmod> in frontend/public/sitemap.xml. It writes neither file unless both
// stamp cleanly. The stamp commit goes onto the release branch before the tag.
//
// It refuses a malformed date, a date older than the newest dated entry, a
// pending Also line outside an Improvements or Fixes list, and a page with
// nothing pending. It is not idempotent: a second run finds nothing
// pending and refuses. scripts/tests/unit/changelog-stamp.test.ts pins both
// the new-month and the same-month shapes.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const CHANGELOG_PATH = join(import.meta.dir, "..", "frontend", "public", "views", "changelog.html");
export const SITEMAP_PATH = join(import.meta.dir, "..", "frontend", "public", "sitemap.xml");

const OPEN = "<!-- release:pending -->";
const CLOSE = "<!-- /release:pending -->";
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
// The month dividers are 74 characters from "<!--" to "-->", after the indent.
const DIVIDER_WIDTH = 74;
const LI_INDENT = "            ";

export class StampError extends Error {}

export interface ReleaseDate {
  iso: string;
  year: number;
  /** 1-12 */
  month: number;
  day: number;
}

/** A calendar day in YYYY-MM-DD, or a StampError. */
export function parseReleaseDate(input: string): ReleaseDate {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input ?? "");
  if (!m) throw new StampError(`not a date in YYYY-MM-DD: ${JSON.stringify(input)}`);
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    throw new StampError(`not a calendar day: ${input}`);
  }
  return { iso: input, year, month, day };
}

const monthName = (d: ReleaseDate) => MONTHS[d.month - 1];
/** The entry meta's format: "2 Oct 2026". */
export const metaDate = (d: ReleaseDate) => `${d.day} ${monthName(d).slice(0, 3)} ${d.year}`;
/** The hero's format: "2 October 2026". */
export const heroDate = (d: ReleaseDate) => `${d.day} ${monthName(d)} ${d.year}`;

export function monthDivider(label: string): string {
  const head = `<!-- ── ${label} `;
  const tail = " -->";
  return head + "─".repeat(Math.max(3, DIVIDER_WIDTH - head.length - tail.length)) + tail;
}

/** The <li> elements of the list under an Also block's `<h4>` label, or null when the label is absent. */
function labelledItems(also: string, label: string): string[] | null {
  const m = new RegExp(`<h4 class="cl__also-k">${label}</h4>\\s*<ul>([\\s\\S]*?)</ul>`).exec(also);
  if (!m) return null;
  return m[1].match(/<li>[\s\S]*?<\/li>/g) ?? [];
}

const liLines = (items: string[]) => items.map((li) => `${LI_INDENT}${li}\n`).join("");

/** Puts `items` at the top of the Also block's `label` list, creating the list when it is missing. */
function prependToList(also: string, label: "Improvements" | "Fixes", items: string[]): string {
  if (!items.length) return also;
  const head = new RegExp(`(<h4 class="cl__also-k">${label}</h4>\\s*<ul>\\n)`);
  if (head.test(also)) return also.replace(head, (open) => open + liLines(items));
  const list = `          <h4 class="cl__also-k">${label}</h4>\n          <ul>\n${liLines(items)}          </ul>\n`;
  if (label === "Improvements") {
    // First under the block's heading, above any Fixes.
    return also.replace(/(<h3 class="cl__also-h">[^<]*<\/h3>\n)/, (h3) => h3 + list);
  }
  // Last in the block.
  return also.replace(/(\n[ \t]*<\/div>)$/, (close) => `\n${list.replace(/\n$/, "")}${close}`);
}

export interface StampResult {
  html: string;
  entries: number;
  improvements: number;
  fixes: number;
  /** "new" when the block became its own month, "merged" when it joined an existing one. */
  mode: "new" | "merged";
  month: string;
}

export function stampChangelog(html: string, isoDate: string): StampResult {
  const date = parseReleaseDate(isoDate);
  const open = html.indexOf(OPEN);
  const close = html.indexOf(CLOSE);
  if (open < 0 && close < 0) throw new StampError("nothing pending: the changelog has no release:pending block");
  if (open < 0 || close < 0 || close < open) throw new StampError("the release:pending markers are unbalanced");
  if (html.indexOf(OPEN, open + OPEN.length) >= 0) throw new StampError("more than one release:pending block");

  // The newest dated entry bounds the stamp: the log is newest first.
  const dated = [...html.matchAll(/<div class="cl__meta"><time datetime="(\d{4}-\d{2}-\d{2})">/g)].map((m) => m[1]).sort();
  const newest = dated.at(-1);
  if (newest && date.iso < newest) {
    throw new StampError(`${date.iso} is older than the newest dated entry (${newest}); the log is newest first`);
  }

  // Cut the block out by whole lines, markers included.
  const startLine = html.lastIndexOf("\n", open) + 1;
  const closeEol = html.indexOf("\n", close);
  const endLine = closeEol < 0 ? html.length : closeEol + 1;
  const before = html.slice(0, startLine);
  let block = html.slice(startLine, endLine);
  let after = html.slice(endLine);

  block = block.replace(/^[ \t]*<!-- \/?release:pending -->\n?/gm, "");
  const divider = /^[ \t]*<!-- ── [^\n]*? ─+ -->\n/m;
  const heading = /^[ \t]*<h2 class="cl__month-h" data-release="pending"[^>]*>[^<]*<\/h2>\n/m;
  const alsoRe = /^[ \t]*<div class="cl__also" data-release="pending"[^>]*>[\s\S]*?<\/div>\n?/m;
  const alsoBlock = alsoRe.exec(block)?.[0] ?? "";
  const improvements = labelledItems(alsoBlock, "Improvements") ?? [];
  const fixes = labelledItems(alsoBlock, "Fixes") ?? [];
  // A line outside both lists would be kept by a new month and silently lost
  // by a merge, so neither shape takes one.
  const alsoLines = (alsoBlock.match(/<li[\s>]/g) ?? []).length;
  if (alsoLines !== improvements.length + fixes.length) {
    throw new StampError("the pending Also block has lines outside an Improvements or Fixes list; label them before stamping");
  }
  const entryCount = (block.match(/<article class="cl__entry"/g) ?? []).length;
  if (!entryCount && !improvements.length && !fixes.length) {
    throw new StampError("nothing pending: the release:pending block holds no entries and no Also lines");
  }

  // Date every entry in the block.
  const stampEntries = (s: string) =>
    s
      .replace(/<span class="cl__pending" data-release="pending">[^<]*<\/span>/g, `<time datetime="${date.iso}">${metaDate(date)}</time>`)
      .replace(/(id="|href="#)next-([a-z0-9][a-z0-9-]*)"/g, (_m, lead: string, slug: string) => `${lead}${date.iso}-${slug}"`)
      .replace(/ data-release="pending"/g, "");

  const month = `${monthName(date)} ${date.year}`;
  const first = /<h2 class="cl__month-h"[^>]*>([^<]+)<\/h2>\n?/.exec(after);
  let mode: StampResult["mode"];

  if (first && first[1].trim() === month) {
    // Same month: fold the block into the section below it.
    mode = "merged";
    const entries = stampEntries(block.replace(divider, "").replace(heading, "").replace(alsoRe, ""))
      .replace(/^\s*\n/, "")
      .replace(/\s+$/, "");
    const headingEnd = first.index + first[0].length;
    if (entries) after = after.slice(0, headingEnd) + "\n" + entries + "\n" + after.slice(headingEnd);

    // The month's section runs from its heading to the next divider or month
    // heading, the entries just placed included.
    const bodyStart = headingEnd;
    const pastEntries = headingEnd + (entries ? entries.length + 2 : 0);
    const next = after.slice(pastEntries).search(/[ \t]*<!-- ── |<h2 class="cl__month-h"/);
    const sectionEnd = next < 0 ? after.length : pastEntries + next;
    const section = after.slice(bodyStart, sectionEnd);

    if (improvements.length || fixes.length) {
      const also = /[ \t]*<div class="cl__also"[^>]*>[\s\S]*?<\/div>/.exec(section);
      let updated: string;
      let at: number;
      let len: number;
      if (also) {
        const hasLabels = /<h4 class="cl__also-k">/.test(also[0]);
        if (!hasLabels && /<ul>/.test(also[0])) {
          throw new StampError(
            `Also in ${monthName(date)} has an unlabelled list; split it into Improvements and Fixes before stamping`,
          );
        }
        updated = prependToList(prependToList(also[0], "Improvements", improvements), "Fixes", fixes);
        at = bodyStart + also.index;
        len = also[0].length;
      } else {
        // No Also block yet: one goes after the month's last entry.
        const lastEnd = section.lastIndexOf("</article>");
        if (lastEnd < 0) throw new StampError(`${month} has no entries to place an Also block after`);
        let block2 = `\n\n        <div class="cl__also" x-show="!tag">\n          <h3 class="cl__also-h">Also in ${monthName(date)}</h3>\n        </div>`;
        block2 = prependToList(prependToList(block2, "Improvements", improvements), "Fixes", fixes);
        updated = block2;
        at = bodyStart + lastEnd + "</article>".length;
        len = 0;
      }
      after = after.slice(0, at) + updated + after.slice(at + len);
    }
    // The blank line that preceded the removed block stays; drop the one it leaves doubled.
    const joined = before.replace(/\n[ \t]*\n$/, "\n\n") + after.replace(/^\n+/, "");
    return { html: stampHero(joined, date), entries: entryCount, improvements: improvements.length, fixes: fixes.length, mode, month };
  }

  // A new month: the block becomes its section.
  mode = "new";
  if (!heading.test(block)) throw new StampError("the release:pending block has no pending month heading to rename");
  block = block
    .replace(divider, (line) => line.replace(/<!-- ── [\s\S]*? -->/, monthDivider(month)))
    .replace(heading, (line) => line.replace(/ data-release="pending"/, "").replace(/>[^<]*<\/h2>/, `>${month}</h2>`))
    .replace(/(<h3 class="cl__also-h">)[^<]*(<\/h3>)/, `$1Also in ${monthName(date)}$2`);
  block = stampEntries(block);
  return { html: stampHero(before + block + after, date), entries: entryCount, improvements: improvements.length, fixes: fixes.length, mode, month };
}

const CHANGELOG_LASTMOD = /(<loc>https:\/\/robotmoney\.network\/changelog<\/loc><lastmod>)\d{4}-\d{2}-\d{2}(<\/lastmod>)/;

/** The sitemap with the changelog's <lastmod> set to the release day. */
export function stampSitemap(xml: string, isoDate: string): string {
  const date = parseReleaseDate(isoDate);
  if (!CHANGELOG_LASTMOD.test(xml)) throw new StampError("sitemap.xml has no changelog <lastmod> where the stamp expects it");
  return xml.replace(CHANGELOG_LASTMOD, `$1${date.iso}$2`);
}

function stampHero(html: string, date: ReleaseDate): string {
  const hero = /(<p class="cl__updated">Updated )(?:<span class="cl__pending"[^>]*>[^<]*<\/span>|<time datetime="[^"]*">[^<]*<\/time>)(<\/p>)/;
  if (!hero.test(html)) throw new StampError("the hero's Updated line is not where the stamp expects it");
  const out = html.replace(hero, `$1<time datetime="${date.iso}">${heroDate(date)}</time>$2`);
  const leftover = [/data-release="pending"/, /<!-- \/?release:pending -->/, /id="next-/, /href="#next-/, /class="cl__pending"/].find((re) => re.test(out));
  if (leftover) throw new StampError(`stamping left a pending trace behind (${leftover.source}); nothing written`);
  return out;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const fileAt = args.indexOf("--file");
  const file = fileAt >= 0 ? args[fileAt + 1] : CHANGELOG_PATH;
  const positional = fileAt >= 0 ? [...args.slice(0, fileAt), ...args.slice(fileAt + 2)] : args;
  const dateArg = positional[0];
  if (!dateArg || !file || positional.length > 1) {
    console.error("usage: bun scripts/changelog-stamp.ts YYYY-MM-DD [--file path/to/changelog.html]");
    process.exit(2);
  }
  try {
    const result = stampChangelog(readFileSync(file, "utf8"), dateArg);
    // The shipped page's sitemap entry moves with it; a --file copy has none.
    const sitemap = fileAt < 0 ? stampSitemap(readFileSync(SITEMAP_PATH, "utf8"), dateArg) : null;
    writeFileSync(file, result.html);
    if (sitemap !== null) writeFileSync(SITEMAP_PATH, sitemap);
    const how = result.mode === "merged" ? `merged into ${result.month}` : `as ${result.month}`;
    console.log(
      `stamped ${result.entries} entries, ${result.improvements} improvements and ${result.fixes} fixes for ${dateArg}, ${how}: ${file}`,
    );
    if (sitemap !== null) console.log(`dated the changelog's lastmod: ${SITEMAP_PATH}`);
  } catch (err) {
    if (err instanceof StampError) {
      console.error(`changelog-stamp: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}
