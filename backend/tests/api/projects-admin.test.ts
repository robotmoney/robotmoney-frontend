// Admin-managed project overviews (issue #93). Runs against the ephemeral
// Postgres the preload provisions (real DB, never mocked) — if Postgres is
// absent the preload THROWS, so this suite fails red rather than skipping.
// Asserts: a valid X-Admin-Token write updates overview_short + overview_long
// and the change is reflected by GET /api/projects; a prod-mode config with
// no/invalid token returns 403; there is NO AI/LLM call anywhere on the path.
import { test, expect } from "bun:test";
import { sql } from "../../src/db/client.ts";
import { getProjects, updateProjectOverview } from "../../src/api/routes/projects.ts";

const rid = (p: string) => `${p}_${crypto.randomUUID().slice(0, 8)}`;

// Prod-mode auth: a token is configured and the insecure convenience path is off,
// so a request WITHOUT the matching X-Admin-Token must be rejected (fail-closed).
const PROD = { adminToken: "s3cret-admin-token", allowInsecure: false } as const;

async function insertProject(slug: string): Promise<string> {
  const [r] = await sql`
    INSERT INTO projects ${sql({ slug, display_name: "Overview Co", status: "active", data_coverage_score: 80, is_sticky: false })}
    RETURNING id`;
  return r.id as string;
}

function adminReq(slug: string, body: unknown, token?: string): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token !== undefined) headers["X-Admin-Token"] = token;
  return new Request(`http://x/api/projects/admin/${encodeURIComponent(slug)}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

test("a valid X-Admin-Token write updates overview_short + overview_long; GET /api/projects reflects it", async () => {
  const slug = rid("admin-ovr");
  const id = await insertProject(slug);

  const res = await updateProjectOverview(
    adminReq(slug, { overview_short: "Curated short blurb", overview_long: "A much longer admin-authored overview." }, PROD.adminToken),
    slug,
    PROD,
  );
  expect(res.status).toBe(200);
  const project = (res.body as { project: Record<string, unknown> }).project;
  expect(project.overview_short).toBe("Curated short blurb");
  expect(project.overview_long).toBe("A much longer admin-authored overview.");

  // Both columns actually landed in the DB.
  const [row] = await sql<{ overview_short: string; overview_long: string }[]>`
    SELECT overview_short, overview_long FROM projects WHERE id = ${id}`;
  expect(row.overview_short).toBe("Curated short blurb");
  expect(row.overview_long).toBe("A much longer admin-authored overview.");

  // GET /api/projects surfaces the new text (description falls back to overview_short).
  const { projects } = await getProjects();
  const p = projects.find((x) => x.slug === slug);
  expect(p).toBeDefined();
  expect(p!.description).toBe("Curated short blurb");
});

test("a partial write leaves omitted overview fields untouched", async () => {
  const slug = rid("admin-partial");
  const id = await insertProject(slug);

  await updateProjectOverview(adminReq(slug, { overview_short: "first short", overview_long: "first long" }, PROD.adminToken), slug, PROD);
  const res = await updateProjectOverview(adminReq(slug, { overview_short: "updated short" }, PROD.adminToken), slug, PROD);
  expect(res.status).toBe(200);

  const [row] = await sql<{ overview_short: string; overview_long: string }[]>`
    SELECT overview_short, overview_long FROM projects WHERE id = ${id}`;
  expect(row.overview_short).toBe("updated short"); // changed
  expect(row.overview_long).toBe("first long"); // untouched
});

test("prod-mode config rejects a write with a missing or invalid admin token (403)", async () => {
  const slug = rid("admin-403");
  const id = await insertProject(slug);
  const body = { overview_short: "should not persist" };

  const noToken = await updateProjectOverview(adminReq(slug, body), slug, PROD);
  expect(noToken.status).toBe(403);

  const wrongToken = await updateProjectOverview(adminReq(slug, body, "wrong-token"), slug, PROD);
  expect(wrongToken.status).toBe(403);

  // Nothing was written under a rejected request.
  const [row] = await sql<{ overview_short: string | null }[]>`SELECT overview_short FROM projects WHERE id = ${id}`;
  expect(row.overview_short).toBeNull();
});

test("returns 404 for an unknown slug and 400 when no overview fields are supplied", async () => {
  const slug = rid("admin-shape");
  await insertProject(slug);

  const unknown = rid("nope");
  const missing = await updateProjectOverview(adminReq(unknown, { overview_short: "x" }, PROD.adminToken), unknown, PROD);
  expect(missing.status).toBe(404);

  const empty = await updateProjectOverview(adminReq(slug, {}, PROD.adminToken), slug, PROD);
  expect(empty.status).toBe(400);
});
