// Self-test for the cutover-data-gate operator script (issue #344).
// scripts/verify-cutover-data-gate.ts is never wired into CI — it requires
// secrets (a production DATABASE_URL, the deployment's ADMIN_TOKEN) that are
// intentionally never available to an automated worker — but the script
// itself, and its pure per-check logic, are ordinary repo code and get the
// same "does the pass path actually pass, does every failure mode actually
// fail" proof every other driver in this repo gets:
//
//   - POSITIVE: a stub backend serving a healthy gate (all real sessions
//     resolve, the real (non-seed) roster, a fresh regime snapshot, an
//     unbroken AUM history, fresh producer telemetry) exits 0.
//   - NEGATIVE: each failure mode from issue #344 (a session 404ing off the
//     archive fallback, the 7-member demo-seed roster, a future-dated regime
//     asOf, a gap in the AUM history, a stale producer signal) exits non-zero
//     naming the failed check.
//   - SKIP: no ADMIN_TOKEN supplied → the producer-freshness check reports
//     SKIP (not folded into pass), the other checks still run.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { ROUTES, path as routePath } from "@robotmoney/contract";

const repoRoot = join(import.meta.dir, "../../..");

const REAL_SESSIONS = [
  { date: "2026-07-27", subjectId: "woon" },
  { date: "2026-07-28", subjectId: "mav" },
];
const REAL_MEMBERS = [{ id: "woon" }, { id: "mav" }, { id: "third" }];

function overviewPayload(stale = false) {
  return {
    serverDate: "2026-07-31",
    regime: { stale, asof: stale ? "2027-04-25" : "2026-07-31" },
    research: [
      { signalKey: "channel-divergence", latestDate: "2026-07-30", ageDays: 1, stale: false },
      { signalKey: "late-cycle-signals", latestDate: "2026-07-30", ageDays: 1, stale: false },
    ],
  };
}
function walletPayload(gap = false) {
  const history = gap
    ? [{ date: "2026-06-25" }, { date: "2026-07-28" }]
    : [{ date: "2026-07-27" }, { date: "2026-07-28" }];
  return { history };
}

interface StubOverrides {
  sessions?: unknown;
  brokenSessionKeys?: string[]; // "date/subjectId" pairs the stub 404s
  members?: unknown;
  regimeAsOf?: string;
  wallet?: unknown;
  overview?: unknown;
}
function startStubBackend(o: StubOverrides = {}) {
  const sessions = (o.sessions as typeof REAL_SESSIONS) ?? REAL_SESSIONS;
  return Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      const p = url.pathname;
      if (p === ROUTES.admin.overview) {
        if (req.headers.get("X-Admin-Token") !== "test-admin-token") return new Response("forbidden", { status: 403 });
        return Response.json(o.overview ?? overviewPayload());
      }
      if (p === ROUTES.swarm.sessions) return Response.json({ sessions });
      for (const s of sessions) {
        const sessPath = routePath(ROUTES.swarm.session, { date: s.date, subject: s.subjectId });
        if (p === sessPath) {
          const key = `${s.date}/${s.subjectId}`;
          if (o.brokenSessionKeys?.includes(key)) return new Response("archive fallback error", { status: 404 });
          return Response.json({ session: s });
        }
      }
      if (p === ROUTES.swarm.members) return Response.json({ members: o.members ?? REAL_MEMBERS });
      if (p === ROUTES.dashboards.regimeSnapshots) {
        const asOf = o.regimeAsOf ?? new Date().toISOString().slice(0, 10);
        return Response.json({ asOf });
      }
      if (p === ROUTES.dashboards.walletBalances) return Response.json(o.wallet ?? walletPayload());
      return new Response("not found", { status: 404 });
    },
  });
}

async function runGate(backend: ReturnType<typeof startStubBackend>, env: Record<string, string> = {}) {
  const proc = Bun.spawn(
    ["bun", "run", "scripts/verify-cutover-data-gate.ts", "--base", `http://localhost:${backend.port}`],
    { cwd: repoRoot, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, output: stdout + stderr };
}

describe("verify-cutover-data-gate (issue #344 operator-script self-test)", () => {
  test("healthy gate, with admin token → exit 0, every check reported pass", async () => {
    const backend = startStubBackend();
    try {
      const r = await runGate(backend, { ADMIN_TOKEN: "test-admin-token" });
      expect(r.output).toContain("✓ swarm sessions resolve");
      expect(r.output).toContain("✓ swarm member roster");
      expect(r.output).toContain("✓ regime asOf freshness");
      expect(r.output).toContain("✓ AUM history has no gap");
      expect(r.output).toContain("✓ producer freshness");
      expect(r.output).toContain("gate passed");
      expect(r.exitCode).toBe(0);
    } finally {
      backend.stop(true);
    }
  }, 20_000);

  test("no ADMIN_TOKEN → producer-freshness check SKIPPED, other checks still pass, exit 0", async () => {
    const backend = startStubBackend();
    try {
      const { ADMIN_TOKEN: _drop, ...envWithoutToken } = process.env as Record<string, string>;
      const r = await runGate(backend, envWithoutToken);
      expect(r.output).toContain("○ producer freshness");
      expect(r.output).toContain("no ADMIN_TOKEN supplied");
      expect(r.output).toContain("gate passed");
      expect(r.exitCode).toBe(0);
    } finally {
      backend.stop(true);
    }
  }, 20_000);

  test("a session 404s off the archive fallback (issue #344 symptom 1) → exit non-zero naming it", async () => {
    const backend = startStubBackend({ brokenSessionKeys: ["2026-07-28/mav"] });
    try {
      const r = await runGate(backend, { ADMIN_TOKEN: "test-admin-token" });
      expect(r.exitCode).not.toBe(0);
      expect(r.output).toContain("2026-07-28/mav -> 404");
    } finally {
      backend.stop(true);
    }
  }, 20_000);

  test("the 7-member demo-seed roster (issue #344 symptom 2) → exit non-zero", async () => {
    const backend = startStubBackend({ members: Array.from({ length: 7 }, (_, i) => ({ id: `seed-${i}` })) });
    try {
      const r = await runGate(backend, { ADMIN_TOKEN: "test-admin-token" });
      expect(r.exitCode).not.toBe(0);
      expect(r.output).toContain("matches the demo-seed roster");
    } finally {
      backend.stop(true);
    }
  }, 20_000);

  test("a future-dated regime asOf (issue #344 symptom 4) → exit non-zero", async () => {
    const backend = startStubBackend({ regimeAsOf: "2027-04-25" });
    try {
      const r = await runGate(backend, { ADMIN_TOKEN: "test-admin-token" });
      expect(r.exitCode).not.toBe(0);
      expect(r.output).toContain("regime asOf freshness");
    } finally {
      backend.stop(true);
    }
  }, 20_000);

  test("a gap in the AUM history (issue #344 symptom 3) → exit non-zero", async () => {
    const backend = startStubBackend({ wallet: walletPayload(true) });
    try {
      const r = await runGate(backend, { ADMIN_TOKEN: "test-admin-token" });
      expect(r.exitCode).not.toBe(0);
      expect(r.output).toContain("gap)");
    } finally {
      backend.stop(true);
    }
  }, 20_000);

  test("stale producer regime signal → exit non-zero", async () => {
    const backend = startStubBackend({ overview: overviewPayload(true) });
    try {
      const r = await runGate(backend, { ADMIN_TOKEN: "test-admin-token" });
      expect(r.exitCode).not.toBe(0);
      expect(r.output).toContain("regime stale");
    } finally {
      backend.stop(true);
    }
  }, 20_000);
});
