// Integration coverage for the `prod-bootstrap` orchestrator (migrate ->
// v0-seed:bootstrap -> edgar-seed:bootstrap), against the SAME ephemeral
// Postgres the rest of the suite uses. The underlying steps (migrate(),
// runV0SeedBootstrap(), bootstrapEdgarSeed()) are already covered by their
// own test files — this file exercises the orchestration logic that is
// UNIQUE to prod-bootstrap.ts and not exercised anywhere else: every step
// always runs (no fail-fast), the v0-seed drift outcome stays a non-failing
// warning (adopted production data wins), the edgar step's unreachable-vs-genuine-
// failure classification (skip vs. hard fail) is correct in both directions,
// and — the only place this is reachable — the step ORDERING a public
// deployment produces, where migrate() seats the live roster before the
// archive backfill reads swarm_members (issue #540, last test in this file).
import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import net from "node:net";
import { sql } from "../src/db/client.ts";
import { runProdBootstrap, type StepReport } from "../scripts/prod-bootstrap.ts";
import { loadV0Archive } from "../src/swarm/v0-archive.ts";
import { useCleanDatabasePerTest } from "./support/clean-db.ts";

// Own database per TEST, cloned from the migrated template: these tests each
// start from an empty table, which used to mean wiping one the previous test
// filled. See support/clean-db.ts.
useCleanDatabasePerTest(import.meta.file);

const MEMBER_IDS = ["athena", "robotmoney", "woon"];
const SUBJECT_IDS = ["robotmoney-allocation", "robotmoney-treasury", "robotmoney-vault", "woon"];

// Expected v0-seed summary, derived from the committed archive rather than
// hard-coded: the counts change every time the artifact is regenerated.
let expectedV0Summary = "";

beforeAll(async () => {
  const { payload, manifest } = await loadV0Archive();
  const takes = payload.sessions.reduce((n, s) => n + (s.takes?.length ?? 0), 0);
  expectedV0Summary =
    `${manifest.counts.members} members, ${manifest.counts.subjects} subjects, ` +
    `${manifest.counts.sessions} sessions, ${takes} takes, ` +
    `${manifest.counts.snapshots} snapshots, ${manifest.counts.briefs} briefs inserted, 0 drift`;
  // The archival signing key is published (src/swarm/v0-archive.ts), so the
  // orchestrator needs no key wired in; clear any ambient one so this runs
  // against the key the repo ships with.
  delete process.env.V0_ARCHIVE_SIGNING_KEY;
});

const origAnalyticsToken = process.env.ANALYTICS_TOKEN;
const origAnalyticsApiUrl = process.env.ANALYTICS_API_URL;
const origSeedRoster = process.env.SWARM_SEED_ROSTER;

function restoreEnv(): void {
  if (origAnalyticsToken === undefined) delete process.env.ANALYTICS_TOKEN;
  else process.env.ANALYTICS_TOKEN = origAnalyticsToken;
  if (origAnalyticsApiUrl === undefined) delete process.env.ANALYTICS_API_URL;
  else process.env.ANALYTICS_API_URL = origAnalyticsApiUrl;
  if (origSeedRoster === undefined) delete process.env.SWARM_SEED_ROSTER;
  else process.env.SWARM_SEED_ROSTER = origSeedRoster;
}

beforeEach(restoreEnv);
afterEach(restoreEnv);

function reportFor(reports: StepReport[], name: string): StepReport {
  const r = reports.find((r) => r.name === name);
  if (!r) throw new Error(`no report for step "${name}"`);
  return r;
}

async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.on("error", rej);
    s.listen(0, () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => res(p));
    });
  });
}

test("cold DB: all three steps run, v0-seed inserts the archive's full manifest counts, edgar cleanly skips without ANALYTICS_TOKEN, nothing failing", async () => {
  delete process.env.ANALYTICS_TOKEN;

  const reports = await runProdBootstrap();
  expect(reports.map((r) => r.name)).toEqual([
    "handle-namespace",
    "migrations",
    "v0-seed:bootstrap",
    "edgar-seed:bootstrap",
  ]);

  const namespace = reportFor(reports, "handle-namespace");
  expect(namespace.status).toBe("success");
  expect(namespace.failing).toBe(false);

  const migrations = reportFor(reports, "migrations");
  expect(migrations.status).toBe("success");
  expect(migrations.failing).toBe(false);

  const v0seed = reportFor(reports, "v0-seed:bootstrap");
  expect(v0seed.status).toBe("success");
  expect(v0seed.failing).toBe(false);
  expect(v0seed.summary).toBe(expectedV0Summary);

  const edgar = reportFor(reports, "edgar-seed:bootstrap");
  expect(edgar.status).toBe("skipped");
  expect(edgar.failing).toBe(false);
  expect(edgar.summary).toBe("skipped: ANALYTICS_TOKEN not set");

  expect(reports.some((r) => r.failing)).toBe(false);

  const [{ n }] = await sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM swarm_members WHERE id = ANY(${MEMBER_IDS})`;
  expect(n).toBe(3);
});

test("idempotent: a second full run inserts nothing further and still reports nothing failing", async () => {
  delete process.env.ANALYTICS_TOKEN;

  const first = await runProdBootstrap();
  expect(reportFor(first, "v0-seed:bootstrap").summary).toBe(expectedV0Summary);

  const second = await runProdBootstrap();
  expect(reportFor(second, "v0-seed:bootstrap").summary).toBe("0 members, 0 subjects, 0 sessions, 0 takes, 0 snapshots, 0 briefs inserted, 0 drift");
  expect(second.some((r) => r.failing)).toBe(false);
});

test("drift on an adopted database: reported as a warning, existing rows win, the run is NOT failing", async () => {
  delete process.env.ANALYTICS_TOKEN;

  await runProdBootstrap();
  await sql`UPDATE swarm_members SET tagline = 'MUTATED for prod-bootstrap orchestration test' WHERE id = 'athena'`;

  const reports = await runProdBootstrap();
  // No fail-fast: migrations and the edgar step still ran even though v0-seed drifted.
  expect(reports.map((r) => r.name)).toEqual([
    "handle-namespace",
    "migrations",
    "v0-seed:bootstrap",
    "edgar-seed:bootstrap",
  ]);

  const v0seed = reportFor(reports, "v0-seed:bootstrap");
  expect(v0seed.status).toBe("warning");
  // NOT failing: this orchestrator is the boot path, and a populated database
  // it boots against is adopted production data (a manual .dump restore, or a
  // volume that survived a restart) whose rows legitimately differ from the
  // archive. The drift is the report; the existing row is the record. The
  // standalone v0-seed:bootstrap script keeps its strict exit-1-on-drift
  // convention for explicit integrity checks — that split is deliberate.
  expect(v0seed.failing).toBe(false);
  // "inserted" counts only — subjects/sessions already exist from the first
  // run (unchanged, not inserted), so this reads 0/0 even though the DB
  // still holds all of them; only the drift count reflects the mutation.
  expect(v0seed.summary).toBe("0 members, 0 subjects, 0 sessions, 0 takes, 0 snapshots, 0 briefs inserted, 1 drift");

  expect(reportFor(reports, "migrations").failing).toBe(false);
  expect(reportFor(reports, "edgar-seed:bootstrap").failing).toBe(false);

  // The overall run-level signal: a drifted adopt run exits 0.
  expect(reports.some((r) => r.failing)).toBe(false);

  // Never silently overwritten.
  const [{ tagline }] = await sql<{ tagline: string }[]>`SELECT tagline FROM swarm_members WHERE id = 'athena'`;
  expect(tagline).toBe("MUTATED for prod-bootstrap orchestration test");
});

test("edgar step: an unreachable API is classified as SKIPPED, not FAILED (never blocks a DB-only bootstrap)", async () => {
  process.env.ANALYTICS_TOKEN = "tok_prod_bootstrap_test";
  // A port nothing is listening on (bound then immediately released) —
  // connecting to it fails fast with a real "unreachable" error.
  const deadPort = await freePort();
  process.env.ANALYTICS_API_URL = `http://127.0.0.1:${deadPort}`;

  const reports = await runProdBootstrap();
  const edgar = reportFor(reports, "edgar-seed:bootstrap");
  expect(edgar.status).toBe("skipped");
  expect(edgar.failing).toBe(false);
  expect(edgar.summary).toContain("unreachable");
  expect(reports.some((r) => r.failing)).toBe(false);
});

test("edgar step: a REACHABLE API that rejects the credential is classified as FAILED, not silently skipped", async () => {
  process.env.ANALYTICS_TOKEN = "tok_wrong_prod_bootstrap_test";
  const server = Bun.serve({
    port: 0,
    fetch() {
      return new Response("unauthorized", { status: 401 });
    },
  });
  process.env.ANALYTICS_API_URL = `http://localhost:${server.port}`;

  try {
    const reports = await runProdBootstrap();
    const edgar = reportFor(reports, "edgar-seed:bootstrap");
    expect(edgar.status).toBe("failed");
    expect(edgar.failing).toBe(true);
    expect(edgar.summary).toContain("HTTP 401");
    // A genuine (reachable, authenticated-but-rejected) failure DOES mark the
    // overall run failing — only unreachability degrades gracefully.
    expect(reports.some((r) => r.failing)).toBe(true);
  } finally {
    server.stop(true);
  }
});

// ── Step 0: the handle/id namespace precheck (issue #602) ───────────────────
//
// prod-bootstrap.ts is the OTHER production path this orchestrator has to
// refuse on — its own header documents adopting "a working production database
// (manually restored from a .dump…)", and every step after the precheck is a
// write against that database. This is also the one place in this file where
// fail-fast is correct, so the assertion is that the later steps did NOT run.

test("a restored namespace violation halts the run before ANY write, with both members named", async () => {
  delete process.env.ANALYTICS_TOKEN;
  const holder = "pb-holder";
  const shadowed = "pb-shadowed";

  // Unreachable through the trigger by design (0031 is ENABLE ALWAYS, so even
  // session_replication_role = replica is refused), so it is disabled for the
  // two inserts and restored with ENABLE ALWAYS — never a plain ENABLE, which
  // downgrades tgenabled from 'A' to 'O' and would leave every later test in
  // the shared suite running with the bypass 0031 exists to close.
  await sql`ALTER TABLE swarm_members DISABLE TRIGGER swarm_members_handle_namespace_trigger`;
  try {
    await sql`INSERT INTO swarm_members (id, status, name, handle)
              VALUES (${shadowed}, 'active', 'Shadowed', ${`${shadowed}-h`})`;
    await sql`INSERT INTO swarm_members (id, status, name, handle)
              VALUES (${holder}, 'active', 'Holder', ${shadowed})`;
  } finally {
    await sql`ALTER TABLE swarm_members ENABLE ALWAYS TRIGGER swarm_members_handle_namespace_trigger`;
  }

  try {
    const reports = await runProdBootstrap();
    // Halted: migrate/seed never ran, so nothing was written on top of a public
    // reference that addresses two members.
    expect(reports.map((r) => r.name)).toEqual(["handle-namespace"]);
    const step = reportFor(reports, "handle-namespace");
    expect(step.status).toBe("failed");
    expect(step.failing).toBe(true);
    expect(step.summary).toContain("handle/id namespace violation");
    // What main() turns into a non-zero process exit code.
    expect(reports.some((r) => r.failing)).toBe(true);
    // The archive members are the proof nothing was written: this test's
    // database starts empty and a completed run always reinstates all three.
    const [{ n }] = await sql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM swarm_members WHERE id = ANY(${MEMBER_IDS})`;
    expect(n).toBe(0);
  } finally {
    // Repair by UPDATE, not DELETE. Migration 0032 makes swarm_members
    // append-only, so renaming the colliding handle is the ONLY repair an
    // operator has for this violation — which makes it the repair worth
    // proving the orchestrator accepts.
    await sql`UPDATE swarm_members SET handle = ${`${holder}-h`} WHERE id = ${holder}`;
  }

  // The repaired database runs to completion through the same entrypoint.
  const repaired = await runProdBootstrap();
  expect(reportFor(repaired, "handle-namespace").status).toBe("success");
  expect(repaired.map((r) => r.name)).toEqual([
    "handle-namespace",
    "migrations",
    "v0-seed:bootstrap",
    "edgar-seed:bootstrap",
  ]);
  expect(repaired.some((r) => r.failing)).toBe(false);

  // …and the trigger is back at ALWAYS for every test that follows.
  const [{ tgenabled }] = await sql<{ tgenabled: string }[]>`
    SELECT tgenabled FROM pg_trigger WHERE tgname = 'swarm_members_handle_namespace_trigger'`;
  expect(tgenabled).toBe("A");
});

// ── The public-deployment shape: SWARM_SEED_ROSTER=1 (issue #540) ───────────
//
// This is the run that used to exit non-zero for no operator-visible reason.
// Step 1's migrate() calls seed(), which — on a public deployment, where the
// gate is on — seats athena and robotmoney from the committed manifests
// BEFORE step 2's archive backfill ever looks at swarm_members. The two
// writers then disagreed on those rows (the jsonb avatar column's `.path`,
// plus the voice_md/submit columns the seeder does not own), step 2 reported
// member drift, and main() turned that into exit 1 — blocking the production
// bootstrap path for a cosmetic path difference on rows nobody had edited.
//
// The whole run is driven here, through the real orchestrator, with the real
// gate set: this is the ordering `bun run prod-bootstrap` produces itself, and
// it is the one no unit-level test of either writer can reach.
test("SWARM_SEED_ROSTER=1: the roster is seated by step 1, and step 2 still reports 0 drift with nothing failing", async () => {
  delete process.env.ANALYTICS_TOKEN;
  process.env.SWARM_SEED_ROSTER = "1";

  const reports = await runProdBootstrap();

  // The seeder really did run first — otherwise this asserts nothing.
  const seated = await sql<{ id: string }[]>`
    SELECT id FROM swarm_members WHERE id IN ('athena', 'robotmoney') ORDER BY id`;
  expect(seated.map((r) => r.id)).toEqual(["athena", "robotmoney"]);

  const v0seed = reportFor(reports, "v0-seed:bootstrap");
  expect(v0seed.summary).toContain("0 drift");
  // Only woon is genuinely new; the two seeded rows are completed, not drifted.
  expect(v0seed.summary.startsWith("1 members, ")).toBe(true);
  expect(v0seed.status).toBe("success");
  expect(v0seed.failing).toBe(false);

  // What main() turns into the process exit code.
  expect(reports.some((r) => r.failing)).toBe(false);

  // All three archive members are present, all on the canonical avatar path.
  const rows = await sql<{ id: string; avatar: Record<string, unknown> }[]>`
    SELECT id, avatar FROM swarm_members WHERE id = ANY(${MEMBER_IDS}) ORDER BY id`;
  expect(rows.length).toBe(3);
  for (const r of rows) expect(r.avatar.path).toBe(`/avatars/swarm/${r.id}.jpg`);

  // And a second convergence run is still clean, in that same ordering.
  const second = await runProdBootstrap();
  expect(reportFor(second, "v0-seed:bootstrap").summary).toContain("0 drift");
  expect(second.some((r) => r.failing)).toBe(false);
});
