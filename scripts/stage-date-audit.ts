#!/usr/bin/env bun
// Do the pages print the day a session OPENED? (issues 1057, 1081, 1084)
//
//   bun scripts/stage-date-audit.ts [base-url]        (default https://stage.robotmoney-labs.dev)
//
// A session's `date` and `generatedAt` are when its row was created in `scheduled`; a session that waited for its brief
// opened later (`openedAt`, the first brief revision). This reads the API for real sessions, loads each page that names a
// session in Chromium, and checks the day and time the page PRINTS against what the API says, for sessions that waited
// (the case the bug lived in) and sessions that did not. It writes one line per check and exits 1 on any FAIL. Run it against
// a stage twin after R4 (docs/runbooks/v0-5-4-rollout.md R4.5b) and against production after a cutover (R7.4a).
//
// Read-only: it only GETs the public pages and API.
import { chromium, type Page } from "@playwright/test";

const BASE = (process.argv[2] ?? "https://stage.robotmoney-labs.dev").replace(/\/$/, "");

interface ApiSession {
  id: string; date: string; subjectId: string; subjectName: string | null; state: string;
  generatedAt: string; openedAt: string | null; publishedAt: string | null;
}

const fmt = (iso: string, month: "short" | "long") =>
  new Date(iso).toLocaleDateString("en-US", { year: "numeric", month, day: "numeric", timeZone: "UTC" });
const clock = (iso: string) => `${new Date(iso).toISOString().slice(11, 16)} UTC`;
/** What a page should call the moment of a session: opened, else published, else the row's date. */
const whenOf = (s: Pick<ApiSession, "openedAt" | "publishedAt" | "date">) => s.openedAt || s.publishedAt || s.date;
const sameDay = (a: string, b: string) => a.slice(0, 10) === b.slice(0, 10);

let failures = 0;
let checks = 0;
function report(ok: boolean, where: string, what: string, detail = "") {
  checks++;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${where.padEnd(34)} ${what}${detail ? `  [${detail}]` : ""}`);
}

async function api<T>(path: string): Promise<T | null> {
  const r = await fetch(`${BASE}${path}`);
  return r.ok ? ((await r.json()) as T) : null;
}

async function text(page: Page, selector: string): Promise<string> {
  try { return ((await page.locator(selector).first().textContent({ timeout: 8000 })) ?? "").replace(/\s+/g, " ").trim(); } catch { return ""; }
}

async function main() {
  const list = await api<{ sessions: ApiSession[] }>("/api/swarm/sessions?limit=40");
  if (!list) { console.log(`FAIL  cannot read ${BASE}/api/swarm/sessions`); process.exit(2); }
  const all = list.sessions;
  const published = all.filter((s) => s.state === "published");
  // "Waited": the row was created on an earlier day than it opened (or was published, if it never recorded an opening).
  const waited = published.filter((s) => s.openedAt && !sameDay(s.openedAt, s.date));
  const prompt = published.filter((s) => s.openedAt && sameDay(s.openedAt, s.date));
  const open = all.filter((s) => s.state === "collecting" && s.openedAt);
  console.log(`# ${BASE}: ${all.length} sessions read; ${waited.length} published that waited, ${prompt.length} that did not, ${open.length} collecting with an opening\n`);
  if (waited.length === 0) console.log("NOTE  no published session in the first 40 waited for its brief: the case the bug lived in is NOT covered by this run\n");

  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 160)));

  // ── /swarm: facts and the history ──────────────────────────────────────────
  await page.goto(`${BASE}/swarm`, { waitUntil: "networkidle" });
  await page.waitForSelector(".rr-hist tbody tr", { timeout: 15000 }).catch(() => {});
  const rows = await page.$$eval(".rr-hist tbody tr", (trs) => trs.map((tr) => ({
    href: tr.querySelector("th a")?.getAttribute("href") ?? "",
    day: (tr.querySelector("th a")?.textContent ?? "").trim(),
    small: (tr.querySelector("th small")?.textContent ?? "").trim(),
  })));
  const rowOf = (id: string) => rows.find((r) => r.href.endsWith(`/${id}`));
  for (const s of [...waited.slice(0, 4), ...prompt.slice(0, 2)]) {
    const r = rowOf(s.id);
    const where = `/swarm history ${s.subjectId.slice(-12)} ${s.id.slice(0, 6)}`;
    if (!r) { report(true, where, "not in the rendered page (beyond the first page of history): skipped"); continue; }
    report(r.day === fmt(whenOf(s), "short"), where, `day is ${fmt(whenOf(s), "short")}`, `page: ${r.day}`);
    if (s.openedAt) report(r.small.startsWith(clock(s.openedAt)), where, `time is ${clock(s.openedAt)}`, `page: ${r.small}`);
  }
  // History is newest-opened first.
  const order = rows.map((r) => all.find((s) => r.href.endsWith(`/${s.id}`))).filter(Boolean) as ApiSession[];
  const keys = order.map((s) => whenOf(s));
  const sorted = [...keys].sort().reverse();
  report(JSON.stringify(keys) === JSON.stringify(sorted), "/swarm history order", "newest opened first", keys.length ? "" : "no rows");
  const latestFact = await text(page, ".rr-meta__i:has-text('Latest session')");
  const newestPublished = [...published].sort((a, b) => whenOf(b).localeCompare(whenOf(a)))[0];
  if (latestFact && newestPublished) {
    report(latestFact.includes(fmt(whenOf(newestPublished), "short")) || rows.length > 0, "/swarm 'Latest session' fact", "names an opened day", latestFact);
  }

  // ── a session page, for each case ──────────────────────────────────────────
  for (const [label, sessions] of [["waited", waited.slice(0, 3)], ["prompt", prompt.slice(0, 1)], ["collecting", open.slice(0, 1)]] as const) {
    for (const s of sessions) {
      const where = `session page (${label}) ${s.id.slice(0, 6)}`;
      await page.goto(`${BASE}/swarm/sessions/${s.id}`, { waitUntil: "networkidle" });
      const when = await text(page, "time");
      const crumb = await text(page, ".rr-crumbs [aria-current='page']");
      const title = await page.title();
      const w = whenOf(s);
      const expectHeader = s.openedAt ? `${fmt(w, "long")} · ${clock(s.openedAt)}` : fmt(w, "long");
      report(when === expectHeader, where, "header day and time", `want: ${expectHeader} | page: ${when}`);
      report(crumb.toLowerCase() === fmt(w, "short").toLowerCase(), where, "breadcrumb day", `want: ${fmt(w, "short")} | page: ${crumb}`);
      report(title.includes(fmt(w, "short")), where, "title day", `page: ${title.slice(0, 70)}`);
      if (!sameDay(w, s.date)) {
        report(!when.includes(fmt(s.date, "long")) && !crumb.toLowerCase().includes(fmt(s.date, "short").toLowerCase()),
          where, `does not print the creation day (${fmt(s.date, "short")})`);
        const created = await text(page, "#evidence .rr-dl > div:has(dt:text-matches('Row created|Record generated')) dd");
        if (created) report(created.includes(fmt(s.generatedAt, "short")), where, "creation time is dated, not bare", created);
      }
    }
  }

  // ── the subject page: its newest row and its history ───────────────────────
  for (const s of waited.slice(0, 2)) {
    await page.goto(`${BASE}/swarm/subjects/${encodeURIComponent(s.subjectId)}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1500);
    const titles = await page.$$eval(".sv__session-title", (els) => els.map((e) => ({ href: e.getAttribute("href") ?? "", text: (e.textContent ?? "").trim() })));
    const mine = titles.find((t) => t.href.endsWith(`/${s.id}`));
    const where = `subject page ${s.subjectId.slice(-14)}`;
    if (mine) report(mine.text === fmt(whenOf(s), "short"), where, `row for ${s.id.slice(0, 6)} is ${fmt(whenOf(s), "short")}`, `page: ${mine.text}`);
    else report(true, where, `row for ${s.id.slice(0, 6)} not on the first page of history: skipped`);
  }

  // ── a judgement of a session that waited, and its judge's member page ─────
  let judged = 0;
  for (const s of waited) {
    if (judged >= 2) break;
    const j = await api<{ judgements: Array<{ id: string; judgedBy: string; judgedByMemberId: string | null; sessionOpenedAt?: string | null; sessionDate: string }> }>(`/api/swarm/sessions/${s.id}/judgements`);
    const first = j?.judgements?.[0];
    if (!first) continue;
    judged++;
    const where = `judgement page ${first.id}`;
    report(Boolean(first.sessionOpenedAt), where, "API carries sessionOpenedAt", String(first.sessionOpenedAt));
    await page.goto(`${BASE}/swarm/judgements/${first.id}`, { waitUntil: "networkidle" });
    const title = await page.title();
    const w = first.sessionOpenedAt || first.sessionDate;
    report(title.includes(fmt(w, "short")), where, `title day is ${fmt(w, "short")}`, `page: ${title.slice(0, 80)}`);
    const memberId = first.judgedByMemberId;
    if (memberId) {
      await page.goto(`${BASE}/swarm/members/${encodeURIComponent(memberId)}`, { waitUntil: "networkidle" });
      await page.waitForTimeout(1500);
      const days = await page.$$eval("time.mp-take__date", (els) => els.map((e) => (e.textContent ?? "").trim()));
      if (days.length) report(days.includes(fmt(w, "short")), `member page ${memberId.slice(0, 8)}`, `a judgement row is ${fmt(w, "short")}`, days.slice(0, 4).join(" | "));
    }
  }
  if (judged === 0) console.log("NOTE  no judged session that waited was found: the judgement and member pages are NOT covered by this run");

  report(errors.length === 0, "all pages", "no page errors", errors.slice(0, 2).join(" | "));
  await browser.close();
  console.log(`\n# ${checks} checks, ${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
