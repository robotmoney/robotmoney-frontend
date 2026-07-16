// Issue #176 (Admin surface integration scout) compatibility tests for the
// `/api/admin/*` registrar-composition seam: `handleAdmin` now tries an
// ordered list of per-domain registrars (backend/src/admin/*.ts) instead of
// one growing function. This suite proves the composition itself is sound —
// the still-unimplemented stub registrars (#152 committee, #155 operations)
// stay pure no-ops (auth never runs, no route claimed), and the already-real
// registrars (queue, and research — issue #151 landed in PR #168 mid-scout
// and was folded into this seam as its baseline, per the issue #176 worker
// instructions) keep their exact routing/auth-first behavior through the
// composer — so #152/#155 can each fill in their own registrar file without
// re-verifying the dispatcher shape.
import { afterAll, expect, test } from "bun:test";
import { sql } from "../../src/db/client.ts";
import { handleAdmin } from "../../src/api/routes/admin.ts";
import { registerCommitteeAdminRoutes } from "../../src/admin/committee-routes.ts";
import { registerOperationsAdminRoutes } from "../../src/admin/operations-routes.ts";

const PROD = { adminToken: "s3cret-admin-token", allowInsecure: false } as const;
const INSECURE = { adminToken: null, allowInsecure: true } as const;

const KIND = `az_reg_${crypto.randomUUID().slice(0, 8)}`;

function req(method: string, path: string, token?: string): Request {
  const headers: Record<string, string> = {};
  if (token !== undefined) headers["X-Admin-Token"] = token;
  return new Request(`http://x${path}`, { method, headers });
}

afterAll(async () => {
  await sql`DELETE FROM job_runs WHERE kind = ${KIND}`;
  await sql`DELETE FROM jobs WHERE kind = ${KIND}`;
});

// ── Still-stub registrars are pure no-ops ───────────────────────────────────
// A stub must never claim a route (always null) and must never even look at
// the auth header — proving the "no runtime behavior change" property of a
// dev-scout seam independent of whatever paths #152/#155 eventually own.
test("committee/operations stub registrars own no routes and never gate on auth", async () => {
  const candidatePaths = [
    "/api/admin/committee/sessions",
    "/api/admin/committee/sessions/abc/actions/publish",
    "/api/admin/overview",
    "/api/admin/audit",
    "/api/admin/schedules/1",
  ];
  for (const p of candidatePaths) {
    for (const m of ["GET", "POST", "PATCH"]) {
      // No token at all — if a stub incorrectly claimed the route AND checked
      // auth, this would come back 403 instead of null; if it claimed the
      // route without checking auth (worse), it would come back something
      // other than null too. Either way this assertion catches it.
      expect(await registerCommitteeAdminRoutes(req(m, p), new URL(`http://x${p}`), PROD)).toBeNull();
      expect(await registerOperationsAdminRoutes(req(m, p), new URL(`http://x${p}`), PROD)).toBeNull();
    }
  }
});

// ── Composition preserves the pre-existing queue AND landed research surfaces ──
test("handleAdmin composes registrars: queue + research routes still resolve, auth still fails closed, unknown paths still fall through", async () => {
  // Fail-closed: wrong/missing token still 403s through the composed chain,
  // for a route only the (real) queue registrar owns.
  expect((await handleAdmin(req("GET", "/api/admin/jobs"), new URL("http://x/api/admin/jobs"), PROD))?.status).toBe(403);
  expect(
    (await handleAdmin(req("GET", "/api/admin/jobs", "nope"), new URL("http://x/api/admin/jobs"), PROD))?.status,
  ).toBe(403);

  // Correct token still reaches the queue registrar's real behavior.
  const [job] = await sql`
    INSERT INTO jobs ${sql({ kind: KIND, status: "succeeded", attempts: 1, last_error: null })}
    RETURNING id`;
  const res = await handleAdmin(
    req("GET", "/api/admin/jobs", PROD.adminToken),
    new URL("http://x/api/admin/jobs"),
    PROD,
  );
  expect(res?.status).toBe(200);
  const body = res?.body as { jobs: { id: number; kind: string }[] };
  expect(body.jobs.some((j) => Number(j.id) === Number(job.id) && j.kind === KIND)).toBe(true);

  // Fail-closed also holds for the research registrar (issue #151), now
  // composed alongside the queue registrar rather than living in the same
  // function — a route it owns still 403s without the right token.
  expect(
    (await handleAdmin(req("GET", "/api/admin/research/runs"), new URL("http://x/api/admin/research/runs"), PROD))
      ?.status,
  ).toBe(403);
  expect(
    (
      await handleAdmin(
        req("GET", "/api/admin/research/runs", PROD.adminToken),
        new URL("http://x/api/admin/research/runs"),
        PROD,
      )
    )?.status,
  ).toBe(200);

  // A path no registrar owns (yet) still falls through to null → index.ts's 404,
  // even with the extra stub registrars chained after the real ones.
  expect(await handleAdmin(req("GET", "/api/admin/nope"), new URL("http://x/api/admin/nope"), INSECURE)).toBeNull();
  expect(
    await handleAdmin(
      req("POST", "/api/admin/committee/sessions/x/actions/publish"),
      new URL("http://x/api/admin/committee/sessions/x/actions/publish"),
      INSECURE,
    ),
  ).toBeNull();
  expect(
    await handleAdmin(req("GET", "/api/admin/overview"), new URL("http://x/api/admin/overview"), INSECURE),
  ).toBeNull();
});
