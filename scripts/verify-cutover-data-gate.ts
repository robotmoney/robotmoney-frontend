// One-shot operator check for issue #344 (the cutover data gate) — NOT a CI
// gate, never wired into a workflow. It requires a backend actually pointed at
// the production database (a DigitalOcean Managed Postgres credential an
// operator supplies out of band, per scripts/gitops-credentials.ts's "never
// uploaded to GitHub" rule) and, for the producer-freshness check, the
// deployment's ADMIN_TOKEN. Neither secret is available to CI or to an
// automated worker, so this script is meant to be run BY HAND against a real
// host:
//
//   bun scripts/verify-cutover-data-gate.ts --base https://stage.robotmoney-labs.dev
//   ADMIN_TOKEN=... bun scripts/verify-cutover-data-gate.ts --base https://<host>
//
// Read only: every request is a GET. No mutation route is ever called.
//
// Checks (see issue #344 Scope):
//   1. Producer freshness — GET /api/admin/overview (X-Admin-Token) and read
//      `regime.stale` / `research[].stale`. These fields are computed
//      straight off `regime_snapshots` / `research_signals`
//      (backend/src/admin/overview.ts), NOT off `job_schedules`/`jobs` — the
//      #344 review comment found the original job-queue-based query would
//      false-confirm, because D25 moved cadence to the independent producer
//      and force-disables the legacy `regime.classify`/`research.refresh`
//      schedule rows on every seed (backend/src/db/seed.ts). Skipped (not
//      failed) when no admin token is supplied.
//   2. Live surface resolution — every session the committee API reports
//      must resolve 200 from the API itself (never the frontend's static
//      archive fallback), the session/member counts must match the real
//      roster (not the 21/7 demo-seed counts), the regime snapshot's asOf
//      must be within a day of today, and the wallet-balances AUM history
//      must have no calendar-day gap.
//
// Exit code is 0 iff every check that ran passed; non-zero otherwise. Nothing
// here silently turns a failure into a skip — a skipped check is logged as
// SKIP, never folded into the pass/fail tally.
import { ROUTES, path as routePath } from "@robotmoney/contract";

interface CheckResult {
  name: string;
  status: "pass" | "fail" | "skip";
  detail: string;
}

function parseArgs(argv: string[]): { base: string | null; adminToken: string | null } {
  let base: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--base") base = argv[++i] ?? null;
  }
  return { base, adminToken: process.env.ADMIN_TOKEN || null };
}

async function getJson(url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, { headers });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

// ── Check 1: producer freshness (the corrected step 1) ─────────────────────
export async function checkProducerFreshness(base: string, adminToken: string | null): Promise<CheckResult> {
  if (!adminToken) {
    return { name: "producer freshness (regime + research)", status: "skip", detail: "no ADMIN_TOKEN supplied — cannot read /api/admin/overview" };
  }
  const { status, body } = await getJson(`${base}${ROUTES.admin.overview}`, { "X-Admin-Token": adminToken });
  if (status !== 200 || !body || typeof body !== "object") {
    return { name: "producer freshness (regime + research)", status: "fail", detail: `GET ${ROUTES.admin.overview} -> ${status}` };
  }
  const b = body as { regime?: { stale?: boolean; asof?: string | null }; research?: Array<{ signalKey: string; stale: boolean; latestDate: string | null }> };
  const failures: string[] = [];
  if (b.regime?.stale !== false) {
    failures.push(`regime stale (asof ${b.regime?.asof ?? "none"})`);
  }
  for (const r of b.research ?? []) {
    if (r.stale) failures.push(`research signal ${r.signalKey} stale (latest ${r.latestDate ?? "none"})`);
  }
  if (failures.length > 0) {
    return { name: "producer freshness (regime + research)", status: "fail", detail: failures.join("; ") };
  }
  return { name: "producer freshness (regime + research)", status: "pass", detail: `regime asof ${b.regime?.asof}, all research signals fresh` };
}

// ── Check 2: every real session resolves from the API ──────────────────────
export async function checkSessionsResolve(base: string): Promise<CheckResult> {
  const { status, body } = await getJson(`${base}${ROUTES.committee.sessions}?full=1`);
  if (status !== 200 || !body || typeof body !== "object") {
    return { name: "committee sessions resolve", status: "fail", detail: `GET ${ROUTES.committee.sessions} -> ${status}` };
  }
  const sessions = (body as { sessions?: Array<{ date: string; subjectId: string }> }).sessions ?? [];
  if (sessions.length === 0) {
    return { name: "committee sessions resolve", status: "fail", detail: "no sessions returned" };
  }
  const failing: string[] = [];
  for (const s of sessions) {
    const url = `${base}${routePath(ROUTES.committee.session, { date: s.date, subject: s.subjectId })}`;
    const res = await fetch(url);
    if (res.status !== 200) failing.push(`${s.date}/${s.subjectId} -> ${res.status}`);
  }
  if (failing.length > 0) {
    return { name: "committee sessions resolve", status: "fail", detail: `${failing.length}/${sessions.length} failed: ${failing.join(", ")}` };
  }
  return { name: "committee sessions resolve", status: "pass", detail: `${sessions.length} sessions all resolved 200 from the API` };
}

// ── Check 3: committee member roster is the real one, not the demo seed ────
export async function checkMemberRoster(base: string): Promise<CheckResult> {
  const { status, body } = await getJson(`${base}${ROUTES.committee.members}`);
  if (status !== 200 || !body || typeof body !== "object") {
    return { name: "committee member roster", status: "fail", detail: `GET ${ROUTES.committee.members} -> ${status}` };
  }
  const members = (body as { members?: Array<{ id: string }> }).members ?? [];
  // The demo/seed fixture roster is 7 members (issue #344); the real
  // committee is smaller. This check only asserts the seed count is NOT what
  // came back — the real roster size is confirmed by the operator reading
  // `detail` against the real member list, since this script has no other
  // source of truth for what the real roster should be.
  if (members.length === 7) {
    return { name: "committee member roster", status: "fail", detail: "7 members returned — matches the demo-seed roster, not the real committee" };
  }
  return { name: "committee member roster", status: "pass", detail: `${members.length} members: ${members.map((m) => m.id).join(", ")}` };
}

// ── Check 4: regime snapshot is dated today, not a future-dated seed row ───
export async function checkRegimeAsOf(base: string): Promise<CheckResult> {
  const { status, body } = await getJson(`${base}${ROUTES.dashboards.regimeSnapshots}?range=30d`);
  if (status !== 200 || !body || typeof body !== "object") {
    return { name: "regime asOf freshness", status: "fail", detail: `GET ${ROUTES.dashboards.regimeSnapshots} -> ${status}` };
  }
  const asOf = (body as { asOf?: string }).asOf;
  if (!asOf) return { name: "regime asOf freshness", status: "fail", detail: "response carries no asOf" };
  const ageDays = Math.round((Date.now() - Date.parse(`${asOf}T00:00:00Z`)) / 86_400_000);
  if (Math.abs(ageDays) > 1) {
    return { name: "regime asOf freshness", status: "fail", detail: `asOf ${asOf} is ${ageDays}d from today` };
  }
  return { name: "regime asOf freshness", status: "pass", detail: `asOf ${asOf}` };
}

// ── Check 5: wallet-balances AUM history has no calendar-day gap ───────────
export async function checkAumHistoryGap(base: string): Promise<CheckResult> {
  const { status, body } = await getJson(`${base}${ROUTES.dashboards.walletBalances}`);
  if (status !== 200 || !body || typeof body !== "object") {
    return { name: "AUM history has no gap", status: "fail", detail: `GET ${ROUTES.dashboards.walletBalances} -> ${status}` };
  }
  const history = (body as { history?: Array<{ date: string }> }).history ?? [];
  if (history.length < 2) {
    return { name: "AUM history has no gap", status: "fail", detail: `only ${history.length} day(s) of history returned` };
  }
  const gaps: string[] = [];
  for (let i = 1; i < history.length; i++) {
    const prev = Date.parse(`${history[i - 1].date}T00:00:00Z`);
    const cur = Date.parse(`${history[i].date}T00:00:00Z`);
    const deltaDays = Math.round((cur - prev) / 86_400_000);
    if (deltaDays > 1) gaps.push(`${history[i - 1].date} -> ${history[i].date} (${deltaDays}d gap)`);
  }
  if (gaps.length > 0) {
    return { name: "AUM history has no gap", status: "fail", detail: gaps.join(", ") };
  }
  return { name: "AUM history has no gap", status: "pass", detail: `${history.length} consecutive days, ${history[0].date} .. ${history[history.length - 1].date}` };
}

export async function runAllChecks(base: string, adminToken: string | null): Promise<CheckResult[]> {
  return [
    await checkProducerFreshness(base, adminToken),
    await checkSessionsResolve(base),
    await checkMemberRoster(base),
    await checkRegimeAsOf(base),
    await checkAumHistoryGap(base),
  ];
}

async function main(): Promise<void> {
  const { base, adminToken } = parseArgs(process.argv.slice(2));
  if (!base) {
    console.error("usage: bun scripts/verify-cutover-data-gate.ts --base <https://host> [ADMIN_TOKEN=... env]");
    process.exit(2);
  }
  console.log(`\n=== cutover data gate verification (${base}) — issue #344 ===\n`);
  const results = await runAllChecks(base, adminToken);
  for (const r of results) {
    const mark = r.status === "pass" ? "✓" : r.status === "skip" ? "○" : "✗";
    console.log(`  ${mark} ${r.name}: ${r.detail}`);
  }
  const failed = results.filter((r) => r.status === "fail");
  const skipped = results.filter((r) => r.status === "skip");
  if (failed.length > 0) {
    console.error(`\n✗ gate FAILED: ${failed.length} check(s) did not pass (${skipped.length} skipped).\n`);
    process.exit(1);
  }
  console.log(`\n✓ gate passed (${skipped.length} check(s) skipped — supply ADMIN_TOKEN to cover all of them).\n`);
}

// Import-safe (a unit test can import the checks without running the CLI).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error("verify-cutover-data-gate error:", e);
    process.exit(1);
  });
}
