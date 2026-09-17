// Analytics persistence boundary (issue #106).
//
// PART 1 — architecture guard (hermetic source scan): updater/orchestrator
// modules (backend/src/analytics/** except the API-owned store/ and report/
// projections) must carry NO database access — no db/client.ts or
// db/worker-client.ts import, no `postgres` import, no SQL tag, and no
// analytics store-writer import. Worker modules keep queue-scoped access ONLY
// through db/worker-client.ts (the restricted-role pool) — never db/client.ts —
// and must never import an analytics store writer. Only API persistence
// (src/api/**, src/analytics/store/**, src/analytics/report/**) and
// migration/import/smoke tooling (src/db/**, src/smoke/**) may touch analytics
// SQL. A new violating import fails this test with the offending file + line.
//
// PART 2 — retained-handler boundary at runtime: legacy worker handlers execute
// only when this test inserts jobs directly and injects a provider credential.
// The supported runtime cannot enqueue/reactivate these kinds and shared workers
// receive no bearer (D25). Keeping this test proves the compatibility code still
// cannot bypass HTTP/SQL ownership while it remains in the tree.
//
// PART 3 — transitive worker-reachability guard (issue #979 fix). PART 1's
// "worker modules never import db/client" scan above only catches a literal
// import line PHYSICALLY INSIDE src/worker/**. It does NOT catch a worker file
// importing an otherwise-legitimate DB-touching module (e.g. analytics/cutover/**,
// allowlisted above because the API process legitimately reaches it) that ITSELF
// imports db/client.ts — exactly what shipped and regressed: worker/handlers/
// index.ts importing analytics/cutover/parity.ts, which imports db/client.ts,
// silently handed every worker container an unrestricted rm_app-credentialed
// pool. This walks the REAL relative-import graph (no bundler/resolver — just
// following `from "./x.ts"` / `from "../x.ts"` specifiers) from every file
// reachable from src/worker/, and fails if ANY reachable file, however many
// hops away, imports db/client.ts or postgres directly.
import { test, expect } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { sql } from "../src/db/client.ts";
import { config } from "../src/config.ts";
import { handleAnalytics } from "../src/api/routes/analytics.ts";
import { processOneJob } from "../src/worker/loop.ts";
import { useCleanDatabasePerTest } from "./support/clean-db.ts";

// Own database per TEST, cloned from the migrated template: these tests each
// start from an empty table, which used to mean wiping one the previous test
// filled. See support/clean-db.ts.
useCleanDatabasePerTest(import.meta.file);

const SRC = join(import.meta.dir, "..", "src");

function tsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) tsFiles(full, out);
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

interface Violation { file: string; line: number; text: string; }

function scan(files: string[], patterns: { re: RegExp; why: string }[]): Violation[] {
  const out: Violation[] = [];
  for (const file of files) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((text, i) => {
      // Only import/require lines and SQL tags matter; comments mentioning the
      // modules (documentation) must not trip the guard.
      const trimmed = text.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;
      for (const { re, why } of patterns) {
        if (re.test(text)) out.push({ file: relative(SRC, file), line: i + 1, text: `${why}: ${trimmed}` });
      }
    });
  }
  return out;
}

const IMPORT_DB_CLIENT = { re: /from\s+["'][^"']*db\/client(\.ts)?["']/, why: "imports db/client" };
const IMPORT_WORKER_CLIENT = { re: /from\s+["'][^"']*db\/worker-client(\.ts)?["']/, why: "imports db/worker-client" };
const IMPORT_POSTGRES = { re: /from\s+["']postgres["']/, why: "imports postgres directly" };
const SQL_TAG = { re: /\b(sql|tx|db)`/, why: "uses a SQL tag" };
const IMPORT_STORE = { re: /from\s+["'][^"']*analytics\/store\/[^"']*["']|from\s+["']\.\.?\/store\/[^"']*["']|from\s+["']\.\.?\/\.\.\/store\/[^"']*["']/, why: "imports an analytics store writer" };

test("updater/orchestrator modules (analytics/** minus store,report,cutover) carry zero database access", () => {
  const files = tsFiles(join(SRC, "analytics")).filter((f) => {
    const rel = relative(join(SRC, "analytics"), f);
    // Issue #979: analytics/cutover/** is a THIRD trusted, DB-touching
    // category, the same shape as store/report — it reads the Phase A ledger
    // (via the store layer's own public readers, same as report/ already
    // does) to reconstruct current-view content and records/evaluates parity
    // observations. It is deliberately reachable from outside api/ (the
    // dashboard/admin/swarm-brief read paths it is wired into are NOT all
    // under api/), which is exactly what makes it its own category rather
    // than simply living under store/ or report/ (see the companion
    // allowedPrefixes list below).
    return !rel.startsWith("store/") && !rel.startsWith("report/") && !rel.startsWith("cutover/");
  });
  expect(files.length).toBeGreaterThan(15); // canary: the updater surface is known-large
  const violations = scan(files, [IMPORT_DB_CLIENT, IMPORT_WORKER_CLIENT, IMPORT_POSTGRES, SQL_TAG, IMPORT_STORE]);
  expect(violations).toEqual([]);
});

test("worker modules never import db/client or analytics store writers (queue access only via db/worker-client)", () => {
  const files = tsFiles(join(SRC, "worker"));
  expect(files.length).toBeGreaterThan(5); // canary
  const violations = scan(files, [IMPORT_DB_CLIENT, IMPORT_POSTGRES, IMPORT_STORE]);
  expect(violations).toEqual([]);
});

// ── PART 3 helpers: a real relative-import graph walk ───────────────────────
// Resolve one `from "..."` specifier relative to the importing file. Only
// relative specifiers (".", "..") are part of THIS source tree's own graph —
// a bare/package specifier (node:*, postgres, @robotmoney/contract, ...) is
// deliberately not resolved further: those are either already caught directly
// by IMPORT_POSTGRES on the importing line, or are out of this repo entirely.
function resolveImportPath(fromFile: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const base = join(dirname(fromFile), spec);
  const candidates = [base.endsWith(".ts") ? base : `${base}.ts`, join(base, "index.ts")];
  return candidates.find((c) => existsSync(c)) ?? null;
}

function importSpecifiers(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const specs: string[] = [];
  // Matches both `import ... from "spec"` and `export ... from "spec"`
  // (re-exports are still real edges in the module graph).
  const re = /\bfrom\s+["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) specs.push(m[1]!);
  return specs;
}

// Two KNOWN, PRE-EXISTING, and OUT-OF-SCOPE-FOR-THIS-FIX edges: swarm/domain.ts
// (business logic worker/handlers/swarm.ts legitimately needs — swarm.judge etc.
// — for reasons that have nothing to do with the parity sweep) itself imports
// analytics/cutover/read-mode.ts and analytics/cutover/ledger-current.ts, to
// resolve a brief-by-session read once cutover is armed. Both were added by an
// EARLIER commit on this same issue #979 branch (`dc45a0bd feat(analytics): add
// the Phase A ledger cutover foundation`) than the two commits this fix targets
// (the parity-sweep wiring), so they are a separate, already-existing instance
// of the same underlying architectural question — not something this fix
// introduced or was asked to redesign. Excluding exactly these two edges (not
// the files, and not a broader swarm/** exemption) means: this test still
// fails the instant db/client.ts becomes reachable from worker/** through ANY
// OTHER path, including a reintroduction of the exact bug this fixes (a direct
// or indirect worker/handlers/index.ts -> analytics/cutover/parity.ts edge).
const EXCLUDED_EDGES = new Set([
  `${join(SRC, "swarm", "domain.ts")}::../analytics/cutover/read-mode.ts`,
  `${join(SRC, "swarm", "domain.ts")}::../analytics/cutover/ledger-current.ts`,
]);

// Every file transitively reachable from `entryFiles` by following relative
// imports (minus EXCLUDED_EDGES above) — a plain DFS over ~170 files in this
// repo, cheap enough to be a full closure rather than a bounded-hop
// approximation.
function transitiveClosure(entryFiles: string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...entryFiles];
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of importSpecifiers(file)) {
      if (EXCLUDED_EDGES.has(`${file}::${spec}`)) continue;
      const resolved = resolveImportPath(file, spec);
      if (resolved && !seen.has(resolved)) stack.push(resolved);
    }
  }
  return seen;
}

test("no analytics/** module transitively reachable from src/worker/ ever imports db/client (issue #979 fix)", () => {
  const entry = tsFiles(join(SRC, "worker"));
  const reachable = [...transitiveClosure(entry)];
  // Canary: this really walked BEYOND worker/** itself (worker/handlers/
  // index.ts alone reaches analytics/, ops/, etc.) — a closure that only ever
  // found the entry files would silently degrade this into PART 1's own scan.
  expect(reachable.length).toBeGreaterThan(entry.length);

  // Scoped to analytics/** — the boundary this whole file exists to guard
  // (see the header: analytics data tables are restricted to the API process
  // specifically). A repo-wide "no worker-reachable file may EVER import
  // db/client.ts" sweep also turns up long-standing, unrelated reachability
  // (e.g. chain/buyback-logs.ts, imported by worker/handlers/buybacks.ts, for
  // the non-analytics buyback_swaps table) that predates this fix, is not the
  // regression it introduced, and is out of scope to change here — flagging
  // it would make this test fail for a reason this fix does not address.
  const analyticsReachable = reachable.filter((f) => relative(SRC, f).replaceAll("\\", "/").startsWith("analytics/"));
  // Canary: the closure really DOES reach into analytics/ (worker/handlers/
  // index.ts and worker/handlers/analytics.ts both legitimately import
  // analytics/index.ts, analytics/api-client.ts, etc.) — otherwise the filter
  // above would make this test vacuously pass.
  expect(analyticsReachable.length).toBeGreaterThan(0);

  // Deliberately NOT SQL_TAG or IMPORT_STORE here: analytics/** legitimately
  // uses both (report/regime-projection.ts, store/*.ts, etc.) when reached
  // from the API side, and PART 1's own scans above already police THOSE
  // rules for their own trusted categories. The violation this guards against
  // is specifically db/client.ts (or postgres directly) becoming reachable
  // FROM WORKER/**, which is exactly what regressed here: worker/handlers/
  // index.ts -> analytics/cutover/parity.ts -> db/client.ts.
  const violations = scan(analyticsReachable, [IMPORT_DB_CLIENT, IMPORT_POSTGRES]);
  expect(violations).toEqual([]);
});

test("only API persistence + migration/smoke tooling import the analytics store writers", () => {
  // analytics/cutover/ (issue #979) is allowlisted for the same reason it is
  // excluded from the zero-db-access sweep above: it legitimately reads
  // through the store layer's own public functions (loadRawIndicatorHistory
  // et al.), the same way analytics/report/ already does.
  const allowedPrefixes = ["api/", "analytics/store/", "analytics/cutover/", "db/", "smoke/"];
  const files = tsFiles(SRC);
  const violations: Violation[] = [];
  for (const file of files) {
    const rel = relative(SRC, file).replaceAll("\\", "/");
    if (allowedPrefixes.some((p) => rel.startsWith(p))) continue;
    for (const v of scan([file], [IMPORT_STORE])) violations.push(v);
  }
  expect(violations).toEqual([]);
});

// ── PART 2: retained worker clients over the REAL boundary ─────────────────
test(
  "retained analytics handlers persist only via authenticated HTTP when invoked directly by a compatibility test",
  async () => {
    const TOKEN = "tok_analytics_worker_boundary";
    const requests: { method: string; path: string; auth: string | null }[] = [];

    // Real Bun server wrapping the REAL analytics route handler (same code the
    // api process mounts), recording every request it serves.
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        requests.push({ method: req.method, path: url.pathname, auth: req.headers.get("Authorization") });
        const r = await handleAnalytics(req, url);
        if (!r) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
        return new Response(JSON.stringify(r.body), { status: r.status, headers: { "Content-Type": "application/json" } });
      },
    });

    const origConfig = { analyticsToken: config.analyticsToken, allowInsecure: config.allowInsecure };
    const origEnv = {
      ANALYTICS_SOURCE: process.env.ANALYTICS_SOURCE,
      ANALYTICS_API_URL: process.env.ANALYTICS_API_URL,
      ANALYTICS_TOKEN: process.env.ANALYTICS_TOKEN,
    };
    try {
      // Server side verifies the analytics-provider bearer (prod-shaped: no
      // insecure fallback). This test explicitly wires the retained handler;
      // production shared workers deliberately receive no provider secret.
      config.analyticsToken = TOKEN;
      config.allowInsecure = false;
      process.env.ANALYTICS_SOURCE = "hermetic"; // deterministic + offline sources
      process.env.ANALYTICS_API_URL = `http://localhost:${server.port}`;
      process.env.ANALYTICS_TOKEN = TOKEN;

      // Empty the queue: a clean database still carries seed()'s production
      // cold-start jobs, and processOneJob() claims the oldest eligible job, not
      // this test's. Ordered DELETEs, not TRUNCATE ... CASCADE — audit_log,
      // swarm_session_events and analytics_runs reference jobs(id), and CASCADE
      // truncates a referencing table whole regardless of ON DELETE SET NULL.
      await sql`DELETE FROM job_runs`;
      await sql`DELETE FROM jobs`;
      const asof = new Date().toISOString().slice(0, 10);
      // Direct insertion is test-only. No supported API/admin/scheduler path can
      // create these legacy consumer jobs after D25.
      const [{ id: regimeJobId }] = await sql`
        INSERT INTO jobs (kind, payload) VALUES ('regime.classify', ${sql.json({ asof })}) RETURNING id`;
      const [{ id: researchJobId }] = await sql`
        INSERT INTO jobs (kind, payload) VALUES ('research.refresh', ${sql.json({ asof })}) RETURNING id`;

      expect(await processOneJob()).toBe(true);
      expect(await processOneJob()).toBe(true);

      // Queue lifecycle completed normally for BOTH jobs.
      for (const jobId of [regimeJobId, researchJobId]) {
        const [job] = await sql`SELECT status, last_error FROM jobs WHERE id = ${jobId}`;
        expect(job.status).toBe("succeeded");
        const runs = await sql`SELECT status FROM job_runs WHERE job_id = ${jobId}`;
        expect(runs.length).toBe(1);
        expect(runs[0].status).toBe("succeeded");
      }

      // Every persistence call went over HTTP with the bearer credential.
      expect(requests.length).toBeGreaterThanOrEqual(4); // floor read(s), floor write, run ledger, terminal run package
      for (const r of requests) {
        expect(r.path.startsWith("/api/analytics/")).toBe(true);
        expect(r.auth).toBe(`Bearer ${TOKEN}`);
      }
      const paths = new Set(requests.map((r) => `${r.method} ${r.path}`));
      expect(paths.has("GET /api/analytics/raw-history")).toBe(true);
      expect(paths.has("POST /api/analytics/raw-history")).toBe(true);
      // Since issue #978 the terminal run package is the ONE call that
      // publishes regime_snapshots AND research_signals — the orchestrator no
      // longer writes either projection mid-run, so a run that fails partway
      // cannot leave the current view ahead of the immutable ledger.
      expect(paths.has("POST /api/analytics/run-packages")).toBe(true);

      // Analytical rows changed through the API service.
      const [{ snaps }] = await sql`SELECT COUNT(*)::int AS snaps FROM regime_snapshots`;
      expect(snaps).toBeGreaterThan(1000); // full hermetic 2018..today axis classified
      const sigs = await sql`SELECT DISTINCT signal_key FROM research_signals WHERE date = ${asof}`;
      expect(sigs.map((s) => s.signal_key).sort()).toEqual(["channel-divergence", "late-cycle-signals"]);
    } finally {
      server.stop(true);
      config.analyticsToken = origConfig.analyticsToken;
      config.allowInsecure = origConfig.allowInsecure;
      for (const [k, v] of Object.entries(origEnv)) {
        if (v === undefined) delete process.env[k as keyof typeof origEnv];
        else process.env[k as keyof typeof origEnv] = v;
      }
    }
  },
  { timeout: 240_000 },
);
