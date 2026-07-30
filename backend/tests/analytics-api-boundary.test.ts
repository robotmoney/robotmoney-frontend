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
// migration/import/demo tooling (src/db/**, src/demo/**) may touch analytics
// SQL. A new violating import fails this test with the offending file + line.
//
// PART 2 — retained-handler boundary at runtime: legacy worker handlers execute
// only when this test inserts jobs directly and injects a provider credential.
// The supported runtime cannot enqueue/reactivate these kinds and shared workers
// receive no bearer (D25). Keeping this test proves the compatibility code still
// cannot bypass HTTP/SQL ownership while it remains in the tree.
import { test, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { sql } from "../src/db/client.ts";
import { config } from "../src/config.ts";
import { handleAnalytics } from "../src/api/routes/analytics.ts";
import { processOneJob } from "../src/worker/loop.ts";

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

test("updater/orchestrator modules (analytics/** minus store,report) carry zero database access", () => {
  const files = tsFiles(join(SRC, "analytics")).filter((f) => {
    const rel = relative(join(SRC, "analytics"), f);
    return !rel.startsWith("store/") && !rel.startsWith("report/");
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

test("only API persistence + migration/demo tooling import the analytics store writers", () => {
  const allowedPrefixes = ["api/", "analytics/store/", "db/", "demo/"];
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

      await sql`TRUNCATE jobs, job_runs RESTART IDENTITY CASCADE`;
      await sql`DELETE FROM regime_snapshots`;
      await sql`DELETE FROM research_signals`;
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
      expect(requests.length).toBeGreaterThanOrEqual(4); // floor read(s), floor write, snapshots, research signals
      for (const r of requests) {
        expect(r.path.startsWith("/api/analytics/")).toBe(true);
        expect(r.auth).toBe(`Bearer ${TOKEN}`);
      }
      const paths = new Set(requests.map((r) => `${r.method} ${r.path}`));
      expect(paths.has("GET /api/analytics/raw-history")).toBe(true);
      expect(paths.has("POST /api/analytics/raw-history")).toBe(true);
      expect(paths.has("POST /api/analytics/regime-snapshots")).toBe(true);
      expect(paths.has("POST /api/analytics/research-signals")).toBe(true);

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
