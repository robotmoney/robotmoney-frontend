// Self-test for scripts/verify-live.ts, in BOTH directions.
//
// The repo's standing policy for an assertion driver (stated in
// scripts/tests/integration/smoke-live-smoke.test.ts): "exit 0 must never mean
// nothing ran". A verifier that cannot fail is worse than no verifier, because
// it converts an unchecked invariant into a green check. So every case below
// pairs a healthy fixture that MUST exit 0 with a forced defect that MUST exit
// non-zero and name the leg that caught it.
//
// The most important case is `a tampered published vector`. That is the whole
// point of the recompute check: D42 promises a reader can recompute the
// allocation vector from the published takes, and until this driver existed
// nothing anywhere exercised that promise. If this one case ever goes green
// with a tampered vector, the promise is unguarded again.
//
// Runs against a STUB backend rather than a booted stack: the driver's contract
// is "given these payloads over HTTP, reach this verdict", and a stub is the
// only way to force a defect on demand. The live-stack direction is covered by
// running the same binary in CI after the smoke boot.
import { afterAll, describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const DRIVER = join(repoRoot, "scripts", "verify-live.ts");

type Weight = { bucket: string; weight: number };
type Take = { memberId: string; weights: Weight[] | null; verified: boolean; archival?: boolean };
interface StubSession {
  id: string;
  date: string;
  subjectId: string;
  state: string;
  windowClosesAt: string | null;
  publishedAt: string | null;
  swarmRecommendation: { type: string; weights?: Weight[] } | null;
  takes: Take[];
}

/** Two takes whose mean is exactly a=0.375, b=0.625 — computed by hand from the
 *  documented rule so the fixture does not lean on the implementation. */
const TAKES: Take[] = [
  { memberId: "m1", weights: [{ bucket: "a", weight: 0.5 }, { bucket: "b", weight: 0.5 }], verified: true },
  { memberId: "m2", weights: [{ bucket: "a", weight: 0.25 }, { bucket: "b", weight: 0.75 }], verified: true },
];
const TRUE_VECTOR: Weight[] = [{ bucket: "a", weight: 0.375 }, { bucket: "b", weight: 0.625 }];

function session(overrides: Partial<StubSession> = {}, n = 1): StubSession {
  return {
    id: `session-${n}`,
    date: `2026-09-1${n}`,
    subjectId: `subject-${n}`,
    state: "published",
    windowClosesAt: new Date(Date.now() - 86_400_000).toISOString(),
    publishedAt: new Date(Date.now() - 3_600_000 * n).toISOString(),
    swarmRecommendation: { type: "bucket_weights", weights: TRUE_VECTOR },
    takes: TAKES,
    ...overrides,
  };
}

const HEALTHY = (): StubSession[] => [session({}, 1), session({}, 2), session({}, 3)];

const servers: { stop(): void }[] = [];
afterAll(() => {
  for (const s of servers) s.stop();
});

/** Roster rows for the `full`-tier twin-roster leg. Ids match the take fixtures
 *  above, because that leg keys a seat on handle-or-id exactly as adoption does. */
type StubMember = { id: string; handle?: string; name: string; status: string };
const MEMBER = (id: string, status = "active"): StubMember => ({ id, handle: id, name: id, status });

/** A stub serving exactly the routes the legs read. */
function serve(sessions: StubSession[], opts: { healthy?: boolean; members?: StubMember[] } = {}): string {
  const server = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/health") {
        return opts.healthy === false ? new Response("no", { status: 503 }) : new Response("ok");
      }
      if (url.pathname === "/api/swarm/members") {
        // Default: exactly the members the take fixtures speak for, so the
        // readonly-tier cases stay unaffected by the full-tier leg's existence.
        return Response.json({ members: opts.members ?? TAKES.map((t) => MEMBER(t.memberId)) });
      }
      if (url.pathname === "/api/swarm/sessions") {
        // The light index row: everything except `takes`, matching issue #243.
        return Response.json({ sessions: sessions.map(({ takes: _t, ...row }) => row) });
      }
      const receiptMatch = url.pathname.match(/^\/api\/swarm\/sessions\/([^/]+)\/consensus-receipt$/);
      if (receiptMatch) {
        return Response.json({
          sessionId: receiptMatch[1],
          schemaVersion: "1.0",
          verified: true,
          receipt: { judge: { source: "model", mode: "enforce" } },
        });
      }
      const m = url.pathname.match(/^\/api\/swarm\/sessions\/([^/]+)\/([^/]+)$/);
      if (m) {
        const found = sessions.find((s) => s.date === m[1] && s.subjectId === m[2]);
        if (!found) return new Response("not found", { status: 404 });
        const { takes, ...rest } = found;
        // `{ session, takes }` — the real shape. Getting this wrong in the leg
        // produced a uniform "published but no publishedAt" across every row.
        return Response.json({ session: rest, takes });
      }
      return new Response("not found", { status: 404 });
    },
  });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}

async function runDriver(base: string, extra: string[] = []): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(["bun", "run", DRIVER, "--base", base, "--deadline-ms", "8000", ...extra], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, CI: "" },
  });
  const out = `${await new Response(proc.stdout).text()}${await new Response(proc.stderr).text()}`;
  return { code: await proc.exited, out };
}

describe("verify-live — the PASS path is not vacuous", () => {
  test("a healthy stack exits 0 and actually recomputes a vector", async () => {
    const { code, out } = await runDriver(serve(HEALTHY()));
    expect({ code, recomputed: /swarm:vector-recomputable.*recompute exactly/s.test(out) })
      .toEqual({ code: 0, recomputed: true });
    // Guards against a green run that asserted nothing: the leg must say how
    // many vectors it checked, and it must be more than zero.
    expect(out).toMatch(/3 published vector\(s\) recompute exactly from their takes/);
  }, 60_000);
});

describe("verify-live — each forced defect turns it red and names the leg", () => {
  test("A TAMPERED PUBLISHED VECTOR fails the recompute (the check's whole reason to exist)", async () => {
    const tampered = HEALTHY();
    // One bucket moved by 0.01 — far above the 8dp the derivation rounds to,
    // and the shape a silently-edited stored vector would take.
    tampered[0]!.swarmRecommendation = {
      type: "bucket_weights",
      weights: [{ bucket: "a", weight: 0.385 }, { bucket: "b", weight: 0.615 }],
    };
    const { code, out } = await runDriver(serve(tampered));
    expect(code).toBe(1);
    expect(out).toContain("swarm:vector-recomputable");
    expect(out).toMatch(/a: published 0\.385 vs recomputed 0\.375/);
  }, 60_000);

  test("a vector whose bucket SET differs from its takes fails", async () => {
    const wrong = HEALTHY();
    wrong[0]!.swarmRecommendation = { type: "bucket_weights", weights: [{ bucket: "c", weight: 1 }] };
    const { code, out } = await runDriver(serve(wrong));
    expect(code).toBe(1);
    expect(out).toContain("bucket set/order differs");
  }, 60_000);

  test("a single published session is the #101 starvation signature", async () => {
    const { code, out } = await runDriver(serve([session({}, 1)]));
    expect(code).toBe(1);
    expect(out).toContain("swarm:published-sessions");
  }, 60_000);

  test("a session wedged past its collection window fails", async () => {
    const wedged = HEALTHY();
    wedged.push(session({
      id: "stuck", state: "collecting", publishedAt: null,
      windowClosesAt: new Date(Date.now() - 6 * 3600_000).toISOString(),
      swarmRecommendation: null, takes: [],
    }, 4));
    const { code, out } = await runDriver(serve(wedged));
    expect(code).toBe(1);
    expect(out).toContain("swarm:no-wedged-sessions");
  }, 60_000);

  test("a published vector served with NO takes is unfalsifiable and fails", async () => {
    const noTakes = HEALTHY();
    noTakes[0]!.takes = [];
    const { code, out } = await runDriver(serve(noTakes));
    expect(code).toBe(1);
    expect(out).toContain("swarm:takes-served");
  }, 60_000);

  test("an archival take claiming signature verification fails", async () => {
    const bad = HEALTHY();
    bad[0]!.takes = [...TAKES, { memberId: "ghost", weights: null, verified: true, archival: true }];
    const { code, out } = await runDriver(serve(bad));
    expect(code).toBe(1);
    expect(out).toContain("swarm:archival-semantics");
  }, 60_000);

  test("a bucket_weights session publishing no weights at all fails", async () => {
    const empty = HEALTHY();
    empty[0]!.swarmRecommendation = { type: "bucket_weights" };
    const { code, out } = await runDriver(serve(empty));
    expect(code).toBe(1);
    expect(out).toContain("swarm:lifecycle-complete");
  }, 60_000);
});

describe("verify-live — 'could not run' is distinct from 'the product is wrong'", () => {
  test("a stack that never becomes live exits 2, not 1", async () => {
    const { code, out } = await runDriver(serve(HEALTHY(), { healthy: false }));
    // 2 means nothing was asserted. Collapsing it into 1 would let an
    // unreachable stack read as a product failure, and vice versa.
    expect(code).toBe(2);
    expect(out).toContain("COULD NOT RUN");
  }, 60_000);
});

describe("verify-live — position_actions history does not fake a pass", () => {
  test("no bucket_weights session anywhere WARNs and says so, rather than passing silently", async () => {
    const actionsOnly = HEALTHY().map((s) => ({
      ...s,
      swarmRecommendation: { type: "position_actions" },
      takes: TAKES.map((t) => ({ ...t, weights: null })),
    }));
    const { code, out } = await runDriver(serve(actionsOnly));
    // WARN, not FAIL: nothing is broken. But it must NOT read as a pass of the
    // recomputability invariant, which is why the detail says NOT A PASS.
    expect(code).toBe(0);
    expect(out).toContain("NOT A PASS");
    expect(out).toMatch(/0 of them bucket_weights/);
  }, 60_000);
});

// ── INVARIANT #3: a twin seats the WHOLE restored roster ────────────────────
// `full` tier only. Against production the same assertion would be wrong — an
// absent member there is an owner's agent being down, which the swarm tolerates
// by design — so these cases also pin that the leg stays OFF by default.
describe("verify-live — twin-roster (full tier only)", () => {
  const SEVEN = [
    ...TAKES.map((t) => MEMBER(t.memberId)),
    ...["dualmint", "maximus", "shodai", "woon", "athena"].map((h) => MEMBER(h)),
  ];

  test("a twin whose session seats every active member exits 0", async () => {
    const { code, out } = await runDriver(serve(HEALTHY()), ["--tier", "full"]);
    expect(code).toBe(0);
    expect(out).toContain("twin-roster:every-active-member-seated");
    expect(out).toMatch(/live take from all 2 active member\(s\)/);
  }, 60_000);

  test("THE 3-OF-7 SHORTFALL fails and names who never sat", async () => {
    // The exact stage defect: a roster of seven, a session carrying takes from
    // two. Before this leg existed the run was green, because no other check
    // compares the roster against the take set.
    const { code, out } = await runDriver(serve(HEALTHY(), { members: SEVEN }), ["--tier", "full"]);
    expect(code).toBe(1);
    expect(out).toContain("twin-roster:every-active-member-seated");
    for (const missing of ["dualmint", "maximus", "shodai", "woon", "athena"]) {
      expect(out).toContain(missing);
    }
  }, 60_000);

  test("the same shortfall is NOT a failure at the default tier — it is SKIPPED, and said so", async () => {
    // Production runs this driver readonly. If the leg ever leaked into that
    // tier it would redden every cutover for a member whose agent is offline —
    // an honest state the swarm tolerates. It must not run, and per the
    // harness's "recorded, never silent" rule it must say that it did not,
    // so a readonly report cannot be mistaken for a full one.
    const { code, out } = await runDriver(serve(HEALTHY(), { members: SEVEN }));
    expect(code).toBe(0);
    expect(out).toContain("twin-roster:skipped");
    expect(out).toMatch(/not run at tier=readonly/);
    expect(out).not.toContain("twin-roster:every-active-member-seated");
  }, 60_000);

  test("an ARCHIVAL-only session does not count as seating", async () => {
    // Restored history carries takes from everyone and proves nothing about
    // who THIS boot seated — the leg must keep looking, then fail.
    const archival = HEALTHY().map((s) => ({ ...s, takes: s.takes.map((t) => ({ ...t, archival: true })) }));
    const { code, out } = await runDriver(serve(archival), ["--tier", "full"]);
    expect(code).toBe(1);
    expect(out).toMatch(/no session with a live \(non-archival\) take/);
  }, 60_000);

  test("an empty roster fails rather than passing vacuously", async () => {
    const { code, out } = await runDriver(serve(HEALTHY(), { members: [] }), ["--tier", "full"]);
    expect(code).toBe(1);
    expect(out).toContain("twin-roster:active-members");
  }, 60_000);
});
